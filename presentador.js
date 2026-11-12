// presentador.js — el mismo archivo corre en el navegador y en Node. Habla con los «presentadores»: servicios públicos,
// sin cuenta, que le pasan un mensaje a quien esté esperando en una sala y nada más (son rastreadores de WebTorrent).
// Lo que viaja por ellos va siempre dentro de un sobre cifrado (cripto.js): el presentador no puede leerlo ni cambiarlo.
// Ninguno pasa por Cloudflare, que el usuario prefiere evitar: antes de sumar uno se mira su dirección
// (node pruebas/probar-presentadores.mjs).
export const PRESENTADORES = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
  'wss://tracker.novage.com.ua',
];

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function idAlAzar() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(20));
  let s = '';
  for (const x of b) s += LETRAS[x % LETRAS.length];
  return s;
}

const anuncio = (sala, yo, extra) => JSON.stringify({
  action: 'announce', info_hash: sala, peer_id: yo, uploaded: 0, downloaded: 0, left: 1, ...extra,
});

// ---------- Para el que espera (el portero de casa) ----------
// Se anota en la sala de cada presentador y contesta los pedidos. «alPedido» recibe el texto y devuelve la respuesta
// (o nada, y entonces no se contesta: a un desconocido no se le dice ni que hay alguien).
export function atender(sala, alPedido, { presentadores = PRESENTADORES, alCambiar = () => {} } = {}) {
  const yo = idAlAzar();
  let cerrado = false;
  const lineas = presentadores.map((url) => ({ url, ws: null, abierta: false, espera: 2000, reloj: 0, latido: 0, ultimo: 0 }));

  function conectar(linea) {
    if (cerrado) return;
    let ws;
    try { ws = new WebSocket(linea.url); } catch { programar(linea); return; }
    linea.ws = ws;
    ws.onopen = () => {
      linea.abierta = true;
      linea.espera = 2000;
      linea.ultimo = Date.now();
      ws.send(anuncio(sala, yo, { numwant: 0, event: 'started' }));
      // Cada minuto se vuelve a anotar: así el presentador no lo da por ido, y se nota si la línea murió.
      linea.latido = setInterval(() => {
        if (Date.now() - linea.ultimo > 200000) { try { ws.close(); } catch {} return; }
        try { ws.send(anuncio(sala, yo, { numwant: 0 })); } catch {}
      }, 60000);
      alCambiar();
    };
    ws.onmessage = async (ev) => {
      linea.ultimo = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || !m.offer || typeof m.offer.sdp !== 'string' || m.offer.sdp.length > 60000) return;
      let respuesta = null;
      try { respuesta = await alPedido(m.offer.sdp); } catch { respuesta = null; }
      if (typeof respuesta !== 'string' || ws.readyState !== 1) return;
      try {
        ws.send(anuncio(sala, yo, { numwant: 0, to_peer_id: m.peer_id, offer_id: m.offer_id, answer: { type: 'answer', sdp: respuesta } }));
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(linea.latido);
      const estaba = linea.abierta;
      linea.abierta = false;
      linea.ws = null;
      if (estaba) alCambiar();
      programar(linea);
    };
  }

  function programar(linea) {
    if (cerrado) return;
    clearTimeout(linea.reloj);
    linea.reloj = setTimeout(() => conectar(linea), linea.espera);
    linea.espera = Math.min(60000, linea.espera * 2);
  }

  lineas.forEach(conectar);
  return {
    conectados: () => lineas.filter((l) => l.abierta).map((l) => l.url),
    cerrar() {
      cerrado = true;
      for (const l of lineas) { clearTimeout(l.reloj); clearInterval(l.latido); try { l.ws && l.ws.close(); } catch {} }
    },
  };
}

// ---------- Para el que llega (la página de entrada) ----------
// Manda el pedido a la sala por todos los presentadores a la vez, insiste cada tres segundos y se queda con la primera
// respuesta. Si nadie contesta en el plazo, falla. El que contesta descarta los pedidos repetidos.
export function pedir(sala, texto, { presentadores = PRESENTADORES, esperaMs = 14000 } = {}) {
  return new Promise((ok, mal) => {
    const yo = idAlAzar();
    const abiertas = [];
    let terminado = false;
    let llegaron = 0;
    const cerrar = () => { for (const ws of abiertas) { try { ws.close(); } catch {} } };
    const plazo = setTimeout(() => {
      if (terminado) return;
      terminado = true;
      cerrar();
      mal(new Error(llegaron ? 'sin respuesta' : 'sin presentadores'));
    }, esperaMs);

    for (const url of presentadores) {
      let ws;
      try { ws = new WebSocket(url); } catch { continue; }
      abiertas.push(ws);
      let insistir = 0;
      const mandar = () => {
        if (terminado || ws.readyState !== 1) return;
        // Tres copias: si en la sala hay algún otro equipo además del portero, alguna le toca a él.
        const ofertas = [0, 1, 2].map(() => ({ offer_id: idAlAzar(), offer: { type: 'offer', sdp: texto } }));
        try { ws.send(anuncio(sala, yo, { numwant: ofertas.length, offers: ofertas })); } catch {}
      };
      ws.onopen = () => { llegaron++; mandar(); insistir = setInterval(mandar, 3000); };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (terminado || !m || !m.answer || typeof m.answer.sdp !== 'string') return;
        terminado = true;
        clearTimeout(plazo);
        clearInterval(insistir);
        cerrar();
        ok(m.answer.sdp);
      };
      ws.onerror = () => {};
      ws.onclose = () => clearInterval(insistir);
    }
  });
}
