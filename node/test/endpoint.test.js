import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { configDomain, useWireguardDomain, useOpenvpnDomain } from '../src/endpoint.js';
import { validateConfig, dumpConfig, parseConfigText, saveConfig, loadConfig } from '../src/config.js';
import { prepare, computePlan, applyPlan } from '../src/core.js';
import { WgEasy } from '../src/wgeasy.js';
import { OpenVpnUi } from '../src/openvpnui.js';
import { Keenetic } from '../src/keenetic.js';
import { startServer } from '../src/server.js';
import { publicConfig } from '../src/config-store.js';

const IP = '192.0.2.10';
const DOMAIN = 'vpn.example.com';
const wgText = `[Interface]
PrivateKey = private-test-key
Address = 10.0.0.2/32
[Peer]
PublicKey = public-test-key
Endpoint = ${IP}:51820
AllowedIPs = 14.16.0.0/14, 77.88.8.8/32
PersistentKeepalive = 25
`;
const ovpnText = `client\r\nremote ${IP} 1194 udp # primary\r\n<connection>\r\n  remote "${IP}" 443 tcp\r\n</connection>\r\n# remote old.example.com 80\r\n<ca>\r\nremote certificate-data\r\n</ca>\r\n<key>\r\nprivate-test-key\r\n</key>\r\n`;
const mapping = { name: 'router-vpn', server: 'vpn', connection: 'wg', client: 'client', router: 'router', interface: 'VPN' };
const config = (overrides = {}, kind = 'wg-easy') => ({
  servers: { vpn: { host: IP, connections: { wg: { type: kind, url: `https://${IP}:5443`, username: 'test', password: 'test' } }, ...overrides } },
  routers: { router: { endpoints: ['http://router.example.com'], username: 'test', password: 'test' } },
  mappings: [{ ...mapping }],
});
const running = (host) => [
  'interface Wireguard0', '    description VPN', '    ip address 10.0.0.2 255.255.255.255',
  '    wireguard peer public-test-key', `        endpoint ${host}:51820`, '        keepalive-interval 25',
  '        allow-ips 14.16.0.0 255.252.0.0', '        allow-ips 77.88.8.8 255.255.255.255', '    down',
  'ip route 14.16.0.0 255.252.0.0 Wireguard0 auto !AntiZapretAWG',
  'ip route 77.88.8.8 10.0.0.2 Wireguard0 auto !AntiZapretDNS',
];

test('legacy config and disabled option preserve original VPN configs', () => {
  const old = validateConfig({ panels: { vpn: { url: `https://${IP}:5443` } }, routers: config().routers, mappings: [{ ...mapping, server: undefined, connection: undefined, panel: 'vpn' }] });
  assert.equal(old.servers.vpn.host, IP);
  for (const server of [old.servers.vpn, { domain: DOMAIN, useDomain: false }]) {
    const conf = { peer: { endpoint: `${IP}:51820` } };
    assert.equal(useWireguardDomain(conf, server), conf);
    assert.equal(useOpenvpnDomain(ovpnText, server), ovpnText);
  }
});

test('domain settings survive YAML export/import; invalid input is rejected', () => {
  const cfg = config({ domain: DOMAIN, useDomain: true });
  assert.deepEqual(parseConfigText(dumpConfig(cfg)), cfg);
  assert.equal(configDomain({ domain: ' VPN.Example.COM. ', useDomain: true }), DOMAIN);
  assert.equal(configDomain({ domain: 'впн.пример.рф', useDomain: true }), 'xn--b1awf.xn--e1afmkfd.xn--p1ai');
  for (const domain of ['', IP, 'https://vpn.example.com', 'vpn.example.com:443', 'vpn.example.com/path', 'vpn.example.com\nup', '-vpn.example.com', 'vpn..example.com']) {
    assert.throws(() => validateConfig(config({ domain, useDomain: true })), /сервер «vpn»/);
  }
  assert.throws(() => validateConfig(config({ domain: DOMAIN, useDomain: 'false' })));
});

test('WireGuard preserves port, keys and other fields, including IPv6 source endpoints', () => {
  for (const endpoint of [`${IP}:51820`, '[2001:db8::1]:443', 'old.example.com:53']) {
    const conf = { iface: { privateKey: 'secret' }, peer: { endpoint, publicKey: 'public', allowedIps: ['0.0.0.0/0'] } };
    const result = useWireguardDomain(conf, { domain: DOMAIN, useDomain: true });
    assert.equal(result.peer.endpoint, `${DOMAIN}:${endpoint.split(':').at(-1)}`);
    assert.deepEqual(result, { ...conf, peer: { ...conf.peer, endpoint: result.peer.endpoint } });
    assert.equal(conf.peer.endpoint, endpoint);
  }
  assert.throws(() => useWireguardDomain({ peer: {} }, { domain: DOMAIN, useDomain: true }), /Endpoint/);
});

test('OpenVPN rewrites all remotes, preserving ports, comments, inline keys and line endings', () => {
  const result = useOpenvpnDomain(ovpnText, { domain: DOMAIN, useDomain: true });
  assert.equal(result, ovpnText.replace(`remote ${IP}`, `remote ${DOMAIN}`).replace(`remote "${IP}"`, `remote ${DOMAIN}`));
  assert.throws(() => useOpenvpnDomain('client\n<key>\nremote key-data\n</key>\n', { domain: DOMAIN, useDomain: true }), /remote/);
});

function mockRouter(t) {
  t.mock.method(Keenetic.prototype, 'connect', async () => 'http://router.example.com');
  t.mock.method(Keenetic.prototype, 'keenOsVersion', async () => '5.1');
}

test('WireGuard prepare/plan/apply switches IP to domain and back, then becomes a noop', async (t) => {
  mockRouter(t);
  t.mock.method(WgEasy.prototype, 'login', async () => {});
  t.mock.method(WgEasy.prototype, 'configByName', async () => ({ client: { id: 1, name: 'client' }, conf: wgText }));
  let current = IP;
  t.mock.method(Keenetic.prototype, 'runningConfig', async () => running(current));
  const sent = [];
  t.mock.method(Keenetic.prototype, 'rci', async (commands) => { sent.push(...commands); current = DOMAIN; return []; });
  const cfg = config({ domain: DOMAIN, useDomain: true });
  const ctx = await prepare(cfg, mapping);
  assert.equal(ctx.panel.url, `https://${IP}:5443`);
  const plan = computePlan(ctx);
  assert.equal(plan.total, 1);
  assert.deepEqual(plan.commands, [`interface Wireguard0 wireguard peer public-test-key endpoint ${DOMAIN}:51820`]);
  assert.equal((await applyPlan(ctx, plan)).ok, true);
  assert.ok(sent.includes('system configuration save'));
  assert.equal(computePlan(await prepare(cfg, mapping)).mode, 'noop');
  cfg.servers.vpn.useDomain = false;
  assert.deepEqual(computePlan(await prepare(cfg, mapping)).commands, [`interface Wireguard0 wireguard peer public-test-key endpoint ${IP}:51820`]);
  t.mock.method(Keenetic.prototype, 'runningConfig', async () => []);
  assert.ok(computePlan(await prepare(config({ domain: DOMAIN, useDomain: true }), mapping)).commands.some((c) => c.endsWith(`endpoint ${DOMAIN}:51820`)));
});

test('OpenVPN prepare/plan/apply handles existing and new interfaces, reverses to IP, and becomes a noop', async (t) => {
  mockRouter(t);
  t.mock.method(OpenVpnUi.prototype, 'login', async () => {});
  t.mock.method(OpenVpnUi.prototype, 'configByName', async () => ovpnText);
  let current = ovpnText;
  t.mock.method(Keenetic.prototype, 'openvpnInterfaces', async () => [{ name: 'OpenVPN0', description: 'VPN', config: current, connected: false }]);
  t.mock.method(Keenetic.prototype, 'writeOpenvpnConfig', async (_, text) => { current = text; });
  t.mock.method(Keenetic.prototype, 'rci', async () => []);
  const cfg = config({ domain: DOMAIN, useDomain: true }, 'openvpn-ui');
  const ctx = await prepare(cfg, mapping);
  const plan = computePlan(ctx);
  assert.equal(plan.mode, 'update');
  assert.equal(plan.meta.remote, `${DOMAIN} 1194 udp # primary`);
  assert.equal((await applyPlan(ctx, plan)).remaining, 0);
  assert.equal(computePlan(await prepare(cfg, mapping)).mode, 'noop');
  cfg.servers.vpn.useDomain = false;
  assert.equal(computePlan(await prepare(cfg, mapping)).ovpn.text.includes(`remote ${IP} 1194`), true);
  t.mock.method(Keenetic.prototype, 'openvpnInterfaces', async () => []);
  cfg.servers.vpn.useDomain = true;
  const create = computePlan(await prepare(cfg, mapping));
  assert.equal(create.mode, 'create');
  assert.ok(create.ovpn.text.includes(`remote ${DOMAIN} 1194`));
});

test('assigning a different WireGuard client updates its private key and replaces the server peer explicitly', async t => {
  mockRouter(t);
  t.mock.method(WgEasy.prototype, 'login', async () => {});
  t.mock.method(WgEasy.prototype, 'configByName', async () => ({ client: { id: 2, name: 'new-client' }, conf: wgText.replace('public-test-key', 'new-public-key').replace('private-test-key', 'new-private-key') }));
  t.mock.method(Keenetic.prototype, 'runningConfig', async () => running(IP));
  const ctx = await prepare(config(), mapping);
  assert.equal(computePlan(ctx).mode, 'error');
  const plan = computePlan(ctx, { withSecrets: true });
  assert.equal(plan.mode, 'update');
  assert.ok(plan.commands.includes('interface Wireguard0 wireguard private-key new-private-key'));
  assert.ok(plan.commands.includes('interface Wireguard0 no wireguard peer public-test-key'));
  assert.ok(plan.commands.includes('interface Wireguard0 wireguard peer new-public-key connect'));
});

test('prepare errors identify panel download versus router read without exposing secrets', async t => {
  mockRouter(t);
  t.mock.method(WgEasy.prototype, 'login', async () => {});
  let panelFailure = true;
  const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  t.mock.method(WgEasy.prototype, 'configByName', async () => {
    if (panelFailure) throw reset();
    return { client: { name: 'client' }, conf: wgText };
  });
  t.mock.method(Keenetic.prototype, 'runningConfig', async () => { throw reset(); });
  await assert.rejects(() => prepare(config(), mapping), e => /Загрузка конфигурации клиента «client» с панели «vpn»/.test(e.message) && e.cause.code === 'ECONNRESET' && !e.message.includes('private-test-key'));
  panelFailure = false;
  await assert.rejects(() => prepare(config(), mapping), /Чтение настроек роутера «router»: соединение разорвано.*создавать клиента не нужно/);
});

test('HTTP API persists domain settings, exports them and rejects an enabled empty domain without overwriting', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-domain-test-'));
  const file = path.join(dir, 'config.yaml');
  saveConfig(file, config());
  const server = startServer(file, 0, '127.0.0.1');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfg = config({ domain: DOMAIN, useDomain: true });
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS) headers.Authorization = `Basic ${Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64')}`;
  const post = async (value) => { const {revision}=await (await fetch(base+'/api/config',{headers})).json(); return fetch(base + '/api/config', { method: 'POST', headers, body: JSON.stringify({ config: value, revision }) }); };
  assert.equal((await post(cfg)).status, 200);
  assert.deepEqual((await (await fetch(base + '/api/config', { headers })).json()).config, publicConfig(cfg));
  assert.deepEqual(parseConfigText(await (await fetch(base + '/api/export', { headers })).text()), cfg);
  assert.equal((await post(config({ domain: '', useDomain: true }))).status, 400);
  assert.deepEqual(loadConfig(file), cfg);
});
