// Encrypts and decrypts the HQ data file (hq/data.enc).
// Same format the /hq page decrypts in the browser: PBKDF2-SHA256 -> AES-256-GCM.
import { webcrypto as crypto } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_FILE = path.join(ROOT, 'hq', 'data.enc');
const ITER = 600000;
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function key(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function password() {
  const p = process.env.HQ_PASSWORD;
  if (!p) { console.error('HQ_PASSWORD is not set.'); process.exit(1); }
  return p;
}

export function emptyData() {
  return {
    v: 1, updatedAt: null,
    twitch: { sessions: [], snapshots: [], vods: [] },
    youtube: { snapshots: [], videos: [] },
    trending: null,
    take: null,
    notes: [],
  };
}

export async function load(pw = password()) {
  if (!existsSync(DATA_FILE)) return emptyData();
  const box = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const k = await key(pw, unb64(box.salt));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, k, unb64(box.ct));
  } catch {
    console.error('Could not decrypt hq/data.enc: wrong HQ_PASSWORD?'); process.exit(1);
  }
  return Object.assign(emptyData(), JSON.parse(new TextDecoder().decode(plain)));
}

export async function save(data, pw = password()) {
  data.updatedAt = new Date().toISOString();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(pw, salt),
    new TextEncoder().encode(JSON.stringify(data)));
  const box = { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  await writeFile(DATA_FILE, JSON.stringify(box) + '\n');
}

// Keep one entry per key, newest wins, sorted by `by`.
export function upsert(list, item, keyOf, max = Infinity) {
  const k = keyOf(item);
  const out = list.filter((x) => keyOf(x) !== k);
  out.push(item);
  return out.slice(-max);
}
