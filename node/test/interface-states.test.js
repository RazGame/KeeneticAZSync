import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Keenetic } from '../src/keenetic.js';

test('router status distinguishes a disconnected enabled interface from a disabled one, and reports read errors', async t => {
  let status = 200, text = JSON.stringify({ Wireguard0: { description: 'VPN', state: 'up', connected: 'no' }, OpenVPN0: { description: 'VPN2', state: 'down', connected: false }, Wireguard1: { state: 'up', connected: 'yes' } });
  const server = http.createServer((req, res) => { res.writeHead(status); res.end(text); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const keen = new Keenetic({ endpoints: ['http://unused'], username: '', password: '' });
  keen.base = `http://127.0.0.1:${server.address().port}`;
  const states = await keen.interfaceStates();
  assert.equal(states.VPN.up, true); assert.equal(states.VPN.connected, false);
  assert.equal(states.VPN2.up, false);
  assert.equal(states.Wireguard1.connected, true);
  status = 503;
  await assert.rejects(() => keen.interfaceStates(), /HTTP 503/);
  status = 200; text = 'not-json';
  await assert.rejects(() => keen.interfaceStates(), /Не удалось получить состояние/);
});

test('switching to a disappeared interface never disables the other connections', async t => {
  const keen = new Keenetic({ endpoints: ['http://unused'] });
  t.mock.method(keen, 'interfaceStates', async () => ({ Current: { name: 'Wireguard0', up: true } }));
  const sent = [];
  t.mock.method(keen, 'rci', async commands => { sent.push(...commands); return []; });
  await assert.rejects(() => keen.switchActiveInterface('Missing', ['Current', 'Missing']), /не найден/);
  assert.deepEqual(sent, []);
});
