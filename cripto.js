// cripto.js — el mismo archivo corre en el navegador y en Node: sobres cifrados, el código de emparejado y las llaves.
// No inventa nada: usa las piezas que ya traen los navegadores y Node (AES-256-GCM, ECDH P-256, HKDF y PBKDF2).
const aBytes = new TextEncoder();
const aLetras = new TextDecoder();
const sutil = globalThis.crypto.subtle;

// ---------- Bytes y texto ----------
export function aTexto64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function deTexto64(texto) {
  const s = atob(String(texto).replace(/-/g, '+').replace(/_/g, '/'));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

export const alAzar = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const nuevoId = (n = 15) => aTexto64(alAzar(n));   // 15 bytes dan 20 letras: el largo de una sala

function juntar(...partes) {
  const todo = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of partes) { todo.set(p, pos); pos += p.length; }
  return todo;
}

// ---------- Sobres ----------
// Un sobre lleva 12 bytes al azar y el contenido cifrado con AES-256-GCM. El «contexto» lo ata a su uso:
// un sobre copiado no sirve para otro pedido, otra casa ni otro equipo. Si alguien lo toca, no abre.
export async function sellar(clave, objeto, contexto) {
  const iv = alAzar(12);
  const cifrado = await sutil.encrypt({ name: 'AES-GCM', iv, additionalData: aBytes.encode(contexto) }, clave,
    aBytes.encode(JSON.stringify(objeto)));
  return aTexto64(juntar(iv, new Uint8Array(cifrado)));
}

export async function abrir(clave, sobre, contexto) {
  const todo = deTexto64(sobre);
  if (todo.length < 28) throw new Error('sobre incompleto');
  const claro = await sutil.decrypt({ name: 'AES-GCM', iv: todo.subarray(0, 12), additionalData: aBytes.encode(contexto) }, clave,
    todo.subarray(12));
  return JSON.parse(aLetras.decode(claro));
}

export const claveDesdeBytes = (bytes) => sutil.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);

// ---------- El código de emparejado ----------
// Diez letras y números que se leen en la pantalla de la PC y se escriben en el equipo nuevo. Sin I, L, O ni U,
// que se confunden. Vale una sola vez y por pocos minutos.
const LETRAS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function nuevoCodigo() {
  let s = '';
  for (const x of alAzar(10)) s += LETRAS[x & 31];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

// Devuelve el código tal como se usa para las cuentas (diez caracteres, sin guion), o null si no puede ser uno.
export function limpiarCodigo(texto) {
  const s = String(texto ?? '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
  return s.length === 10 && [...s].every((c) => LETRAS.includes(c)) ? s : null;
}

// Del código salen dos cosas: la sala donde se encuentran los dos equipos y la clave del primer sobre.
// La cuenta es lenta a propósito (600.000 vueltas): probar códigos al azar no rinde en los minutos que dura uno.
export async function delCodigo(codigo) {
  const base = await sutil.importKey('raw', aBytes.encode(codigo), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await sutil.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: aBytes.encode('TayRemotoControl emparejado v1'), iterations: 600000 }, base, 384));
  return { sala: aTexto64(bits.subarray(0, 15)), clave: await claveDesdeBytes(bits.subarray(16, 48)) };
}

// ---------- La llave de cada equipo ----------
// Cada lado arma un par de llaves para esta única vez y le pasa al otro la parte pública dentro del primer sobre.
// Con la propia y la ajena, los dos llegan a la misma llave sin que haya viajado: quien escuche no la puede armar,
// ni siquiera si más adelante adivina el código.
export const nuevoPar = () => sutil.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

export const publicaDe = async (par) => new Uint8Array(await sutil.exportKey('raw', par.publicKey));

export async function llaveDelEquipo(par, publicaAjena, publicaDelEquipo, publicaDeLaCasa, { exportable = false } = {}) {
  const ajena = await sutil.importKey('raw', publicaAjena, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secreto = await sutil.deriveBits({ name: 'ECDH', public: ajena }, par.privateKey, 256);
  const base = await sutil.importKey('raw', secreto, 'HKDF', false, ['deriveKey']);
  const sal = new Uint8Array(await sutil.digest('SHA-256', juntar(publicaDelEquipo, publicaDeLaCasa)));
  return sutil.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: sal, info: aBytes.encode('TayRemotoControl equipo v1') }, base,
    { name: 'AES-GCM', length: 256 }, exportable, ['encrypt', 'decrypt']);
}

export const bytesDeLaLlave = async (llave) => new Uint8Array(await sutil.exportKey('raw', llave));

// ---------- Los contextos de cada sobre ----------
export const CONTEXTO = {
  emparejar: (sala) => `trc1|emparejar|${sala}`,
  emparejado: (sala, id) => `trc1|emparejado|${sala}|${id}`,
  pedido: (casa, equipo) => `trc1|pedido|${casa}|${equipo}`,
  respuesta: (casa, equipo, id) => `trc1|respuesta|${casa}|${equipo}|${id}`,
};
