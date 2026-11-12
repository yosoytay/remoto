// visor.js — muestra la pantalla de la otra PC y le manda lo que se hace acá con el dedo, el mouse o el teclado.
// Lo usa app.js: le pasa lo que llega por el canal directo y una función para mandar.
const SIN_VIDEO = 'Este navegador no puede mostrar el video de la otra PC. Probá con Chrome al día.';

export function crearVisor({ lienzo, escena, campo, enviar, alCambiar, alAviso, alArchivo, antesDePegar }) {
  const ctx = lienzo.getContext('2d', { alpha: false, desynchronized: true });
  let decodificador = null;
  let esperaCuadroCompleto = true;
  let hayVideo = false;
  let conEntrada = false;
  let fallasDeVideo = 0;
  let partes = [];
  let relojes = [];
  const cuenta = { cuadros: 0, bytes: 0 };
  let medidas = { cuadros: 0, kbit: 0, idaYVuelta: null };

  // ---------- Video ----------
  function cerrarDecodificador() {
    if (decodificador && decodificador.state !== 'closed') { try { decodificador.close(); } catch {} }
    decodificador = null;
  }

  function prepararDecodificador(configuracion) {
    cerrarDecodificador();
    // Los bytes 1 a 3 de la configuración dicen el perfil y el nivel de H.264: con eso se arma el nombre del códec.
    const perfil = Array.from(configuracion.subarray(1, 4), (b) => b.toString(16).padStart(2, '0')).join('');
    decodificador = new VideoDecoder({
      output: pintar,
      error: () => {
        // Si falla varias veces sin haber mostrado nada, este navegador no puede con el video: se avisa y no se insiste.
        if (!hayVideo && ++fallasDeVideo >= 3) { alAviso(SIN_VIDEO); return; }
        esperaCuadroCompleto = true;
        enviar({ t: 'video', accion: 'reiniciar' });
      },
    });
    decodificador.configure({ codec: `avc1.${perfil}`, description: configuracion.slice(), optimizeForLatency: true });
    esperaCuadroCompleto = true;
  }

  function pintar(cuadro) {
    if (lienzo.width !== cuadro.displayWidth || lienzo.height !== cuadro.displayHeight) {
      lienzo.width = cuadro.displayWidth;
      lienzo.height = cuadro.displayHeight;
      acomodar();
    }
    ctx.drawImage(cuadro, 0, 0);
    cuadro.close();
    cuenta.cuadros++;
    if (!hayVideo) {
      hayVideo = true;
      fallasDeVideo = 0;
      lienzo.hidden = false;
      alAviso('');
      alCambiar();
      enviar({ t: 'viendo', ancho: lienzo.width, alto: lienzo.height });   // queda anotado que la pantalla llegó
    }
  }

  // Lo que llega en binario son trozos de un cuadro: adelante, un 1 si sigue otro trozo y un 0 si es el último.
  // El cuadro armado trae 1 byte de clase (1 configuración, 2 cuadro completo, 3 cuadro de cambios), 4 de marca de
  // tiempo en milisegundos y después los datos de H.264. La clase 4 es un trozo de un archivo que se está bajando.
  function alBinario(datos) {
    const trozo = new Uint8Array(datos);
    if (trozo.length < 2) return;
    cuenta.bytes += trozo.length;
    partes.push(trozo.subarray(1));
    if (trozo[0] === 1) return;
    let cuadro = partes[0];
    if (partes.length > 1) {
      cuadro = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
      let pos = 0;
      for (const p of partes) { cuadro.set(p, pos); pos += p.length; }
    }
    partes = [];
    if (cuadro.length < 6) return;
    const clase = cuadro[0];
    const carga = cuadro.subarray(5);
    if (clase === 4) { alArchivo(carga); return; }
    if (clase === 1) { prepararDecodificador(carga); return; }
    if (!decodificador || decodificador.state !== 'configured') return;
    if (esperaCuadroCompleto && clase !== 2) return;
    esperaCuadroCompleto = false;
    const marca = new DataView(cuadro.buffer, cuadro.byteOffset + 1, 4).getUint32(0);
    decodificador.decode(new EncodedVideoChunk({ type: clase === 2 ? 'key' : 'delta', timestamp: marca * 1000, data: carga }));
  }

  const esperanPong = new Map();
  function alTexto(m) {
    if (m.t === 'estado') { conEntrada = !!m.entrada; alCambiar(); }
    else if (m.t === 'pong') {
      const espera = esperanPong.get(m.id);
      if (espera) { esperanPong.delete(m.id); medidas.idaYVuelta = Math.round(performance.now() - espera); }
    }
  }

  // ---------- Dónde cae cada toque ----------
  function posicion(x, y) {
    const r = lienzo.getBoundingClientRect();
    const acotar = (v) => +Math.min(1, Math.max(0, v)).toFixed(5);
    return { x: acotar((x - r.left) / r.width), y: acotar((y - r.top) / r.height) };
  }

  // Los movimientos se juntan: como mucho uno cada 16 milisegundos. Antes de un clic se manda la posición exacta.
  let ultimoMovimiento = 0;
  let movimientoPendiente = null;
  let relojDeMovimiento = 0;

  function despacharMovimiento() {
    clearTimeout(relojDeMovimiento);
    relojDeMovimiento = 0;
    if (!movimientoPendiente) return;
    enviar({ t: 'm', x: movimientoPendiente.x, y: movimientoPendiente.y });
    movimientoPendiente = null;
    ultimoMovimiento = performance.now();
  }

  function mover(punto, ya) {
    movimientoPendiente = punto;
    const falta = 16 - (performance.now() - ultimoMovimiento);
    if (ya || falta <= 0) despacharMovimiento();
    else if (!relojDeMovimiento) relojDeMovimiento = setTimeout(despacharMovimiento, falta);
  }

  // ---------- Acercar y correr la vista (solo acá: la otra PC no se entera) ----------
  let zoom = 1;
  let corrX = 0;
  let corrY = 0;

  function acomodar() {
    if (zoom <= 1.001) {
      zoom = 1; corrX = 0; corrY = 0;
      lienzo.style.transform = '';
      return;
    }
    const e = escena.getBoundingClientRect();
    const ancho = lienzo.offsetWidth * zoom;
    const alto = lienzo.offsetHeight * zoom;
    const baseX = e.left + (e.width - lienzo.offsetWidth) / 2;    // dónde queda el lienzo sin acercar: centrado
    const baseY = e.top + (e.height - lienzo.offsetHeight) / 2;
    const izquierda = ancho > e.width ? Math.min(e.left, Math.max(e.right - ancho, baseX + corrX)) : e.left + (e.width - ancho) / 2;
    const arriba = alto > e.height ? Math.min(e.top, Math.max(e.bottom - alto, baseY + corrY)) : e.top + (e.height - alto) / 2;
    corrX = izquierda - baseX;
    corrY = arriba - baseY;
    lienzo.style.transform = `translate(${corrX}px, ${corrY}px) scale(${zoom})`;
  }

  // Cambia el acercamiento dejando quieto el punto que está bajo los dedos.
  function acercar(x, y, nuevo) {
    const r = lienzo.getBoundingClientRect();
    const u = (x - r.left) / zoom;
    const v = (y - r.top) / zoom;
    const baseX = r.left - corrX;
    const baseY = r.top - corrY;
    zoom = Math.min(5, Math.max(1, nuevo));
    corrX = x - u * zoom - baseX;
    corrY = y - v * zoom - baseY;
    acomodar();
  }

  function correr(dx, dy) {
    if (zoom <= 1.001) return;
    corrX += dx;
    corrY += dy;
    acomodar();
  }

  window.addEventListener('resize', acomodar);

  // ---------- El dedo ----------
  // Un toque: clic. Dos toques seguidos: doble clic. Toque largo: clic derecho. Arrastrar un dedo: arrastrar.
  // Dos dedos: separarlos acerca la vista; moverlos juntos gira la rueda (o corre la vista, si está acercada).
  const dedos = new Map();
  let gesto = null;
  let relojDeToqueLargo = 0;
  let ultimoToque = null;
  let ultimoDedo = -10000;

  function alTocar(ev) {
    ev.preventDefault();
    ultimoDedo = performance.now();
    try { lienzo.setPointerCapture(ev.pointerId); } catch {}
    dedos.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    clearTimeout(relojDeToqueLargo);
    if (dedos.size === 1) {
      const g = { tipo: 'uno', x0: ev.clientX, y0: ev.clientY, movido: false, arrastrando: false, largo: false };
      gesto = g;
      relojDeToqueLargo = setTimeout(() => {
        if (gesto !== g || g.movido) return;
        g.largo = true;
        mover(posicion(g.x0, g.y0), true);
        enviar({ t: 'b', n: 2, d: 1 });
        enviar({ t: 'b', n: 2, d: 0 });
        if (navigator.vibrate) navigator.vibrate(15);
      }, 550);
    } else if (dedos.size === 2) {
      if (gesto && gesto.tipo === 'uno' && gesto.arrastrando) enviar({ t: 'b', n: 0, d: 0 });
      const [a, b] = [...dedos.values()];
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      gesto = { tipo: 'dos', modo: null, dist0: Math.hypot(a.x - b.x, a.y - b.y), zoom0: zoom, cx0: cx, cy0: cy, cx, cy, resto: { x: 0, y: 0 } };
    } else {
      gesto = { tipo: 'fin' };
    }
  }

  function alMoverElDedo(ev) {
    const dedo = dedos.get(ev.pointerId);
    if (!dedo || !gesto) return;
    ev.preventDefault();
    ultimoDedo = performance.now();
    dedo.x = ev.clientX;
    dedo.y = ev.clientY;
    if (gesto.tipo === 'uno') {
      if (!gesto.movido) {
        if (Math.hypot(ev.clientX - gesto.x0, ev.clientY - gesto.y0) < 10) return;
        gesto.movido = true;
        clearTimeout(relojDeToqueLargo);
        if (!gesto.largo) {
          // Arrastrar: el botón izquierdo queda apretado mientras el dedo se mueve.
          gesto.arrastrando = true;
          mover(posicion(gesto.x0, gesto.y0), true);
          enviar({ t: 'b', n: 0, d: 1 });
        }
      }
      if (gesto.arrastrando) mover(posicion(ev.clientX, ev.clientY), false);
      return;
    }
    if (gesto.tipo !== 'dos' || dedos.size !== 2) return;
    const [a, b] = [...dedos.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    if (!gesto.modo) {
      if (Math.abs(dist - gesto.dist0) > 28) gesto.modo = 'acercar';
      else if (Math.hypot(cx - gesto.cx0, cy - gesto.cy0) > 12) {
        gesto.modo = zoom > 1.02 ? 'correr' : 'rueda';
        if (gesto.modo === 'rueda') mover(posicion(gesto.cx0, gesto.cy0), true);   // la rueda actúa donde están los dedos
      } else return;
    }
    const dx = cx - gesto.cx;
    const dy = cy - gesto.cy;
    gesto.cx = cx;
    gesto.cy = cy;
    if (gesto.modo === 'acercar') {
      acercar(cx, cy, gesto.zoom0 * dist / gesto.dist0);
      correr(dx, dy);
    } else if (gesto.modo === 'correr') {
      correr(dx, dy);
    } else {
      // Tres centímetros de dedo, más o menos, son un paso de rueda. El contenido sigue al dedo.
      gesto.resto.y += dy * 4;
      gesto.resto.x -= dx * 4;
      const pasosY = Math.trunc(gesto.resto.y / 120) * 120;
      const pasosX = Math.trunc(gesto.resto.x / 120) * 120;
      if (pasosY || pasosX) {
        gesto.resto.y -= pasosY;
        gesto.resto.x -= pasosX;
        enviar({ t: 'r', dy: pasosY, dx: pasosX });
      }
    }
  }

  function alLevantar(ev) {
    if (!dedos.has(ev.pointerId)) return;
    ev.preventDefault();
    ultimoDedo = performance.now();
    dedos.delete(ev.pointerId);
    clearTimeout(relojDeToqueLargo);
    const g = gesto;
    if (g && g.tipo === 'uno') {
      if (g.arrastrando) {
        mover(posicion(ev.clientX, ev.clientY), true);
        enviar({ t: 'b', n: 0, d: 0 });
      } else if (!g.largo && !g.movido && ev.type === 'pointerup') {
        // El segundo toque de un doble toque va al punto exacto del primero: Windows pide que coincidan.
        const ahora = performance.now();
        const repetido = ultimoToque && ahora - ultimoToque.t < 400 && Math.hypot(g.x0 - ultimoToque.x, g.y0 - ultimoToque.y) < 32;
        const punto = repetido ? ultimoToque : { x: g.x0, y: g.y0 };
        ultimoToque = { x: punto.x, y: punto.y, t: ahora };
        mover(posicion(punto.x, punto.y), true);
        enviar({ t: 'b', n: 0, d: 1 });
        enviar({ t: 'b', n: 0, d: 0 });
        soltarFijos();
      }
    }
    gesto = dedos.size ? { tipo: 'fin' } : null;
  }

  lienzo.addEventListener('pointerdown', (ev) => { if (ev.pointerType === 'touch') alTocar(ev); });
  lienzo.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'touch') alMoverElDedo(ev); });
  lienzo.addEventListener('pointerup', (ev) => { if (ev.pointerType === 'touch') alLevantar(ev); });
  lienzo.addEventListener('pointercancel', (ev) => { if (ev.pointerType === 'touch') alLevantar(ev); });

  // ---------- El mouse ----------
  const apretados = new Set();
  const esDelDedo = () => performance.now() - ultimoDedo < 800;   // el navegador repite los toques como si fueran del mouse

  lienzo.addEventListener('mousedown', (ev) => {
    if (esDelDedo()) return;
    ev.preventDefault();
    lienzo.focus({ preventScroll: true });
    if (ev.button > 2) return;
    igualarModificadores(ev);
    mover(posicion(ev.clientX, ev.clientY), true);
    enviar({ t: 'b', n: ev.button, d: 1 });
    apretados.add(ev.button);
  });

  window.addEventListener('mouseup', (ev) => {
    if (!apretados.has(ev.button)) return;
    mover(posicion(ev.clientX, ev.clientY), true);
    enviar({ t: 'b', n: ev.button, d: 0 });
    apretados.delete(ev.button);
    soltarFijos();
  });

  window.addEventListener('mousemove', (ev) => {
    if (esDelDedo() || (ev.target !== lienzo && !apretados.size)) return;
    igualarModificadores(ev, true);
    mover(posicion(ev.clientX, ev.clientY), false);
  });

  lienzo.addEventListener('contextmenu', (ev) => ev.preventDefault());

  const restoDeRueda = { x: 0, y: 0 };
  lienzo.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const divisor = ev.deltaMode === 1 ? 3 : ev.deltaMode === 2 ? 1 : 100;   // líneas, páginas o píxeles por paso
    restoDeRueda.y += (-ev.deltaY / divisor) * 120;
    restoDeRueda.x += (ev.deltaX / divisor) * 120;
    const dy = Math.trunc(restoDeRueda.y);
    const dx = Math.trunc(restoDeRueda.x);
    if (!dy && !dx) return;
    restoDeRueda.y -= dy;
    restoDeRueda.x -= dx;
    igualarModificadores(ev);
    mover(posicion(ev.clientX, ev.clientY), true);
    enviar({ t: 'r', dy, dx });
  }, { passive: false });

  // ---------- El teclado ----------
  // Código físico de la tecla -> [código virtual de Windows, 1 si es tecla extendida].
  const TECLAS = {
    Backspace: [0x08, 0], Tab: [0x09, 0], Enter: [0x0d, 0], NumpadEnter: [0x0d, 1], Pause: [0x13, 0], Escape: [0x1b, 0], Space: [0x20, 0],
    PageUp: [0x21, 1], PageDown: [0x22, 1], End: [0x23, 1], Home: [0x24, 1],
    ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1],
    PrintScreen: [0x2c, 1], Insert: [0x2d, 1], Delete: [0x2e, 1],
    MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
    NumpadMultiply: [0x6a, 0], NumpadAdd: [0x6b, 0], NumpadSubtract: [0x6d, 0], NumpadDecimal: [0x6e, 0], NumpadDivide: [0x6f, 1],
    NumLock: [0x90, 1], ScrollLock: [0x91, 0],
    ShiftLeft: [0xa0, 0], ShiftRight: [0xa1, 0], ControlLeft: [0xa2, 0], ControlRight: [0xa3, 1], AltLeft: [0xa4, 0], AltRight: [0xa5, 1],
    Semicolon: [0xba, 0], Equal: [0xbb, 0], Comma: [0xbc, 0], Minus: [0xbd, 0], Period: [0xbe, 0], Slash: [0xbf, 0], Backquote: [0xc0, 0],
    BracketLeft: [0xdb, 0], Backslash: [0xdc, 0], BracketRight: [0xdd, 0], Quote: [0xde, 0], IntlBackslash: [0xe2, 0],
  };
  for (let i = 0; i < 26; i++) TECLAS[`Key${String.fromCharCode(65 + i)}`] = [0x41 + i, 0];
  for (let i = 0; i < 10; i++) { TECLAS[`Digit${i}`] = [0x30 + i, 0]; TECLAS[`Numpad${i}`] = [0x60 + i, 0]; }
  for (let i = 1; i <= 12; i++) TECLAS[`F${i}`] = [0x6f + i, 0];

  const bajadas = new Set();

  function bajarTecla(codigo) {
    const tecla = TECLAS[codigo];
    if (!tecla) return;
    bajadas.add(codigo);
    enviar({ t: 'k', vk: tecla[0], d: 1, e: tecla[1] });
  }

  function subirTecla(codigo) {
    if (!bajadas.delete(codigo)) return;
    const tecla = TECLAS[codigo];
    enviar({ t: 'k', vk: tecla[0], d: 0, e: tecla[1] });
  }

  function tocarTecla(codigo) {
    const tecla = TECLAS[codigo];
    if (!tecla) return;
    enviar({ t: 'k', vk: tecla[0], d: 1, e: tecla[1] });
    enviar({ t: 'k', vk: tecla[0], d: 0, e: tecla[1] });
  }

  // Ctrl, Mayús, Alt y Windows: lo que está apretado allá tiene que coincidir con lo que está apretado acá.
  const MODIFICADORES = [
    ['ctrlKey', 'ControlLeft', 'ControlRight'], ['shiftKey', 'ShiftLeft', 'ShiftRight'],
    ['altKey', 'AltLeft', 'AltRight'], ['metaKey', 'MetaLeft', 'MetaRight'],
  ];
  const esModificador = new Set(MODIFICADORES.flatMap(([, izquierda, derecha]) => [izquierda, derecha]));

  function igualarModificadores(ev, soloSoltar = false) {
    const altGr = ev.getModifierState('AltGraph');   // AltGr se ve como Ctrl + Alt: no cuenta como ninguno de los dos
    for (const [bandera, izquierda, derecha] of MODIFICADORES) {
      const aca = (ev[bandera] && !(altGr && (bandera === 'ctrlKey' || bandera === 'altKey'))) || fijos.has(izquierda);
      const alla = bajadas.has(izquierda) || bajadas.has(derecha);
      if (aca && !alla && !soloSoltar) bajarTecla(izquierda);
      else if (!aca && alla) { subirTecla(izquierda); subirTecla(derecha); }
    }
  }

  // ---------- Atajos ----------
  // Ctrl y Shift se pueden dejar «fijados» desde la tira: quedan apretados allá hasta la próxima tecla o el próximo
  // clic, y ahí se sueltan solos. Sirve en el celular, que no tiene esas teclas.
  const fijos = new Set();
  function soltarFijos() {
    if (!fijos.size) return;
    for (const codigo of fijos) subirTecla(codigo);
    fijos.clear();
    alCambiar();
  }
  function fijar(codigos) {
    const eranLosMismos = codigos.length === fijos.size && codigos.every((c) => fijos.has(c));
    for (const codigo of fijos) subirTecla(codigo);
    fijos.clear();
    if (!eranLosMismos) for (const codigo of codigos) { fijos.add(codigo); bajarTecla(codigo); }
    alCambiar();
  }
  // Una combinación entera: baja las teclas en orden y las sube al revés.
  function combinar(codigos) {
    soltarFijos();
    for (const codigo of codigos) { const tecla = TECLAS[codigo]; enviar({ t: 'k', vk: tecla[0], d: 1, e: tecla[1] }); }
    for (const codigo of [...codigos].reverse()) { const tecla = TECLAS[codigo]; enviar({ t: 'k', vk: tecla[0], d: 0, e: tecla[1] }); }
  }
  const ATAJOS = {
    tab: ['Tab'], esc: ['Escape'], alttab: ['AltLeft', 'Tab'], escritorio: ['MetaLeft', 'KeyD'], tareas: ['ControlLeft', 'ShiftLeft', 'Escape'],
  };
  function atajo(nombre) {
    const codigos = ATAJOS[nombre];
    if (!codigos) return;
    // Tab y Esc solas respetan lo fijado (Ctrl+Tab, Shift+Tab); las combinaciones van limpias.
    if (codigos.length === 1) { tocarTecla(codigos[0]); soltarFijos(); } else combinar(codigos);
  }
  // Con algo fijado, una letra del teclado en pantalla viaja como tecla y no como carácter: así Ctrl+C es Ctrl+C.
  function teclaDe(letra) {
    if (/^[a-z]$/i.test(letra)) return `Key${letra.toUpperCase()}`;
    if (/^[0-9]$/.test(letra)) return `Digit${letra}`;
    return letra === ' ' ? 'Space' : null;
  }

  // Una letra o un signo viaja como carácter: llega igual aunque la otra PC tenga otra distribución de teclado.
  // Lo demás (Enter, flechas, atajos con Ctrl o Alt) viaja como tecla.
  function esTexto(ev) {
    if ([...ev.key].length !== 1 || ev.code === 'Space') return false;
    if (ev.getModifierState('AltGraph')) return true;
    return !(ev.ctrlKey || ev.altKey || ev.metaKey);
  }

  // Pegar: primero viaja lo copiado en este equipo y después el Ctrl+V, así allá se pega lo de acá.
  // Si mientras tanto se soltó el Ctrl, se lo aprieta y se lo suelta para que no salga una «v» suelta.
  let pegando = false;
  async function pegarAlla() {
    if (pegando) return;
    pegando = true;
    try { await antesDePegar(); } catch {} finally { pegando = false; }
    const conCtrl = bajadas.has('ControlLeft') || bajadas.has('ControlRight');
    if (!conCtrl) enviar({ t: 'k', vk: 0xa2, d: 1, e: 0 });
    tocarTecla('KeyV');
    if (!conCtrl) enviar({ t: 'k', vk: 0xa2, d: 0, e: 0 });
  }

  lienzo.addEventListener('keydown', (ev) => {
    ev.preventDefault();
    if (ev.isComposing || ev.key === 'Dead' || ev.key === 'Process' || ev.key === 'Unidentified') return;
    if (ev.code === 'KeyV' && ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) {
      if (!ev.repeat) { igualarModificadores(ev); pegarAlla(); }
      return;
    }
    if (ev.key === 'AltGraph') { subirTecla('ControlLeft'); return; }
    if (esModificador.has(ev.code)) { bajarTecla(ev.code); return; }
    igualarModificadores(ev);
    if (esTexto(ev) && !fijos.size) enviar({ t: 'u', c: ev.key });
    else bajarTecla(ev.code);
  });

  lienzo.addEventListener('keyup', (ev) => {
    ev.preventDefault();
    subirTecla(ev.code);
    if (!esModificador.has(ev.code)) { soltarFijos(); igualarModificadores(ev, true); }
  });

  // Si la pantalla pierde el foco con una tecla apretada, se suelta todo allá: nada queda trabado.
  function soltarTodo() {
    if (bajadas.size || apretados.size) enviar({ t: 'soltar' });
    bajadas.clear();
    apretados.clear();
    if (fijos.size) { fijos.clear(); alCambiar(); }
  }
  lienzo.addEventListener('blur', () => { soltarTodo(); alCambiar(); });
  lienzo.addEventListener('focus', alCambiar);
  window.addEventListener('blur', soltarTodo);

  // ---------- El teclado en pantalla del celular ----------
  // Un campo que no se ve hace aparecer el teclado. Se mira qué cambió en el campo y eso se manda: letras nuevas
  // como texto, y lo que se borró como Retroceso. Así sirve también con el corrector y con el deslizado.
  const CENTINELA = '​';   // un carácter invisible, para que Retroceso tenga algo que borrar
  let previo = CENTINELA;

  function reiniciarCampo() {
    campo.value = CENTINELA;
    previo = CENTINELA;
    try { campo.setSelectionRange(1, 1); } catch {}
  }

  function mandarTexto(texto) {
    const lineas = texto.split('\n');
    lineas.forEach((linea, i) => {
      if (i) tocarTecla('Enter');
      for (let pos = 0; pos < linea.length; pos += 60) enviar({ t: 'u', c: linea.slice(pos, pos + 60) });
    });
  }

  campo.addEventListener('input', (ev) => {
    const valor = campo.value;
    let comun = 0;
    while (comun < previo.length && comun < valor.length && previo[comun] === valor[comun]) comun++;
    for (let i = [...previo.slice(comun)].length; i > 0; i--) tocarTecla('Backspace');
    const nuevo = valor.slice(comun);
    const comoTecla = fijos.size && [...nuevo].length === 1 ? teclaDe(nuevo) : null;
    if (comoTecla) { tocarTecla(comoTecla); soltarFijos(); } else mandarTexto(nuevo);
    previo = valor;
    if (!ev.isComposing) reiniciarCampo();
  });
  campo.addEventListener('compositionend', () => setTimeout(reiniciarCampo, 0));

  // Las teclas que no escriben nada (flechas, Tab, Escape…) van como tecla, si el teclado las tiene.
  const SIN_TEXTO = new Set(['Tab', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Delete',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
  campo.addEventListener('keydown', (ev) => {
    if (!SIN_TEXTO.has(ev.code) || ev.isComposing) return;
    ev.preventDefault();
    tocarTecla(ev.code);
    soltarFijos();
  });

  function abrirTeclado() {
    reiniciarCampo();
    campo.blur();
    campo.focus({ preventScroll: true });
  }

  // ---------- Empezar y terminar una sesión ----------
  function empezar() {
    terminar();
    hayVideo = false;
    conEntrada = false;
    fallasDeVideo = 0;
    partes = [];
    medidas = { cuadros: 0, kbit: 0, idaYVuelta: null };
    lienzo.hidden = true;
    zoom = 1;
    acomodar();
    let numeroDePing = 0;
    relojes = [
      setInterval(() => {
        medidas = { ...medidas, cuadros: cuenta.cuadros, kbit: Math.round(cuenta.bytes * 8 / 1000) };
        cuenta.cuadros = 0;
        cuenta.bytes = 0;
        alCambiar();
      }, 1000),
      // Ida y vuelta: cuánto tarda un mensaje chico en llegar al agente y volver.
      setInterval(() => {
        if (!hayVideo) return;
        const id = ++numeroDePing;
        esperanPong.clear();
        esperanPong.set(id, performance.now());
        enviar({ t: 'ping', id });
      }, 2000),
    ];
  }

  function terminar() {
    relojes.forEach(clearInterval);
    relojes = [];
    clearTimeout(relojDeToqueLargo);
    cerrarDecodificador();
    bajadas.clear();
    apretados.clear();
    fijos.clear();
    dedos.clear();
    gesto = null;
    hayVideo = false;
    lienzo.hidden = true;
  }

  return {
    alBinario, alTexto, empezar, terminar, soltarTodo, abrirTeclado, pegarAlla, atajo, fijar,
    estado: () => ({ hayVideo, conEntrada, conFoco: document.activeElement === lienzo, fijos: [...fijos], zoom, ancho: lienzo.width, alto: lienzo.height, ...medidas }),
  };
}
