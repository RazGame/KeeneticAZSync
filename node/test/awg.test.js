import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import vm from 'node:vm';
import Awg from '../web/awg.cjs';
import { parseConf } from '../src/conf.js';
import { buildAscLine } from '../src/transform.js';
import { computePlan, applyPlan, maskCmd } from '../src/core.js';
import { Keenetic } from '../src/keenetic.js';
import { safeMessage } from '../src/security.js';

const legacy = { Jc: '3', Jmin: '16', Jmax: '99', S1: '128', S2: '56', H1: '100', H2: '200', H3: '300', H4: '400', I1: '<b 0x010203><r 10>' };
const modern = { ...legacy, ContentPaddingAddition: '4-32', RekeyAfterTime: '111-123', RekeyTimeout: '4-7', RejectAfterTime: '170-184', KeepaliveTimeout: '13-16', MaxHandshakeAttempts: '14-22' };
const key = Buffer.alloc(32, 7).toString('base64');
function text(awg = modern) {
  return '[Interface]\nPrivateKey = test-private\nAddress = 10.10.0.2/32\nDNS = 14.16.0.1\nMTU = 1280\n'
    + Object.entries(awg).map(([k, v]) => `${k} = ${v}`).join('\n')
    + '\n[Peer]\nPublicKey = test-public\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.10.0.0/24\nPersistentKeepalive = 25\n';
}
function lines(asc) {
  return ['interface Wireguard1', '    description VPN', '    ip address 10.10.0.2 255.255.255.255', '    ip mtu 1280',
    `    wireguard asc ${asc}`, '    wireguard peer test-public', '        endpoint vpn.example.com:51820',
    '        keepalive-interval 25', '        allow-ips 10.10.0.0 255.255.255.0', '        allow-ips 77.88.8.8 255.255.255.255', '    down',
    'ip name-server 14.16.0.1 "" on Wireguard1', 'ip route 10.10.0.0 255.255.255.0 Wireguard1 auto !AntiZapretAWG',
    'ip route 14.16.0.0 255.252.0.0 Wireguard1 auto !AntiZapretAWG', 'ip route 77.88.8.8 10.10.0.2 Wireguard1 auto !AntiZapretDNS'];
}
function context(awg = modern, asc = Awg.build(awg, { extended: true, modern: true })) {
  return { kind: 'wireguard', conf: parseConf(text(awg)), lines: lines(asc), mapping: { interface: 'VPN', server: 'Server' },
    client: { name: 'Client', id: 1 }, panel: { url: 'http://panel' }, base: 'http://router', keenOsVersion: '5.2 Beta 1', extendedAsc: true, modernAsc: true };
}

test('AWG 3.1 fields survive parsing and occupy every argument in the native ASC format', () => {
  const conf = parseConf(text());
  for (const [k, v] of Object.entries(modern)) assert.equal(conf.awg[k], v);
  const line = buildAscLine(conf.awg, true, true), values = Awg.tokens(line);
  assert.equal(values.length, 31);
  assert.deepEqual(values.slice(11, 17), [legacy.I1, '', '', '', '', '']);
  assert.deepEqual(values.slice(17), ['4', '32', '111', '123', '4', '7', '170', '184', '13', '16', '14', '22', '0', '0']);
  assert.equal(Awg.tokens(Awg.build({ ContentPaddingAddition: '8' }, { modern: true })).length, 31, '3.1-only profiles do not silently drop their fields when Jc is omitted');
});

test('shared header protection and 3.1 flags are validated without leaking key material', () => {
  const fields = { ...modern, S3: '12', S4: '12', HeaderProtectionKey: key, RandomTrailers: 'on', DisableCookies: 'true' };
  const line = Awg.build(fields, { modern: true });
  assert.equal(Awg.tokens(line)[16], key);
  assert.deepEqual(Awg.tokens(line).slice(-2), ['1', '1']);
  assert.throws(() => parseConf(text({ ...fields, S3: '0' })), /не меньше 12/);
  assert.throws(() => parseConf(text({ ...fields, HeaderProtectionKey: key + ';reboot' })), e => !e.message.includes(key));
  for (const [k, v] of [['RekeyTimeout', '9-2'], ['ContentPaddingAddition', '65536'], ['RandomTrailers', 'maybe'], ['H1', '100-250'], ['I1', 'x";reboot']]) {
    assert.throws(() => parseConf(text({ ...modern, [k]: v })), /AmneziaWG|H1/);
  }
  assert.throws(() => parseConf(text() + '\n[Interface]\ncontentpaddingaddition = 3-8\n'), /ContentPaddingAddition/);
  assert.equal(Awg.parseFields(text({ ...legacy, contentpaddingaddition: '4-32' })).ContentPaddingAddition, '4-32');
  assert.ok(!maskCmd('interface Wireguard1 wireguard asc ' + line).includes(key));
  assert.ok(!safeMessage('failed key=' + key).includes(key));
});

test('legacy ASC remains compatible and comparison normalizes explicit zero suffixes without changing signatures', () => {
  const short = Awg.build(legacy), extended = Awg.build(legacy, { extended: true });
  assert.equal(Awg.tokens(short).length, 9); assert.equal(Awg.tokens(extended).length, 16);
  const plain = Awg.build({ ...legacy, I1: '' });
  const zero = Awg.build({ ...legacy, I1: '' }, { modern: true, resetModern: true }).replace('"" 0 0 0 0 0 0 0 0 0 0 0 0 0 0', '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0');
  assert.ok(Awg.equal(plain, zero));
  assert.ok(!Awg.equal(extended, extended.replace('<r 10>', '<r 11>')));
  assert.throws(() => Awg.equal(short, short + ' 1'), /Неизвестный формат/);
  assert.throws(() => Awg.build(modern, { extended: true }), /5.2 Alpha 11/);
});

test('a router matching the full AWG 3.1 profile has a noop plan, including router zero-key serialization', () => {
  const line = Awg.build(modern, { modern: true });
  const tokens = Awg.tokens(line); tokens[16] = '0';
  const actual = tokens.map((v, i) => i >= 11 && i <= 15 ? JSON.stringify(v) : v).join(' ');
  assert.equal(computePlan(context(modern, actual)).mode, 'noop');
  const old = Awg.build(legacy, { extended: true });
  const ctx = context(modern, old), plan = computePlan(ctx);
  assert.equal(plan.total, 1); assert.equal(plan.restart, false);
  assert.deepEqual(plan.commands, ['interface Wireguard1 wireguard asc ' + line]);
  const create = computePlan({ ...ctx, lines: [] });
  assert.equal(create.mode, 'create'); assert.ok(create.commands.some(c => c.endsWith('wireguard asc ' + line)));
  assert.throws(() => computePlan({ ...ctx, modernAsc: false }), /5.2 Alpha 11/);
});

test('removing 3.1 fields in the panel explicitly clears them and is idempotent on readback', () => {
  const ctx = context(legacy, Awg.build(modern, { modern: true }));
  const plan = computePlan(ctx), command = plan.commands.find(c => c.includes(' wireguard asc '));
  assert.equal(plan.total, 1); assert.ok(command);
  const line = command.split(' wireguard asc ')[1];
  assert.deepEqual(Awg.tokens(line).slice(16), ['', ...Array(14).fill('0')]);
  assert.equal(computePlan({ ...ctx, lines: lines(line) }).mode, 'noop');
});

test('ASC writes are verified after applying, including a router that acknowledges but ignores the new fields', async () => {
  for (const ignored of [false, true]) {
    const ctx = context(modern, Awg.build(legacy, { extended: true }));
    const plan = computePlan(ctx); let actual = ctx.lines;
    ctx.keen = { async rci(cmds) { if (!ignored) actual = lines(cmds.find(c => c.includes(' wireguard asc ')).split(' wireguard asc ')[1]); return []; }, async runningConfig() { return actual; } };
    const result = await applyPlan(ctx, plan);
    assert.equal(result.ok, !ignored); assert.equal(result.remaining, ignored ? 1 : 0);
    if (ignored) assert.match(result.errors[0], /ASC/);
  }
});

test('a lost readback does not report an unverified AWG 3.1 write as successful or replay it', async () => {
  const ctx = context(modern, Awg.build(legacy, { extended: true })); const plan = computePlan(ctx); let writes = 0;
  ctx.keen = { async rci() { writes++; return []; }, async runningConfig() { throw new Error('socket hang up'); } };
  const result = await applyPlan(ctx, plan);
  assert.equal(writes, 1); assert.equal(result.ok, false); assert.equal(result.verified, false);
  assert.match(result.errors[0], /проверку повторно/);
});

test('AWG capability detection consults read-only help instead of trusting a 5.2 firmware label', async t => {
  let hint = 'asc {jc} {header-protection-key} {content-padding-addition-start} {rekey-after-time-start} {random-trailers} {disable-cookies}';
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ help: { hint } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const keen = new Keenetic({ endpoints: 'http://unused' }); keen.base = 'http://127.0.0.1:' + server.address().port;
  assert.equal(await keen.supportsModernAsc('Wireguard1'), true);
  hint = 'asc {jc} {jmin} {jmax} {s1} {s2}'; assert.equal(await keen.supportsModernAsc(), false);
  hint = ''; await assert.rejects(() => keen.supportsModernAsc(), /не подтвердил/);
  assert.ok(bodies.every(b => Object.keys(b).length === 1 && typeof b.help === 'string'));
  await assert.rejects(() => keen.supportsModernAsc('Wireguard1;reboot'), /Некорректное имя/);
});

test('the browser converter produces the full AWG 3.1 command and rejects unsafe profiles before enabling downloads', async () => {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', hidden: false, disabled: true, dataset: {}, listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; }, querySelectorAll() { return []; } });
    return nodes.get(id);
  };
  const scope = vm.createContext({ document: { getElementById: element }, setTimeout, downloadText() {}, toast() {} });
  vm.runInContext(fs.readFileSync(new URL('../web/awg.cjs', import.meta.url), 'utf8'), scope);
  assert.equal(scope.Awg.build(scope.Awg.parseFields(text()), { extended: true, modern: true }), Awg.build(modern, { modern: true }));
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<script src="/awg.js"></script>'));
  const converter = html.split('/* CONVERTER — обработка целиком в браузере. */')[1].split('async function loadCfg()')[0];
  vm.runInContext(converter, scope);
  const select = source => element('cvFile').listeners.change({ target: { files: [{ name: 'client.conf', text: async () => source }] } });
  await select(text());
  assert.equal(element('cvAsc').value, 'interface Wireguard0 wireguard asc ' + Awg.build(modern, { modern: true }));
  assert.equal(element('cvDlConf').disabled, false); assert.match(element('cvAscHint').textContent, /AWG 3.1/);
  assert.ok(element('cvConf').value.includes('ContentPaddingAddition = 4-32'));
  await select(text({ ...modern, RekeyTimeout: '9-1' }));
  assert.equal(element('cvDlConf').disabled, true); assert.equal(element('cvAscPanel').hidden, true);
  assert.equal(element('cvStatusPanel').dataset.state, 'error');
});
