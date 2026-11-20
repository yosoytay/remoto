// app.js — la página de entrada: empareja este equipo con la casa, deja elegir la PC, pide el PIN y abre el camino
// directo (una conexión de equipo a equipo, cifrada de punta a punta). No guarda claves a la vista: la llave del
// equipo queda en el navegador de forma que ni esta misma página puede copiarla, y el PIN no se guarda nunca.
import * as cripto from './cripto.js';
import { pedir } from './presentador.js';
import { crearVisor } from './visor.js';

const SERVIDORES_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.sipgate.net:3478', 'stun:stun.nextcloud.com:3478'];
const MINUTOS_SIN_MIRAR = 5;   // pasado ese rato con la página fuera de la vista, se vuelve a pedir el PIN
const $ = (id) => document.getElementById(id);

// Esta página no se deja meter dentro de otra.
if (window.top !== window.self) { document.documentElement.textContent = ''; throw new Error('No se muestra dentro de otra página.'); }

class Aviso extends Error {
  constructor(texto, motivo = '') { super(texto); this.motivo = motivo; }
}

// ---------- Lo que queda guardado en este navegador ----------
function base() {
  return new Promise((ok, mal) => {
    const pedido = indexedDB.open('tayremotocontrol', 1);
    pedido.onupgradeneeded = () => pedido.result.createObjectStore('cosas');
    pedido.onsuccess = () => ok(pedido.result);
    pedido.onerror = () => mal(pedido.error);
  });
}

async function conLoGuardado(modo, hacer) {
  const b = await base();
  try {
    return await new Promise((ok, mal) => {
      const transaccion = b.transaction('cosas', modo);
      const pedido = hacer(transaccion.objectStore('cosas'));
      transaccion.oncomplete = () => ok(pedido.result);
      transaccion.onerror = transaccion.onabort = () => mal(transaccion.error);
    });
  } finally { b.close(); }
}
const leer = (clave) => conLoGuardado('readonly', (s) => s.get(clave));
const guardar = (clave, valor) => conLoGuardado('readwrite', (s) => s.put(valor, clave));
const borrar = (clave) => conLoGuardado('readwrite', (s) => s.delete(clave));

// ---------- Estado de la página ----------
let datos = null;          // { casa, equipo, llave, destinos }: el emparejado de este equipo
let sesion = null;         // la conexión abierta
let elegido = null;        // la PC elegida mientras se pide el PIN
let pinEnMemoria = null;   // solo mientras se usa: nunca se guarda
let relojDelPin = 0;
let ocultaDesde = 0;

function mostrar(cual) {
  for (const id of ['emparejar', 'lista', 'mirando', 'noSirve']) $(id).hidden = id !== cual;
}

function decir(elemento, texto, mal = false) {
  elemento.textContent = texto;
  if (mal) elemento.dataset.como = 'mal'; else delete elemento.dataset.como;
}

function recordarPin(pin) {
  clearTimeout(relojDelPin);
  pinEnMemoria = pin;
}

function olvidarPinEnUnRato() {
  clearTimeout(relojDelPin);
  relojDelPin = setTimeout(() => { if (!sesion) pinEnMemoria = null; }, 2 * 60000);
}

// Seis números o más, que no sean todos iguales ni una escalera. La casa comprueba lo mismo.
function pinFlojo(pin) {
  if (!/^\d{6,12}$/.test(pin)) return 'El PIN lleva 6 números o más.';
  const d = [...pin].map(Number);
  const flojo = d.every((x) => x === d[0])
    || d.every((x, i) => i === 0 || x === (d[i - 1] + 1) % 10)
    || d.every((x, i) => i === 0 || x === (d[i - 1] + 9) % 10);
  return flojo ? 'Ese PIN es muy fácil de adivinar. Elegí otro.' : '';
}

// ---------- Hablar con la casa ----------
async function pedirALaCasa(d, pedido) {
  const id = cripto.nuevoId();
  const sobre = await cripto.sellar(d.llave, { ...pedido, id, ts: Date.now() }, cripto.CONTEXTO.pedido(d.casa.id, d.equipo.id));
  const texto = await pedir(d.casa.id, JSON.stringify({ v: 1, e: d.equipo.id, c: sobre }));
  return cripto.abrir(d.llave, JSON.parse(texto).c, cripto.CONTEXTO.respuesta(d.casa.id, d.equipo.id, id));
}

function porQueNo(r) {
  switch (r.motivo) {
    case 'pin': return `El PIN no es ese. ${r.quedan === 1 ? 'Queda 1 intento' : `Quedan ${r.quedan} intentos`} antes de que este equipo quede dado de baja.`;
    case 'baja': return 'Este equipo fue dado de baja. Hay que emparejarlo de nuevo, estando en casa.';
    case 'reloj': return 'La hora de este equipo no coincide con la de casa. Corregila y probá de nuevo.';
    case 'camino': return 'La casa no pudo armar la conexión. Probá de nuevo.';
    case 'destino': return 'Esa PC ya no figura en casa.';
    case 'pin-debil': return 'Ese PIN es muy fácil de adivinar. Elegí otro.';
    default: return 'La casa no aceptó el pedido.';
  }
}

// ---------- Emparejar ----------
$('codigo').addEventListener('input', () => {
  const limpio = $('codigo').value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10);
  $('codigo').value = limpio.length > 5 ? `${limpio.slice(0, 5)}-${limpio.slice(5)}` : limpio;
});

$('formularioEmparejar').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const aviso = $('avisoEmparejar');
  const boton = ev.target.querySelector('button');
  const codigo = cripto.limpiarCodigo($('codigo').value);
  const nombre = $('nombreDelEquipo').value.trim();
  const pin = $('pinNuevo').value;
  if (!codigo) { decir(aviso, 'El código tiene diez letras y números, como lo muestra la PC.', true); return; }
  if (pinFlojo(pin)) { decir(aviso, pinFlojo(pin), true); return; }
  if (pin !== $('pinRepetido').value) { decir(aviso, 'Los dos PIN no coinciden.', true); return; }
  boton.disabled = true;
  try {
    decir(aviso, 'Buscando la casa…');
    const { sala, clave } = await cripto.delCodigo(codigo);
    const par = await cripto.nuevoPar();
    const publica = await cripto.publicaDe(par);
    const id = cripto.nuevoId();
    const sobre = await cripto.sellar(clave, { t: 'emparejar', id, ts: Date.now(), pub: cripto.aTexto64(publica), nombre }, cripto.CONTEXTO.emparejar(sala));
    let texto;
    try { texto = await pedir(sala, JSON.stringify({ v: 1, c: sobre })); } catch {
      throw new Aviso('La casa no contestó. Fijate que el código sea el que muestra la PC y que no haya vencido.');
    }
    let r;
    try { r = await cripto.abrir(clave, JSON.parse(texto).c, cripto.CONTEXTO.emparejado(sala, id)); } catch {
      throw new Aviso('La respuesta no vino de la casa. No se emparejó nada: pedí un código nuevo.');
    }
    const publicaDeLaCasa = cripto.deTexto64(r.pub);
    const llave = await cripto.llaveDelEquipo(par, publicaDeLaCasa, publica, publicaDeLaCasa);
    await cripto.abrir(llave, r.prueba, cripto.CONTEXTO.pedido(r.casa.id, r.equipo));   // comprueba que los dos tienen la misma llave
    const nuevo = { casa: r.casa, equipo: { id: r.equipo, nombre: r.nombre }, llave, destinos: [] };
    decir(aviso, 'Guardando el PIN…');
    const c = await pedirALaCasa(nuevo, { t: 'confirmar', pin });
    if (c.t !== 'listo') throw new Aviso(porQueNo(c));
    nuevo.destinos = c.destinos;
    await guardar('emparejado', nuevo);
    datos = nuevo;
    recordarPin(pin);
    olvidarPinEnUnRato();
    ev.target.reset();
    decir(aviso, '');
    irALaLista(`Listo: este equipo quedó emparejado como «${nuevo.equipo.nombre}».`);
  } catch (error) {
    decir(aviso, error instanceof Aviso ? error.message : 'No se pudo emparejar. Probá de nuevo con un código nuevo.', true);
  } finally {
    boton.disabled = false;
  }
});

// ---------- Elegir la PC ----------
// Los íconos son dibujos fijos de esta página (no vienen de ningún lado).
const DIBUJO = (trazos) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${trazos}</svg>`;
const GRUPOS = [
  { tipo: 'pc', titulo: 'Computadoras', uno: 'PC', icono: DIBUJO('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>') },
  { tipo: 'tablet', titulo: 'Tablets', uno: 'Tablet', icono: DIBUJO('<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M18.5 11v2"/>') },
  { tipo: 'camara', titulo: 'Cámaras', uno: 'Celular cámara', icono: DIBUJO('<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.2"/>') },
];
function irALaLista(texto = '', mal = false) {
  document.title = 'TayRemotoControl';
  elegido = null;
  $('formularioPin').hidden = true;
  $('saludo').textContent = `Este equipo: «${datos.equipo.nombre}».`;
  const lista = $('destinos');
  lista.textContent = '';
  // Agrupados por lo que son, cada uno con su ícono: se ve de un vistazo qué es una PC, una tablet o una cámara.
  for (const grupo of GRUPOS) {
    const suyos = datos.destinos.filter((d) => (GRUPOS.some((g) => g.tipo === d.tipo) ? d.tipo : 'pc') === grupo.tipo);
    if (!suyos.length) continue;
    const titulo = document.createElement('h2');
    titulo.className = 'grupo';
    titulo.textContent = grupo.titulo;
    const caja = document.createElement('div');
    caja.className = 'tarjetas';
    for (const destino of suyos) {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'destino';
      boton.dataset.tipo = grupo.tipo;
      const icono = document.createElement('span');
      icono.className = 'icono';
      icono.innerHTML = grupo.icono;
      const nombre = document.createElement('span');
      nombre.className = 'nombreDelDestino';
      nombre.textContent = destino.nombre;
      const clase = document.createElement('span');
      clase.className = 'claseDelDestino';
      clase.textContent = grupo.uno;
      boton.append(icono, nombre, clase);
      boton.setAttribute('aria-pressed', 'false');
      boton.addEventListener('click', () => elegir(destino, boton));
      caja.append(boton);
    }
    lista.append(titulo, caja);
  }
  mostrar('lista');
  decir($('avisoLista'), texto, mal);
}

// Al abrir la página se le pregunta a la casa qué PC hay: así un nombre cambiado en casa se ve sin tener que entrar antes.
// Si la casa no contesta, queda la lista guardada.
async function ponerLaListaAlDia() {
  const d = datos;
  let r;
  try { r = await pedirALaCasa(d, { t: 'lista' }); } catch { return; }
  if (!r || r.t !== 'lista' || !Array.isArray(r.destinos) || datos !== d) return;
  if (JSON.stringify(r.destinos) === JSON.stringify(d.destinos)) return;
  d.destinos = r.destinos;
  guardar('emparejado', d).catch(() => {});
  // Solo se vuelve a dibujar si todavía no se eligió nada: no se le cambia la pantalla a quien ya está escribiendo el PIN.
  if (!sesion && !elegido && !$('lista').hidden) irALaLista($('avisoLista').textContent);
}

function elegir(destino, boton) {
  if (sesion) return;
  for (const b of $('destinos').querySelectorAll('.destino')) b.setAttribute('aria-pressed', String(b === boton));
  elegido = destino;
  if (pinEnMemoria) { conectar(destino, pinEnMemoria); return; }
  $('paraQuien').textContent = `PIN para entrar a «${destino.nombre}»`;
  $('formularioPin').hidden = false;
  $('pin').value = '';
  $('pin').focus();
  decir($('avisoLista'), '');
}

$('formularioPin').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (elegido) conectar(elegido, $('pin').value);
});

$('quitar').addEventListener('click', async () => {
  if (!window.confirm('¿Quitar el emparejado de este equipo? Para volver a usarlo habrá que emparejarlo de nuevo, estando en casa.')) return;
  await borrar('emparejado');
  window.location.reload();
});

function ocupar(si) {
  for (const b of document.querySelectorAll('#lista button')) b.disabled = si;
}

// ---------- El camino directo ----------
function candidatosListos(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((ok) => {
    const reloj = setTimeout(ok, ms);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(reloj); ok(); } });
  });
}

// Cómo sale a internet la red de acá, mirando por dónde la ven los servidores que dicen «desde afuera te veo así».
// Si la ven por una sola puerta, el camino directo se puede abrir. Si la ven por varias, la red es «estricta».
function redDeAca(sdp) {
  const salidas = new Map();
  for (const linea of String(sdp).split('\n')) {
    const m = /^a=candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ srflx/i.exec(linea.trim());
    if (!m || m[1].includes(':')) continue;
    if (!salidas.has(m[1])) salidas.set(m[1], new Set());
    salidas.get(m[1]).add(m[2]);
  }
  if (!salidas.size) return 'cerrada';
  return [...salidas.values()].some((puertos) => puertos.size > 1) ? 'estricta' : 'normal';
}

function porLaRed(pc) {
  const red = redDeAca(pc.localDescription ? pc.localDescription.sdp : '');
  if (red === 'estricta') return 'Desde esta red no se puede abrir el camino directo: cambia de puerta según con quién habla (red «estricta»). Acá haría falta el puente.';
  if (red === 'cerrada') return 'Esta red no deja salir por el camino directo: solo permite navegar. Acá haría falta el puente.';
  return 'No se pudo abrir el camino directo, aunque esta red parece permitirlo. Probá de nuevo.';
}

async function conectar(destino, pin, reintento = 0) {
  const avisar = (texto, mal) => decir(reintento ? $('avisoMirando') : $('avisoLista'), texto, mal);
  ocupar(true);
  avisar('Buscando la casa…');
  const pc = new RTCPeerConnection({ iceServers: SERVIDORES_STUN.map((urls) => ({ urls })) });
  const canal = pc.createDataChannel('trc', { ordered: true });
  canal.binaryType = 'arraybuffer';
  const s = { pc, canal, destino, reintento, chau: null, ultimoAviso: '', saliendo: false };
  canal.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { visor.alBinario(ev.data); return; }
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'servidor') { $('nombre').textContent = m.equipo; document.title = `${m.equipo} · TayRemotoControl`; acomodarSegunElTipo(m.tipo === 'android'); }
    else if (m.t === 'aviso') { s.ultimoAviso = m.texto; if (!visor.estado().hayVideo) decir($('avisoMirando'), m.texto); }
    else if (m.t === 'chau') s.chau = m.motivo;
    else if (m.t === 'inactividad') { if (esperaInactividad) { esperaInactividad(m.ms); esperaInactividad = null; } }
    else if (m.t === 'porta') alPortapapelesDeAlla(m.c);
    else if (!alMensajeDeArchivos(m)) {
      if (m.t === 'estado') $('reunion').hidden = !m.reunion;   // solo la PC que transcribe lo ofrece
      visor.alTexto(m);
    }
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await candidatosListos(pc, 2500);
    let r;
    try { r = await pedirALaCasa(datos, { t: 'entrar', pin, destino: destino.id, sdp: pc.localDescription.sdp }); } catch {
      throw new Aviso('La casa no contesta. Puede que la PC esté apagada o sin internet, o que acá no haya señal.');
    }
    if (Array.isArray(r.destinos)) { datos.destinos = r.destinos; guardar('emparejado', datos).catch(() => {}); }
    if (r.t !== 'pasar') throw new Aviso(porQueNo(r), r.motivo);
    recordarPin(pin);
    avisar('Abriendo el camino directo…');
    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
    await new Promise((ok, mal) => {
      const plazo = setTimeout(() => mal(new Aviso(porLaRed(pc))), 20000);
      canal.onopen = () => { clearTimeout(plazo); ok(); };
      pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'failed') { clearTimeout(plazo); mal(new Aviso(porLaRed(pc))); }
      });
    });
  } catch (error) {
    try { pc.close(); } catch {}
    ocupar(false);
    const texto = error instanceof Aviso ? error.message : 'No se pudo conectar. Probá de nuevo.';
    if (error.motivo === 'pin' || error.motivo === 'baja') pinEnMemoria = null;
    if (reintento) visor.terminar();
    irALaLista(texto, true);
    if (error.motivo === 'pin') {
      // Se vuelve a pedir el PIN para la misma PC.
      elegido = destino;
      $('paraQuien').textContent = `PIN para entrar a «${destino.nombre}»`;
      $('formularioPin').hidden = false;
      $('pin').value = '';
      $('pin').focus();
    }
    return;
  }
  // Abierto: desde acá, lo que viaja va directo entre este equipo y la casa.
  ocupar(false);
  sesion = s;
  canal.onclose = () => alCerrarse(s);
  $('nombre').textContent = destino.nombre;
  decir($('avisoMirando'), 'Conectando con la PC…');
  visor.empezar();
  mostrar('mirando');
  pintarEstado();
}

function alCerrarse(s) {
  if (sesion !== s) return;
  sesion = null;
  acomodarSegunElTipo(false);
  soltarArchivos();
  portaPendiente = null;
  try { s.pc.close(); } catch {}
  olvidarPinEnUnRato();
  const terminar = (texto, mal) => { visor.terminar(); irALaLista(texto, mal); };
  if (s.saliendo) { terminar(s.porQue || ''); return; }
  if (s.chau === 'otro') { terminar('Otro equipo tomó la pantalla de esa PC.'); return; }
  if (s.chau === 'baja') { pinEnMemoria = null; terminar('Este equipo fue dado de baja. Hay que emparejarlo de nuevo, estando en casa.', true); return; }
  if (s.chau === 'apagado') { terminar('El portero de casa se apagó.', true); return; }
  if (s.chau === 'agente') { terminar(s.ultimoAviso || 'Se cortó la conexión con esa PC.', true); return; }
  // Un corte sin aviso (cambio de red, un rato sin señal): se reintenta solo, hasta tres veces.
  if (s.reintento < 3 && pinEnMemoria && document.visibilityState === 'visible') {
    visor.terminar();
    decir($('avisoMirando'), 'Se cortó. Reconectando…');
    pintarEstado();
    setTimeout(() => conectar(s.destino, pinEnMemoria, s.reintento + 1), 1500);
    return;
  }
  terminar('Se cortó la conexión.', true);
}

function salir(porQue = '') {
  if (!sesion) return;
  const s = sesion;
  s.saliendo = true;
  s.porQue = porQue;
  visor.soltarTodo();
  try { s.canal.close(); } catch {}
  setTimeout(() => alCerrarse(s), 300);   // por si el aviso de cierre no llega
}

// ---------- La pantalla ----------
const enviar = (objeto) => {
  if (sesion && sesion.canal.readyState === 'open') { try { sesion.canal.send(JSON.stringify(objeto)); } catch {} }
};

function pintarEstado() {
  const cartel = $('estado');
  const e = visor.estado();
  // En la tira queda marcado lo que está fijado: solo el botón que coincide exactamente.
  for (const boton of $('tiraDeAtajos').querySelectorAll('[data-fijar]')) {
    const suyos = boton.dataset.fijar.split(' ');
    boton.setAttribute('aria-pressed', String(suyos.length === e.fijos.length && suyos.every((c) => e.fijos.includes(c))));
  }
  if (!sesion) { cartel.textContent = 'Sin conexión'; cartel.dataset.como = 'mal'; $('medidas').textContent = ''; return; }
  if (!e.hayVideo) { cartel.textContent = 'Conectando…'; delete cartel.dataset.como; $('medidas').textContent = ''; return; }
  cartel.dataset.como = 'bien';
  cartel.textContent = e.conEntrada ? 'Conectado' : 'Conectado · solo mirar';
  const vuelta = e.idaYVuelta === null ? '' : `ida y vuelta ${e.idaYVuelta} ms`;
  $('medidas').textContent = window.innerWidth < 560 ? vuelta.replace('ida y vuelta ', '') : [`${e.cuadros} cuadros/s`, `${e.kbit} kbit/s`, vuelta].filter(Boolean).join(' · ');
}

const visor = crearVisor({
  lienzo: $('pantalla'), escena: $('escena'), campo: $('campo'), enviar,
  alCambiar: pintarEstado,
  alAviso: (texto) => decir($('avisoMirando'), texto, !!texto),
  alArchivo: (trozo) => alTrozoDeArchivo(trozo),
  antesDePegar: () => mandarLoCopiado(),
});

// ---------- Portapapeles (solo texto) ----------
// Lo que se copia en la PC llega solo al portapapeles de este equipo. Lo copiado acá viaja al pegar (Ctrl+V o el botón).
// Solo pasa mientras se está mirando esa PC, y no queda anotado en ningún lado.
const LARGO_DEL_PORTAPAPELES = 50000;
let portaPendiente = null;

function ponerLoPendiente() {
  if (portaPendiente === null || !navigator.clipboard) return;
  const texto = portaPendiente;
  navigator.clipboard.writeText(texto).then(() => { if (portaPendiente === texto) portaPendiente = null; }, () => {});
}

function alPortapapelesDeAlla(texto) {
  if (typeof texto !== 'string' || !texto || texto.length > LARGO_DEL_PORTAPAPELES) return;
  portaPendiente = texto;
  ponerLoPendiente();
}
// El navegador solo deja escribir el portapapeles con la página en uso: si no pudo, se reintenta al primer toque.
document.addEventListener('pointerdown', ponerLoPendiente, true);

async function mandarLoCopiado() {
  if (!sesion || !navigator.clipboard || !navigator.clipboard.readText) return;
  let texto = '';
  try { texto = await navigator.clipboard.readText(); } catch { return; }   // sin permiso: allá se pega lo que allá hubiera
  if (!texto) return;
  if (texto.length > LARGO_DEL_PORTAPAPELES) { decir($('avisoMirando'), 'Lo copiado es demasiado largo para pasarlo.', true); setTimeout(() => decir($('avisoMirando'), ''), 4000); return; }
  enviar({ t: 'porta', c: texto });
}

$('pegar').addEventListener('click', () => { visor.pegarAlla(); $('pantalla').focus({ preventScroll: true }); });

// ---------- Archivos ----------
// Mandar: el archivo viaja en trozos y la PC confirma cuánto le llegó; nunca se manda más de 1 MB sin confirmar.
// Traer: lo mismo al revés. Un archivo por vez en cada sentido.
const TROZO_DE_ARCHIVO = 32000;
const VENTANA = 1024 * 1024;
let subida = null;   // { archivo, canal, enviado, confirmado, aceptada, ocupado }
let bajada = null;   // { nombre, tam, partes, recibido, avisado }

const tamano = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const avisarArchivos = (texto, malo = false) => decir($('avisoArchivos'), texto, malo);
const porciento = (parte, total) => (total ? Math.floor(parte * 100 / total) : 100);

function abrirArchivos() {
  $('panelArchivos').hidden = false;
  enviar({ t: 'archivos' });
}

function soltarArchivos() {
  subida = null;
  bajada = null;
  soltarLaPantalla();
  $('reunion').hidden = true;
  $('panelReunion').hidden = true;
  $('panelArchivos').hidden = true;
  avisarArchivos('');
  $('listaArchivos').textContent = '';
}

function mandarArchivo(archivo) {
  if (!sesion || !archivo) return;
  $('panelArchivos').hidden = false;
  if (subida) { avisarArchivos('Esperá a que termine el que se está mandando.', true); return; }
  subida = { archivo, canal: sesion.canal, enviado: 0, confirmado: 0, aceptada: false, ocupado: false, avisar: avisarArchivos };
  avisarArchivos(`Mandando «${archivo.name}» (${tamano(archivo.size)})…`);
  enviar({ t: 'sube', n: archivo.name, tam: archivo.size });
}

async function seguirSubida() {
  const s = subida;
  if (!s || !s.aceptada || s.ocupado) return;
  s.ocupado = true;
  try {
    while (subida === s && s.enviado < s.archivo.size && s.enviado - s.confirmado < VENTANA && s.canal.readyState === 'open') {
      if (s.canal.bufferedAmount > VENTANA) { await new Promise((ok) => setTimeout(ok, 40)); continue; }
      const trozo = await s.archivo.slice(s.enviado, s.enviado + TROZO_DE_ARCHIVO).arrayBuffer();
      if (subida !== s) return;
      s.canal.send(trozo);
      s.enviado += trozo.byteLength;
    }
  } catch {
    if (subida === s) { subida = null; soltarLaPantalla(); enviar({ t: 'sube-cancelar' }); s.avisar('No se pudo leer el archivo en este equipo.', true); }
  } finally { s.ocupado = false; }
}

function alTrozoDeArchivo(trozo) {
  const b = bajada;
  if (!b) return;
  b.partes.push(trozo.slice());
  b.recibido += trozo.length;
  if (b.recibido - b.avisado >= 256 * 1024) {
    b.avisado = b.recibido;
    enviar({ t: 'baja-va', n: b.recibido });
    avisarArchivos(`Bajando «${b.nombre}»: ${porciento(b.recibido, b.tam)} %`);
  }
}

function guardarLoBajado(b) {
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(new Blob(b.partes));
  enlace.download = b.nombre;
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(enlace.href), 60000);
}

function pintarParaLlevar(lista) {
  const caja = $('listaArchivos');
  caja.textContent = '';
  if (!lista.length) { caja.textContent = 'No hay nada para llevar.'; return; }
  for (const a of lista) {
    if (!a || typeof a.n !== 'string') continue;
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'destino';
    boton.textContent = `${a.n} · ${tamano(Number(a.tam) || 0)}`;
    boton.addEventListener('click', () => {
      if (bajada) { avisarArchivos('Esperá a que termine el que se está bajando.', true); return; }
      avisarArchivos(`Pidiendo «${a.n}»…`);
      enviar({ t: 'baja', n: a.n });
    });
    caja.append(boton);
  }
}

// Devuelve true si el mensaje era de archivos.
function alMensajeDeArchivos(m) {
  switch (m.t) {
    case 'archivos': if (Array.isArray(m.lista)) pintarParaLlevar(m.lista); return true;
    case 'sube-si': if (subida) { subida.aceptada = true; seguirSubida(); } return true;
    case 'sube-va':
      if (subida && Number.isSafeInteger(m.n)) {
        subida.confirmado = m.n;
        avisarArchivos(`Mandando «${subida.archivo.name}»: ${porciento(m.n, subida.archivo.size)} %`);
        seguirSubida();
      }
      return true;
    case 'sube-listo': subida = null; avisarArchivos(`Listo: «${m.n}» quedó en «Recibidos» de esa PC.`); return true;
    case 'sube-no': subida = null; avisarArchivos(m.texto || 'Esa PC no aceptó el archivo.', true); return true;
    // El audio de una reunión viaja igual que un archivo, pero va a otra carpeta de la PC y con otro nombre.
    case 'reunion-si': if (subida) { subida.aceptada = true; seguirSubida(); } return true;
    case 'reunion-va':
      if (subida && Number.isSafeInteger(m.n)) {
        subida.confirmado = m.n;
        avisarReunion(`Subiendo: ${porciento(m.n, subida.archivo.size)} % de ${tamano(subida.archivo.size)}`);
        seguirSubida();
      }
      return true;
    case 'reunion-listo':
      subida = null;
      soltarLaPantalla();
      $('formularioReunion').reset();
      $('fechaReunion').value = hoy();
      avisarReunion('Llegó: se está transcribiendo en la PC.');
      return true;
    case 'reunion-no':
      subida = null;
      soltarLaPantalla();
      avisarReunion(m.texto || 'La PC no aceptó el audio.', true);
      if (m.motivo === 'repetida' || m.motivo === 'tema') $('temaReunion').focus();
      return true;
    case 'baja-si': bajada = { nombre: String(m.n), tam: Number(m.tam) || 0, partes: [], recibido: 0, avisado: 0 }; avisarArchivos(`Bajando «${m.n}»…`); return true;
    case 'baja-listo':
      if (bajada) {
        const b = bajada;
        bajada = null;
        if (b.recibido === b.tam) { guardarLoBajado(b); avisarArchivos(`Listo: «${b.nombre}» quedó en las descargas de este equipo.`); }
        else avisarArchivos('El archivo llegó incompleto. Probá de nuevo.', true);
      }
      return true;
    case 'baja-no': bajada = null; avisarArchivos(m.texto || 'No se pudo bajar.', true); return true;
    default: return false;
  }
}

// ---------- El audio de una reunión ----------
// Solo aparece al mirar la PC que transcribe. Se manda con tema y fecha; la PC arma el nombre y avisa si ya existe.
const avisarReunion = (texto, malo = false) => decir($('avisoReunion'), texto, malo);
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Mientras sube, se le pide al equipo que no apague la pantalla: en un celular, si se apaga, la subida se corta.
let pantallaDespierta = null;
async function mantenerLaPantalla() {
  try { if (navigator.wakeLock && !pantallaDespierta) pantallaDespierta = await navigator.wakeLock.request('screen'); } catch {}
}
function soltarLaPantalla() {
  if (pantallaDespierta) { pantallaDespierta.release().catch(() => {}); pantallaDespierta = null; }
}

$('reunion').addEventListener('click', () => {
  const panel = $('panelReunion');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) { $('panelArchivos').hidden = true; if (!$('fechaReunion').value) $('fechaReunion').value = hoy(); }
});
$('cerrarReunion').addEventListener('click', () => { $('panelReunion').hidden = true; });
$('formularioReunion').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!sesion) return;
  if (subida) { avisarReunion('Esperá a que termine lo que se está mandando.', true); return; }
  const archivo = $('audioReunion').files[0];
  const tema = $('temaReunion').value.trim();
  const fecha = $('fechaReunion').value;
  if (!archivo || !tema || !fecha) { avisarReunion('Faltan el tema, la fecha o el audio.', true); return; }
  subida = { archivo, canal: sesion.canal, enviado: 0, confirmado: 0, aceptada: false, ocupado: false, avisar: avisarReunion };
  avisarReunion(`Mandando el audio (${tamano(archivo.size)})…`);
  mantenerLaPantalla();
  enviar({ t: 'reunion', tema, fecha, n: archivo.name, tam: archivo.size });
});

$('archivos').addEventListener('click', () => { if ($('panelArchivos').hidden) abrirArchivos(); else $('panelArchivos').hidden = true; });
$('cerrarArchivos').addEventListener('click', () => { $('panelArchivos').hidden = true; });
$('actualizarArchivos').addEventListener('click', () => enviar({ t: 'archivos' }));
$('mandarArchivo').addEventListener('click', () => $('elegirArchivo').click());
$('elegirArchivo').addEventListener('change', () => { mandarArchivo($('elegirArchivo').files[0]); $('elegirArchivo').value = ''; });
// En una PC también se puede arrastrar el archivo sobre la pantalla.
$('escena').addEventListener('dragover', (ev) => ev.preventDefault());
$('escena').addEventListener('drop', (ev) => { ev.preventDefault(); if (ev.dataTransfer && ev.dataTransfer.files.length) mandarArchivo(ev.dataTransfer.files[0]); });

// ---------- Atajos de teclado ----------
// Una tablet o un celular no tiene teclado, portapapeles ni carpetas para archivos: esos botones se esconden, y la tira
// queda a la vista con Atrás, Inicio y Recientes, que es lo que ahí hace falta.
function acomodarSegunElTipo(esAndroid) {
  const tira = $('tiraDeAtajos');
  tira.dataset.tipo = esAndroid ? 'android' : 'pc';
  visor.ponerSinPuntero(esAndroid);
  for (const id of ['pegar', 'archivos', 'teclado']) $(id).hidden = esAndroid;
  if (esAndroid) { tira.hidden = false; $('atajos').setAttribute('aria-pressed', 'true'); $('panelArchivos').hidden = true; }
}
$('atajos').addEventListener('click', () => {
  const tira = $('tiraDeAtajos');
  tira.hidden = !tira.hidden;
  $('atajos').setAttribute('aria-pressed', String(!tira.hidden));
});
// Los botones de la tira no le sacan el foco a la pantalla: si no, al tocarlos se soltaría todo allá.
$('tiraDeAtajos').addEventListener('mousedown', (ev) => ev.preventDefault());
$('tiraDeAtajos').addEventListener('click', (ev) => {
  const boton = ev.target.closest('button');
  if (!boton || !sesion) return;
  if (boton.dataset.global) enviar({ t: 'g', a: boton.dataset.global });
  else if (boton.dataset.atajo) visor.atajo(boton.dataset.atajo);
  else if (boton.dataset.fijar) visor.fijar(boton.dataset.fijar.split(' '));
});

$('teclado').addEventListener('click', () => visor.abrirTeclado());
$('salir').addEventListener('click', () => salir());

// Si la página queda un rato fuera de la vista, se cierra la sesión y se vuelve a pedir el PIN.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { ocultaDesde = Date.now(); return; }
  const rato = ocultaDesde ? Date.now() - ocultaDesde : 0;
  ocultaDesde = 0;
  if (rato < MINUTOS_SIN_MIRAR * 60000) return;
  pinEnMemoria = null;
  if (sesion) salir('La sesión se cerró porque este equipo quedó un rato sin mirarla. Entrá de nuevo con tu PIN.');
});

// Para probar desde la consola. «inactividad» dice hace cuánto que nadie toca la PC que se está mirando:
// se mira antes de mandarle mouse o teclado en una prueba.
let esperaInactividad = null;
window.trc = {
  estado: () => ({ emparejado: !!datos, conSesion: !!sesion, ...visor.estado() }),
  red: () => (sesion ? redDeAca(sesion.pc.localDescription.sdp) : null),
  inactividad: () => new Promise((ok) => { esperaInactividad = ok; enviar({ t: 'inactividad' }); setTimeout(() => ok(undefined), 3000); }),
};

// ---------- Arranque ----------
async function arrancar() {
  if (!window.isSecureContext || !('VideoDecoder' in window) || !('RTCPeerConnection' in window) || !window.indexedDB || !window.crypto || !window.crypto.subtle) {
    decir($('noSirve'), 'Este navegador no sirve para TayRemotoControl. Probá con Chrome al día.', true);
    mostrar('noSirve');
    return;
  }
  try { datos = await leer('emparejado'); } catch {
    decir($('noSirve'), 'Este navegador no deja guardar la llave del equipo (puede ser una ventana privada). Abrí la página en una ventana común.', true);
    mostrar('noSirve');
    return;
  }
  if (datos) { irALaLista(); ponerLaListaAlDia(); return; }
  $('nombreDelEquipo').value = /Android/i.test(navigator.userAgent) ? 'Celular' : /Windows/i.test(navigator.userAgent) ? 'Notebook' : 'Equipo';
  mostrar('emparejar');
}
arrancar();
