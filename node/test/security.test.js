import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createAccessPolicy, httpUrl, BODY_LIMIT } from '../src/security.js';
import { saveConfig, loadConfig, parseConfigText, dumpConfig } from '../src/config.js';
import { configRevision, publicConfig, mergePasswords, requireRevision, PASSWORD_MASK } from '../src/config-store.js';
import { startServer } from '../src/server.js';
import { request, createJar } from '../src/util/http.js';
import { Keenetic } from '../src/keenetic.js';
import { WgEasy } from '../src/wgeasy.js';
import { parseCidr, maskToPrefix } from '../src/util/net.js';
import { parseConf } from '../src/conf.js';
import { splitOvpn, validateOvpn } from '../src/ovpn.js';
import { encrypt, decrypt, encryptAsync, decryptAsync } from '../src/crypto.js';

const cfg = () => ({ extra: 'keep', servers: { VPS: { connections: { wg: { type: 'wg-easy', url: 'https://panel', username: 'admin', password: 'panel-secret' } } } }, routers: { R: { endpoint: 'http://router', password: 'router-secret' } }, mappings: [{ name: 'M', server: 'VPS', connection: 'wg', client: 'Client', router: 'R', interface: 'VPN' }] });
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-security-')), file = path.join(dir, 'config.yaml');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  saveConfig(file, cfg()); return { dir, file };
}
async function app(t) {
  const { file } = temp(t), server = startServer(file, 0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { 'Content-Type': 'application/json' };
  if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS) headers.Authorization = 'Basic ' + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64');
  const get = p => fetch(base + p, { headers });
  const post = (p, body, extra = {}) => fetch(base + p, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  return { file, base, headers, get, post };
}
async function httpFixture(t, handler) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('network startup fails closed; local unauthenticated access rejects foreign hosts', () => {
  assert.throws(() => createAccessPolicy('0.0.0.0', { username: '', password: '' }), /собственные/);
  assert.throws(() => createAccessPolicy('0.0.0.0', { username: 'admin', password: 'admin' }), /собственные/);
  assert.throws(() => createAccessPolicy('127.0.0.1', { username: 'admin', password: '' }), /BASIC_AUTH/);
  const local = createAccessPolicy('127.0.0.1', { username: '', password: '' });
  assert.equal(local.authenticate({ headers: { host: 'evil.example' }, socket: { remoteAddress: '127.0.0.1' } }), false);
  assert.equal(local.authenticate({ headers: { host: 'localhost:8787' }, socket: { remoteAddress: '127.0.0.1' } }), true);
});

test('sessions use opaque secure HttpOnly cookies, expire/revoke and accept passwords containing colons', () => {
  let clock = 1000;
  const policy = createAccessPolicy('0.0.0.0', { username: 'admin', password: 'p:ass🔑', now: () => clock });
  const req = { headers: { host: 'example.com', origin: 'https://example.com', authorization: 'Basic ' + Buffer.from('admin:p:ass🔑').toString('base64') }, socket: { remoteAddress: '192.0.2.1' } };
  assert.equal(policy.authenticate(req, false), true);
  let cookie;
  policy.issueSession(req, { setHeader(name, value) { cookie = value; } });
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /; Secure/);
  assert.ok(!cookie.includes('p:ass') && !cookie.includes(req.headers.authorization));
  delete req.headers.authorization; req.headers.cookie = cookie.split(';')[0];
  assert.equal(policy.authenticate(req), true);
  policy.logout(req, { setHeader() {} });
  assert.equal(policy.authenticate(req), false);
  req.headers.authorization = 'Basic ' + Buffer.from('admin:p:ass🔑').toString('base64');
  policy.issueSession(req, { setHeader(name, value) { cookie = value; } });
  delete req.headers.authorization; req.headers.cookie = cookie.split(';')[0]; clock += 13 * 60 * 60 * 1000;
  assert.equal(policy.authenticate(req), false);
});

test('failed login attempts are bounded without locking out a correct credential', () => {
  const policy = createAccessPolicy('0.0.0.0', { username: 'U', password: 'correct' });
  const req = { headers: { host: 'localhost' }, socket: { remoteAddress: '192.0.2.10' } };
  for (let i = 0; i < 20; i++) assert.equal(policy.authenticate(req), false);
  assert.throws(() => policy.authenticate(req), { status: 429 });
  req.headers.authorization = 'Basic ' + Buffer.from('U:correct').toString('base64');
  assert.equal(policy.authenticate(req), true);
});

test('HTTP login authenticates cookie sessions and logout revokes them', async t => {
  const original = [process.env.BASIC_AUTH_USER, process.env.BASIC_AUTH_PASS];
  process.env.BASIC_AUTH_USER = 'security-test'; process.env.BASIC_AUTH_PASS = 'pass:with:colons';
  t.after(() => { ['BASIC_AUTH_USER', 'BASIC_AUTH_PASS'].forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; }); });
  const a = await app(t), origin = a.base.replace('http:', 'https:');
  assert.equal((await fetch(a.base + '/api/config')).status, 401);
  const session = await (await fetch(a.base + '/api/session')).json();
  assert.equal(session.authenticated, false); assert.equal(session.authRequired, true);
  const login = await a.post('/api/login', {}, { Origin: origin });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie'); assert.match(setCookie, /HttpOnly; SameSite=Strict; Secure/);
  const cookie = setCookie.split(';')[0];
  const response = await fetch(a.base + '/api/config', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200); assert.equal((await response.json()).config.routers.R.password, PASSWORD_MASK);
  const logout = await fetch(a.base + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(a.base + '/api/config', { headers: { Cookie: cookie } })).status, 401);
});

test('panel creation is serialized and configuration cannot change while device work is in flight', async t => {
  const a = await app(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  t.mock.method(WgEasy.prototype, 'login', async () => { entered(); await gate; });
  t.mock.method(WgEasy.prototype, 'clients', async () => []);
  t.mock.method(WgEasy.prototype, 'createClient', async name => ({ id: 'id', name }));
  const creating = a.post('/api/panel-client-create', { server: 'VPS', connection: 'wg', name: 'First' });
  await started;
  try {
    assert.equal((await a.post('/api/panel-client-create', { server: 'VPS', connection: 'wg', name: 'Second' })).status, 409);
    const snapshot = await (await a.get('/api/config')).json();
    assert.equal((await a.post('/api/config', snapshot)).status, 409);
  } finally { release(); }
  assert.equal((await creating).status, 200);
  assert.equal((await a.post('/api/panel-client-create', { server: 'VPS', connection: 'wg', name: 'Third' })).status, 200);
});

test('API rejects cross-site, malformed, non-JSON and oversized input before modifying configuration', async t => {
  const a = await app(t), original = fs.readFileSync(a.file, 'utf8');
  assert.equal((await a.post('/api/config', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(a.base + '/api/config', { headers: { ...a.headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(a.base + '/api/config', { method: 'POST', headers: a.headers, body: '{broken' })).status, 400);
  assert.equal((await a.post('/api/config', [])).status, 400);
  assert.equal((await a.post('/api/config', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await a.post('/api/config', { padding: 'x'.repeat(BODY_LIMIT) })).status, 413);
  assert.equal((await a.post('/api/login', { padding: 'x'.repeat(5000) })).status, 413);
  assert.equal(fs.readFileSync(a.file, 'utf8'), original);
});

test('HTML CSP permits exactly the inline application scripts and API responses are not cached', async t => {
  const a = await app(t), response = await a.get('/'), html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /frame-ancestors 'none'/);
  assert.ok(!policy.split('script-src ')[1].split(';')[0].includes('unsafe-inline'));
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if (match[1].trim()) assert.ok(policy.includes(createHash('sha256').update(match[1]).digest('base64')));
  assert.doesNotMatch(html, /<form[^>]*onsubmit=/);
  assert.doesNotMatch(html, /localStorage\.setItem\('awg_sync_auth'/);
  assert.equal((await a.get('/api/config')).headers.get('cache-control'), 'no-store');
});

test('masked passwords round-trip through renamed objects; new passwords and explicit clearing work', () => {
  const original = cfg(), view = publicConfig(original);
  assert.equal(view.servers.VPS.connections.wg.password, PASSWORD_MASK);
  view.servers.New = view.servers.VPS; delete view.servers.VPS;
  view.routers.NewR = view.routers.R; delete view.routers.R;
  const merged = mergePasswords(view, original, { servers: { VPS: 'New' }, routers: { R: 'NewR' } });
  assert.equal(merged.servers.New.connections.wg.password, 'panel-secret');
  assert.equal(merged.routers.NewR.password, 'router-secret');
  view.servers.New.connections.wg.password = 'replacement'; view.routers.NewR.password = '';
  const changed = mergePasswords(view, original);
  assert.equal(changed.servers.New.connections.wg.password, 'replacement'); assert.equal(changed.routers.NewR.password, '');
  assert.equal(original.servers.VPS.connections.wg.password, 'panel-secret');
});

test('revision checks prevent stale overwrite and missing plan tokens never contact devices', async t => {
  const a = await app(t), initial = await (await a.get('/api/config')).json();
  assert.equal(initial.config.routers.R.password, PASSWORD_MASK);
  assert.equal((await a.post('/api/config', { config: initial.config })).status, 428);
  initial.config.extra = 'new';
  assert.equal((await a.post('/api/config', { config: initial.config, revision: initial.revision })).status, 200);
  assert.equal(loadConfig(a.file).routers.R.password, 'router-secret');
  assert.equal((await a.post('/api/config', { config: cfg(), revision: initial.revision })).status, 409);
  assert.equal(loadConfig(a.file).extra, 'new');
  assert.equal((await a.post('/api/apply', { name: 'M' })).status, 428);
  assert.throws(() => requireRevision(cfg(), 'ю'.repeat(64)), { status: 409 });
});

test('atomic persistence retains old bytes on rename failure, rejects cycles and leaves no temporary secrets', t => {
  const { file, dir } = temp(t), original = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('simulated failure'), { code: 'EACCES' }); });
  assert.throws(() => saveConfig(file, { ...cfg(), extra: 'changed' }), /simulated/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dir), ['config.yaml']);
  const cycle = cfg(); cycle.loop = cycle;
  assert.throws(() => dumpConfig(cycle), /Циклическая/);
  assert.throws(() => parseConfigText('{"__proto__":{"polluted":true}}'), /Недопустимый/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseConfigText('servers: [\npassword: secret'), error => !error.message.includes('secret'));
});

test('outgoing HTTP enforces absolute deadlines and maximum response size', async t => {
  const url = await httpFixture(t, (req, res) => {
    if (req.url === '/large') { res.end('x'.repeat(16384)); return; }
    const interval = setInterval(() => res.write('x'), 10);
    req.on('close', () => clearInterval(interval));
  });
  await assert.rejects(() => request({ url: url + '/large', maxBytes: 1024 }), { code: 'ERESPONSELIMIT' });
  const started = Date.now();
  await assert.rejects(() => request({ url, timeout: 100 }), { code: 'ETIMEDOUT' });
  assert.ok(Date.now() - started < 1500);
});

test('cookies cannot leak across origins and unsafe URL schemes are rejected', async t => {
  const jar = createJar();
  const first = await httpFixture(t, (req, res) => { res.setHeader('Set-Cookie', 'sid=secret'); res.end('ok'); });
  let touched = 0;
  const second = await httpFixture(t, (req, res) => { touched++; res.end('ok'); });
  await request({ url: first, jar });
  await assert.rejects(() => request({ url: second, jar }), /origin/);
  assert.equal(touched, 0);
  for (const url of ['file:///etc/passwd', 'http://user:pass@host', 'http://169.254.169.254/']) assert.throws(() => httpUrl(url));
  assert.equal(httpUrl('http://192.168.1.1').hostname, '192.168.1.1');
});

test('RCI rejects HTTP failures and nested errors; partial OpenVPN reads cannot masquerade as missing interfaces', async t => {
  const url = await httpFixture(t, (req, res) => { res.writeHead(401); res.end('{}'); });
  const keen = new Keenetic({ endpoints: [url] }); keen.base = url;
  await assert.rejects(() => keen.rci(['show version']), /HTTP 401/);
  await assert.rejects(() => keen.rci(['interface Wireguard0 up\nsystem reboot']), /Недопустимая/);
  assert.deepEqual(Keenetic.collectErrors({ interface: { status: 'error', message: 'rejected' } }), ['rejected']);
  t.mock.method(keen, '_getJson', async p => { if (p === '/rci/show/interface') return { OpenVPN0: { type: 'OpenVPN' } }; throw new Error('unreadable'); });
  await assert.rejects(() => keen.openvpnInterfaces(), /unreadable/);
});

test('CIDR, router command values and malformed OpenVPN blocks fail closed without exposing keys', () => {
  for (const cidr of ['999.1.1.1/32', '1.1.1.1/99', '::1/129', '1.1.1.1/32\nup']) assert.throws(() => parseCidr(cidr));
  assert.throws(() => maskToPrefix('255.0.255.0'));
  const bad = cfg(); bad.mappings[0].interface = 'VPN\nsystem reboot'; assert.throws(() => dumpConfig(bad));
  const conf = '[Interface]\nAddress=10.0.0.2/32\nPrivateKey=key\n[Peer]\nPublicKey=pub\nEndpoint=vpn.example:51820\nAllowedIPs=1.1.1.1/32\n';
  assert.equal(parseConf(conf).peer.endpoint, 'vpn.example:51820');
  const packet = '<b 0x' + 'ab'.repeat(1200) + '>';
  assert.equal(parseConf(conf.replace('[Peer]', `I1=${packet}\n[Peer]`)).awg.I1, packet);
  assert.throws(() => parseConf(conf.replace('[Peer]', 'I1=bad"packet\n[Peer]')));
  assert.throws(() => parseConf(conf.replace('[Peer]', 'MTU=invalid\n[Peer]')));
  assert.throws(() => parseConf(conf.replace('PrivateKey=key', 'PrivateKey=key; reboot')));
  assert.throws(() => splitOvpn('client\n<key>\nsecret-private-key'), error => !error.message.includes('secret-private-key'));
  assert.throws(() => validateOvpn('client\nscript-security 2\nup /tmp/hook\n', true), /недопустимый/);
  assert.throws(() => validateOvpn('client\n--up /tmp/hook\n', true), /недопустимый/);
});

test('asynchronous encrypted backups preserve v1 compatibility and reject tampering', async () => {
  const text = dumpConfig(cfg()), password = 'backup-pass';
  const modern = await encryptAsync(text, password);
  assert.equal(decrypt(modern, password), text);
  assert.equal(await decryptAsync(encrypt(text, password), password), text);
  await assert.rejects(() => decryptAsync(modern, 'wrong'));
  const bytes = Buffer.from(modern.trim().split(':')[1], 'base64'); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(() => decryptAsync('AWGSYNC-ENC-v1:' + bytes.toString('base64'), password));
});

test('encryption work has a bounded queue instead of unbounded scrypt allocations', async () => {
  const results = await Promise.allSettled(Array.from({ length: 7 }, () => encryptAsync('small backup', 'passphrase')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 5);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 429).length, 2);
});
