import test from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, applyPlan } from '../src/core.js';
import { parseConf } from '../src/conf.js';
import { Keenetic } from '../src/keenetic.js';

const conf = parseConf('[Interface]\nPrivateKey = test-private\nAddress = 10.1.167.2/32\n[Peer]\nPublicKey = test-public\nEndpoint = vpn.example.com:51820\nAllowedIPs = 1.1.1.1/32\n');
const ovpn = 'client\nremote vpn.example.com 1194 udp\n<ca>\ntest\n</ca>\n';
const error = message => [{ parse: { status: [{ status: 'error', message }] } }];
function fixture({ existing = false, failUp = false, failDown = false } = {}) {
  const states = {
    Wireguard0: { name: 'Wireguard0', description: 'OldAWG', enabled: true, ip: '10.1.167.2' },
    OpenVPN0: { name: 'OpenVPN0', description: 'OldOVPN', enabled: true, config: ovpn },
    Wireguard9: { name: 'Wireguard9', description: 'ManualVPN', enabled: true, ip: '10.99.0.1' },
  };
  if (existing) states.Wireguard1 = { name: 'Wireguard1', description: 'NewVPN', enabled: false, ip: '10.1.167.2' };
  const calls = [];
  const lines = () => Object.values(states).flatMap(i => [
    `interface ${i.name}`, `    description ${i.description}`, ...(i.ip ? [`    ip address ${i.ip} 255.255.255.255`] : []),
    ...(i.name.startsWith('Wireguard') ? ['    wireguard peer test-public', '        endpoint vpn.example.com:51820', '        allow-ips 1.1.1.1 255.255.255.255'] : []), `    ${i.enabled ? 'up' : 'down'}`,
  ]);
  const keen = {
    runningConfig: async () => lines(),
    openvpnInterfaces: async () => Object.values(states).filter(i => i.name.startsWith('OpenVPN')).map(i => ({ ...i, config: i.config || '', connected: i.enabled })),
    writeOpenvpnConfig: async (name, text) => {
      assert.equal(states.Wireguard0.enabled, false, 'old WireGuard must be down before uploading OpenVPN config');
      states[name].config = text;
    },
    rci: async commands => {
      calls.push([...commands]);
      for (const command of commands) {
        const m = command.match(/^interface (\S+)(?: (.*))?$/); if (!m) continue;
        const [, name, tail = ''] = m;
        states[name] ||= { name, enabled: false, description: '' };
        if (tail.startsWith('description ')) states[name].description = tail.slice(12);
        if (tail.startsWith('ip address ')) states[name].ip = tail.split(' ')[2];
        if (tail === 'down') { if (failDown && name === 'Wireguard0') return error('cannot disable'); states[name].enabled = false; }
        if (tail === 'up') {
          if (failUp && name === 'Wireguard1') return error('cannot enable');
          if (states[name].ip && Object.values(states).some(i => i.name !== name && i.enabled && i.ip === states[name].ip)) return error('network conflicts with active interface');
          states[name].enabled = true;
        }
      }
      return [];
    },
  };
  const ctx = { kind: 'wireguard', keen, conf, lines: lines(), mapping: { interface: 'NewVPN', server: 'NewServer' }, client: { name: 'Client' }, panel: { url: 'http://panel' }, base: 'http://router', managedDescriptions: ['OldAWG', 'OldOVPN', 'NewVPN'] };
  return { ctx, keen, calls, states };
}

test('new VPN disables managed WireGuard and OpenVPN before enabling a conflicting address; manual VPN is preserved', async () => {
  const { ctx, calls, states } = fixture();
  const plan = computePlan(ctx);
  assert.equal(plan.mode, 'create'); assert.equal(plan.activation.disable.length, 2);
  assert.equal((await applyPlan(ctx, plan)).ok, true);
  assert.deepEqual(calls[0], ['interface Wireguard0 down', 'interface OpenVPN0 down']);
  assert.equal(states.Wireguard1.enabled, true); assert.equal(states.Wireguard0.enabled, false);
  assert.equal(states.OpenVPN0.enabled, false); assert.equal(states.Wireguard9.enabled, true);
});
test('an existing, previously failed new interface can be activated after disabling old VPNs', async () => {
  const { ctx, states, calls } = fixture({ existing: true });
  const plan = computePlan(ctx, { activate: true });
  assert.equal(plan.mode, 'update');
  assert.equal((await applyPlan(ctx, plan)).ok, true);
  assert.ok(calls[0].every(c => c.endsWith(' down')));
  assert.equal(states.Wireguard1.enabled, true); assert.equal(states.Wireguard0.enabled, false);
});
test('updating a disabled interface without activation does not switch VPNs', async () => {
  const { ctx, states } = fixture({ existing: true });
  const plan = computePlan(ctx, { withSecrets: true });
  assert.equal(plan.activation, undefined);
  assert.equal((await applyPlan(ctx, plan)).ok, true);
  assert.equal(states.Wireguard1.enabled, false); assert.equal(states.Wireguard0.enabled, true);
});
test('failed activation brings old VPNs back and leaves the new interface disabled', async () => {
  const { ctx, states, calls } = fixture({ failUp: true });
  const result = await applyPlan(ctx, computePlan(ctx));
  assert.equal(result.ok, false); assert.match(result.errors[0], /cannot enable/);
  assert.equal(states.Wireguard0.enabled, true); assert.equal(states.OpenVPN0.enabled, true);
  assert.equal(states.Wireguard1.enabled, false);
  assert.equal(calls.at(-1)[0], 'interface Wireguard1 down');
});
test('failure to disable old VPN prevents any attempt to configure or enable the new one', async () => {
  const { ctx, states } = fixture({ failDown: true });
  assert.equal((await applyPlan(ctx, computePlan(ctx))).ok, false);
  assert.equal(states.Wireguard1, undefined); assert.equal(states.Wireguard0.enabled, true);
});
test('creating OpenVPN also disables managed WireGuard before config upload and activation', async () => {
  const { ctx, states, calls } = fixture();
  Object.assign(ctx, { kind: 'openvpn', ovpnText: ovpn, ovpnIfaces: [{ name: 'OpenVPN0', description: 'OldOVPN', enabled: true, config: ovpn }], managedStates: Object.fromEntries(Object.values(states).map(i => [i.description, { ...i, up: i.enabled }])) });
  const plan = computePlan(ctx);
  assert.equal((await applyPlan(ctx, plan)).ok, true);
  assert.deepEqual(calls[0], ['interface Wireguard0 down', 'interface OpenVPN0 down']);
  assert.equal(states.OpenVPN1.enabled, true); assert.equal(states.Wireguard0.enabled, false);
});
test('OpenVPN activation still works when its configuration already matches', async () => {
  const { ctx, states } = fixture();
  states.OpenVPN1 = { name: 'OpenVPN1', description: 'NewVPN', enabled: false, config: ovpn };
  Object.assign(ctx, { kind: 'openvpn', ovpnText: ovpn, ovpnIfaces: [{ ...states.OpenVPN1, connected: false }], managedStates: Object.fromEntries(Object.values(states).map(i => [i.description, { ...i, up: i.enabled }])) });
  const plan = computePlan(ctx, { activate: true });
  assert.equal(plan.ovpn, null); assert.equal(plan.mode, 'update');
  assert.equal((await applyPlan(ctx, plan)).ok, true);
  assert.equal(states.OpenVPN1.enabled, true); assert.equal(states.Wireguard0.enabled, false);
});
test('explicit switching confirms old VPN is down before sending target up, irrespective of mapping order', async t => {
  const keen = new Keenetic({ endpoints: ['http://unused'] });
  t.mock.method(keen, 'interfaceStates', async () => ({ Target: { name: 'Wireguard0', up: false }, Old: { name: 'Wireguard1', up: true } }));
  const calls = [];
  t.mock.method(keen, 'rci', async cmds => { calls.push(cmds); return []; });
  await keen.switchActiveInterface('Target', ['Target', 'Old']);
  assert.deepEqual(calls, [['interface Wireguard1 down'], ['interface Wireguard0 up', 'system configuration save']]);
});
