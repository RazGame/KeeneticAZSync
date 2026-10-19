import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertMapping, assertInterfaceMode } from '../src/mappings.js';

const config = () => ({ extra: { keep: true }, servers: { VPS: { host: '192.0.2.1', connections: { wg: { type: 'wg-easy' } } } }, routers: { Router: { password: 'unchanged' } }, mappings: [{ name: 'custom-cli-id', server: 'VPS', connection: 'wg', client: 'old', router: 'Router', interface: 'VPN', enabled: false, customOption: 42 }] });
const input = { server: 'VPS', connection: 'wg', client: 'new', router: 'Router', interface: 'VPN2', enabled: true };

test('editing preserves CLI name, credentials, config options, and mapping options', () => {
  const cfg = config(), result = upsertMapping(cfg, input, 'custom-cli-id');
  assert.equal(result.mappings[0].name, 'custom-cli-id');
  assert.equal(result.mappings[0].customOption, 42);
  assert.equal(result.mappings[0].client, 'new');
  assert.equal(result.routers.Router.password, 'unchanged');
  assert.deepEqual(result.extra, { keep: true });
  assert.equal(cfg.mappings[0].client, 'old');
});
test('new links get unique names without replacing old mappings', () => {
  const one = upsertMapping(config(), input);
  const two = upsertMapping(one, { ...input, enabled: false });
  assert.equal(two.mappings.length, 3);
  assert.notEqual(two.mappings[1].name, two.mappings[2].name);
  assert.equal(two.mappings[2].enabled, false);
});
test('missing references and unsafe interface descriptions cannot be saved', () => {
  assert.throws(() => upsertMapping(config(), { ...input, server: 'missing' }));
  assert.throws(() => upsertMapping(config(), { ...input, router: 'missing' }));
  assert.throws(() => upsertMapping(config(), { ...input, interface: 'VPN\ninterface Wireguard0 down' }));
  assert.throws(() => upsertMapping(config(), input, 'deleted-id'));
});
test('explicit interface mode prevents accidental creation or overwrite', () => {
  assert.throws(() => assertInterfaceMode({ mode: 'create' }, 'existing'));
  assert.throws(() => assertInterfaceMode({ mode: 'update' }, 'new'));
  assert.doesNotThrow(() => assertInterfaceMode({ mode: 'create' }, 'new'));
  assert.doesNotThrow(() => assertInterfaceMode({ mode: 'noop' }, 'existing'));
  assert.doesNotThrow(() => assertInterfaceMode({ mode: 'create' }, undefined));
});
