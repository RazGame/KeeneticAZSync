// Portable backups: keep the v1 format; web KDF work is asynchronous and bounded.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { httpError } from './security.js';

const PREFIX = 'AWGSYNC-ENC-v1:';
const KDF = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = promisify(crypto.scrypt);
const MAX_PLAIN = 2 * 1024 * 1024;
function pass(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('Нужен пароль длиной 1–1024 символа');
}
function payload(text) {
  let value = String(text).trim();
  if (value.startsWith(PREFIX)) value = value.slice(PREFIX.length).trim();
  if (value.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Повреждённый зашифрованный файл');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length < 44) throw new Error('Повреждённый зашифрованный файл');
  return buffer;
}
function seal(plain, key, salt, iv) {
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]).toString('base64') + '\n';
  } finally { key.fill(0); }
}
function open(buffer, key) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(16, 28));
    decipher.setAuthTag(buffer.subarray(28, 44));
    return Buffer.concat([decipher.update(buffer.subarray(44)), decipher.final()]).toString('utf8');
  } catch { throw new Error('Не удалось расшифровать — неверный пароль или повреждённый файл'); }
  finally { key.fill(0); }
}
function checkPlain(plain) {
  if (typeof plain !== 'string' || Buffer.byteLength(plain) > MAX_PLAIN) throw new Error('Слишком большая резервная копия');
}
export function encrypt(plain, passphrase) {
  pass(passphrase); checkPlain(plain);
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  return seal(plain, crypto.scryptSync(passphrase, salt, 32, KDF), salt, iv);
}
export function decrypt(text, passphrase) {
  pass(passphrase); const buffer = payload(text);
  return open(buffer, crypto.scryptSync(passphrase, buffer.subarray(0, 16), 32, KDF));
}
export const isEncrypted = text => String(text).trim().startsWith(PREFIX);
let running = false;
const queue = [];
function bounded(operation) {
  if (queue.length >= 4) return Promise.reject(httpError(429, 'Очередь шифрования занята. Повторите позже'));
  return new Promise((resolve, reject) => { queue.push({ operation, resolve, reject }); drain(); });
}
async function drain() {
  if (running || !queue.length) return;
  running = true;
  const next = queue.shift();
  try { next.resolve(await next.operation()); } catch (error) { next.reject(error); }
  finally { running = false; drain(); }
}
export function encryptAsync(plain, passphrase) {
  pass(passphrase); checkPlain(plain);
  return bounded(async () => {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    return seal(plain, await scrypt(passphrase, salt, 32, KDF), salt, iv);
  });
}
export function decryptAsync(text, passphrase) {
  pass(passphrase); const buffer = payload(text);
  return bounded(async () => open(buffer, await scrypt(passphrase, buffer.subarray(0, 16), 32, KDF)));
}
