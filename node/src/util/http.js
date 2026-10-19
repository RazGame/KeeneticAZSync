// Минимальный HTTP(S)-клиент с cookie-jar и поддержкой self-signed.
// Без внешних зависимостей — только node:http/https.
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { httpUrl } from '../security.js';

export function createJar() {
  return { cookies: new Map() };
}

function applySetCookie(jar, setCookie) {
  if (!setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Повторяем только безопасное чтение после обрыва транспорта. POST (включая
// создание клиента и запись RCI) никогда не повторяется автоматически.
export async function request(opts) {
  const method = (opts.method || 'GET').toUpperCase();
  const deadline = Date.now() + (opts.timeout ?? 15000);
  const retryable = new Set(['ECONNRESET', 'EPIPE']);
  for (let attempt = 0; ; attempt++) {
    try { return await requestOnce({ ...opts, timeout: Math.max(1, deadline - Date.now()) }); }
    catch (e) {
      if (opts.retry === false || opts.signal?.aborted || method !== 'GET' || attempt >= 1 || !retryable.has(e.code) || deadline - Date.now() < 500) throw e;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

function requestOnce(opts) {
  opts.signal?.throwIfAborted();
  const { url, method = 'GET', headers = {}, body, jar, insecure = false, timeout = 15000 } = opts;
  const u = new URL(url);
  httpUrl(url);
  const lib = u.protocol === 'https:' ? https : http;
  const h = { ...headers };
  if (jar) {
    if (jar.origin && jar.origin !== u.origin) throw new Error('Нельзя передавать cookies другому origin');
    jar.origin = u.origin;
  }
  if (jar && jar.cookies.size) h['Cookie'] = cookieHeader(jar);
  if (body != null) h['Content-Length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    let size = 0, terminalError = null, settled = false;
    const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(deadline); opts.signal?.removeEventListener('abort', abort); (terminalError || error) ? reject(terminalError || error) : resolve(result); };
    const req = lib.request(
      u,
      { method, headers: h, timeout, rejectUnauthorized: !insecure },
      (res) => {
        const chunks = [];
        // Обрыв после заголовков не вызывает req.error и раньше мог оставить
        // Promise незавершённым. Неполный ответ нельзя выдавать как конфигурацию.
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(Object.assign(new Error('соединение разорвано во время чтения ответа'), { code: 'ECONNRESET' })));
        res.on('data', d => {
          size += d.length;
          if (size > maxBytes) { chunks.length = 0; failRequest(Object.assign(new Error('Ответ превышает допустимый размер'), { code: 'ERESPONSELIMIT' })); return; }
          chunks.push(d);
        });
        res.on('end', () => {
          if (jar) applySetCookie(jar, res.headers['set-cookie']);
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    // Reject explicitly: destroying an already-complete keep-alive response with
    // an Error can emit an unhandled socket error after Node detaches its listener.
    const failRequest = error => { terminalError = error; finish(error); req.destroy(); };
    const abort = () => failRequest(Object.assign(new Error('Операция отменена'), { code: 'ABORT_ERR' }));
    const deadline = setTimeout(() => failRequest(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' })), timeout);
    req.on('error', error => finish(error));
    req.on('timeout', () => failRequest(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' })));
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) { abort(); return; }
    if (body != null) req.write(body);
    req.end();
  });
}
