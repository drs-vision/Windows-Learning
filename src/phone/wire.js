// The phone ⇄ PC message format — the same as src/Shared/Phone/PhoneWire.cs:
// JSON → deflate-raw → AES-256-GCM (12-byte nonce, 16-byte tag) → base64url(nonce ‖ ciphertext ‖ tag),
// split into "cq1:{msgId}:{part}/{total}:{data}" parts of at most 3600 characters (the relay caps a message at 4 KB).

export const PART_SIZE = 3600;

export function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text) {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function importKey(keyB64url) {
  return crypto.subtle.importKey('raw', fromB64url(keyB64url), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(key, obj) {
  const plain = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('deflate-raw'));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plain));
  const all = new Uint8Array(12 + ct.length);
  all.set(nonce, 0); all.set(ct, 12);
  return b64url(all);
}

/** Unscramble; null if it wasn't sealed with this key. */
export async function open(key, text) {
  try {
    const all = fromB64url(text);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), tagLength: 128 }, key, all.subarray(12)));
    return JSON.parse(new TextDecoder().decode(await pipe(plain, new DecompressionStream('deflate-raw'))));
  } catch {
    return null;
  }
}

export function split(sealed) {
  const id = b64url(crypto.getRandomValues(new Uint8Array(6)));
  const n = Math.max(1, Math.ceil(sealed.length / PART_SIZE));
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(`cq1:${id}:${i + 1}/${n}:${sealed.slice(i * PART_SIZE, (i + 1) * PART_SIZE)}`);
  return parts;
}

/** Collects parts; add() returns the whole sealed text once every part of a message has arrived. */
export function assembler() {
  const pending = new Map();
  return {
    add(message) {
      const m = /^cq1:([^:]+):(\d+)\/(\d+):(.*)$/s.exec(message);
      if (!m) return null;
      const i = +m[2], n = +m[3];
      if (n < 1 || n > 64 || i < 1 || i > n) return null;
      if (n === 1) return m[4];
      const e = pending.get(m[1]) ?? new Array(n).fill(null);
      e[i - 1] = m[4];
      pending.set(m[1], e);
      if (e.some((p) => p === null)) return null;
      pending.delete(m[1]);
      return e.join('');
    },
  };
}

/** The link in the QR code: everything after '#' (never sent to any web server). */
export function parseLink(fragment) {
  try {
    const j = JSON.parse(new TextDecoder().decode(fromB64url(fragment.replace(/^#/, ''))));
    if (j.v !== 1 || !j.r || !j.i || !j.o || !j.k) return null;
    return { relay: String(j.r).replace(/\/+$/, ''), topicIn: j.i, topicOut: j.o, key: j.k, household: j.n || 'CoinQuest', phone: j.p || 'Phone', raw: fragment.replace(/^#/, '') };
  } catch {
    return null;
  }
}
