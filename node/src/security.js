import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const BODY_LIMIT = 4 * 1024 * 1024;
export const httpError = (status, message) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest();
const SESSION_COOKIE = 'awg_sync_session';

export function checkRequestOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, 'Межсайтовый запрос запрещён');
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw httpError(403, 'Некорректный Origin'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw httpError(403, 'Межсайтовый запрос запрещён');
  }
}

export function readJsonBody(req, limit = BODY_LIMIT) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return Promise.reject(httpError(415, 'Ожидается application/json'));
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    const fail = error => { if (!done) { done = true; chunks.length = 0; reject(error); } };
    if (Number(req.headers['content-length']) > limit) { req.resume(); fail(httpError(413, 'Слишком большой запрос')); }
    req.on('data', data => {
      if (done) return;
      size += data.length;
      if (size > limit) { fail(httpError(413, 'Слишком большой запрос')); return; }
      chunks.push(data);
    });
    req.on('aborted', () => fail(httpError(400, 'Запрос прерван')));
    req.on('error', () => fail(httpError(400, 'Ошибка чтения запроса')));
    req.on('end', () => {
      if (done) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        done = true; resolve(body);
      } catch { fail(httpError(400, 'Некорректный JSON-объект')); }
    });
  });
}

export function createAccessPolicy(host, { username = process.env.BASIC_AUTH_USER, password = process.env.BASIC_AUTH_PASS, now = Date.now } = {}) {
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!!username !== !!password) throw new Error('Задайте и BASIC_AUTH_USER, и BASIC_AUTH_PASS');
  if (!loopback && (!username || (username === 'admin' && password === 'admin'))) throw new Error('Для сетевого доступа задайте собственные BASIC_AUTH_USER и BASIC_AUTH_PASS');
  const required = !!username, expected = required ? digest(`${username}:${password}`) : null;
  const failures = new Map(), sessions = new Map(), ttl = 12 * 60 * 60 * 1000;
  function prune() {
    const time = now();
    for (const [key, entry] of failures) if (entry.until < time) failures.delete(key);
    for (const [key, expiry] of sessions) if (expiry < time) sessions.delete(key);
  }
  function basic(req) {
    const match = (req.headers.authorization || '').match(/^Basic ([A-Za-z0-9+/]+=*)$/i);
    if (!match) return false;
    return timingSafeEqual(digest(Buffer.from(match[1], 'base64')), expected);
  }
  function cookie(req) { return (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1); }
  function authenticate(req, allowSession = true, countFailure = true) {
    if (!required) {
      // Host restriction also prevents DNS rebinding against a local unprotected instance.
      let hostname;
      try { hostname = new URL('http://' + req.headers.host).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
      return ['127.0.0.1', '::1', 'localhost'].includes(hostname) && (!req.socket?.remoteAddress || ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress));
    }
    prune();
    if (basic(req)) { failures.delete(req.socket?.remoteAddress); return true; }
    if (allowSession && (sessions.get(cookie(req)) || 0) > now()) return true;
    if (!countFailure) return false;
    const key = req.socket?.remoteAddress || 'unknown';
    const entry = failures.get(key) || { count: 0, until: now() + 60000 };
    entry.count++;
    if (failures.size >= 1024 && !failures.has(key)) failures.delete(failures.keys().next().value);
    failures.set(key, entry);
    if (entry.count > 20) throw httpError(429, 'Слишком много попыток входа. Повторите через минуту');
    return false;
  }
  const secure = req => req.socket?.encrypted || req.headers.origin?.startsWith('https://');
  function issueSession(req, res) {
    if (!required) return;
    prune();
    if (sessions.size >= 200) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now() + ttl);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure(req) ? '; Secure' : ''}`);
  }
  function logout(req, res) {
    sessions.delete(cookie(req));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(req) ? '; Secure' : ''}`);
  }
  return { required, authenticate, issueSession, logout };
}

export function responseHeaders(res, html = null) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (html !== null) {
    const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(m => m[1].trim()).map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'`);
  }
}

export function httpUrl(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Некорректный URL');
  let url;
  try { url = new URL(value); } catch { throw new Error('Некорректный URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('URL должен использовать HTTP(S), без пароля, query и fragment');
  // LAN endpoints are required by the application; cloud metadata is never a router/panel.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '169.254.169.254' || host === 'metadata.google.internal') throw new Error('Адрес метаданных запрещён');
  return url;
}

export const safeMessage = message => String(message || 'Ошибка сервера')
  .replace(/\b(private-key|preshared-key)\s+\S+/gi, '$1 [скрыто]')
  .replace(/((?:password|token|secret)["']?\s*[:=]\s*)["']?[^,\s}"']+/gi, '$1[скрыто]')
  .slice(0, 1000);
