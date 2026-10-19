import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import DisplayOrder from '../web/order.cjs';
import { dumpConfig, parseConfigText, saveConfig, loadConfig } from '../src/config.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { upsertMapping } from '../src/mappings.js';
import { startServer } from '../src/server.js';
import { PASSWORD_MASK } from '../src/config-store.js';

const fixture = () => ({
  extra: { retained: true },
  servers: Object.fromEntries(['10', '2', 'Third'].map(id => [id, { host: '192.0.2.1', connections: { wg: { type: 'wg-easy', url: 'http://panel', password: 'keep' } } }])),
  routers: { Beta: { endpoint: 'http://router' }, Alpha: { endpoint: 'http://router' } },
  mappings: [
    { name: 'b-2-first', router: 'Beta', server: '2', connection: 'wg', client: 'C', interface: 'VPN1' },
    { name: 'a-third', router: 'Alpha', server: 'Third', connection: 'wg', client: 'C', interface: 'VPN2' },
    { name: 'b-10', router: 'Beta', server: '10', connection: 'wg', client: 'C', interface: 'VPN3' },
    { name: 'b-2-second', router: 'Beta', server: '2', connection: 'wg', client: 'C', interface: 'VPN4' },
    { name: 'a-10', router: 'Alpha', server: '10', connection: 'wg', client: 'C', interface: 'VPN5' },
  ],
  displayOrder: { servers: ['10', 'Third', '2'], routers: ['Alpha', 'Beta'] },
});

test('one order policy handles numeric IDs, stable connection order and browser execution', () => {
  const cfg = fixture(), original = structuredClone(cfg);
  assert.deepEqual(DisplayOrder.names(cfg, 'servers'), ['10', 'Third', '2']);
  assert.deepEqual(DisplayOrder.mappings(cfg).map(m => m.name), ['a-10', 'a-third', 'b-10', 'b-2-first', 'b-2-second']);
  assert.deepEqual(cfg, original, 'display sorting must not change mappings or VPN settings');
  const browser = {};
  vm.runInNewContext(fs.readFileSync(new URL('../web/order.cjs', import.meta.url), 'utf8'), browser);
  assert.equal(JSON.stringify(browser.DisplayOrder.mappings(cfg)), JSON.stringify(DisplayOrder.mappings(cfg)));
});

test('stale and duplicate order entries are cleaned; new entries append; legacy config needs no migration write', () => {
  const cfg = fixture();
  cfg.displayOrder = { servers: ['Third', 'gone', 'Third'], routers: ['Beta', 'deleted'] };
  cfg.routers.New = { endpoint: 'http://new' };
  const parsed = parseConfigText(dumpConfig(cfg));
  assert.deepEqual(parsed.displayOrder, { servers: ['Third', '2', '10'], routers: ['Beta', 'Alpha', 'New'] });
  delete cfg.displayOrder;
  const legacy = parseConfigText(dumpConfig(cfg));
  assert.equal(legacy.displayOrder, undefined);
  assert.deepEqual(DisplayOrder.names(legacy, 'routers'), ['Beta', 'Alpha', 'New']);
  assert.throws(() => parseConfigText(dumpConfig({ ...cfg, displayOrder: { routers: 'Beta' } })), /списком/);
});

test('order survives YAML, encryption and mapping creation/editing without losing credentials', () => {
  const cfg = fixture();
  const restored = parseConfigText(decrypt(encrypt(dumpConfig(cfg), 'test-passphrase'), 'test-passphrase'));
  assert.deepEqual(restored.displayOrder, cfg.displayOrder);
  const created = upsertMapping(restored, { router: 'Alpha', server: '10', connection: 'wg', client: 'New', interface: 'NewVPN' });
  const edited = upsertMapping(created, { ...created.mappings[0], client: 'Changed' }, created.mappings[0].name);
  assert.deepEqual(edited.displayOrder, cfg.displayOrder);
  assert.equal(edited.servers['10'].connections.wg.password, 'keep');
  assert.deepEqual(edited.extra, { retained: true });
});

test('access arrows move existing card nodes, preserving unsaved values and marking the order dirty', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const code = 'function moveAccessCard' + html.split('function moveAccessCard')[1].split('function renderAccessOrder')[0];
  const parent = { children: [], insertBefore(node, before) {
    this.children.splice(this.children.indexOf(node), 1);
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, node);
  } };
  const nodes = ['A', 'B', 'C'].map(value => ({ value, parentElement: parent, get nextSibling() { return parent.children[parent.children.indexOf(this) + 1] || null; } }));
  parent.children = [...nodes]; nodes[1].value = 'Unsaved rename';
  let dirty = 0;
  const context = { markDirty(tab) { assert.equal(tab, 'access'); dirty++; } };
  vm.runInNewContext(code, context);
  assert.equal(context.moveAccessCard(nodes[0], -1), false);
  assert.equal(dirty, 0);
  assert.equal(context.moveAccessCard(nodes[1], -1), true);
  assert.deepEqual(parent.children, [nodes[1], nodes[0], nodes[2]]);
  assert.equal(context.moveAccessCard(nodes[1], 1), true);
  assert.deepEqual(parent.children, nodes);
  assert.equal(nodes[1].value, 'Unsaved rename');
  assert.equal(dirty, 2);
});

test('saving reordered access cards preserves rename positions, mapping references and unrelated settings', async () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const collect = 'function collectAccess' + html.split('function collectAccess')[1].split("$('#addPanel').onclick")[0];
  const save = 'async function saveAll' + html.split('async function saveAll')[1].split('function downloadText')[0];
  const cfg = fixture();
  const serverCard = (oldId, id = oldId) => ({ fields: {
    '.s-id': { value: id, dataset: { oldId } }, '.s-host': { value: '192.0.2.1' }, '.s-domain': { value: '' }, '.s-use-domain': { checked: false },
  }, connections: [{ dataset: { cid: 'wg' }, fields: { '.c-type': { value: 'wg-easy' }, '.c-url': { value: 'http://panel' }, '.c-user': { value: 'admin' }, '.c-pass': { value: 'keep' }, '.c-insec': { checked: true } } }] });
  const routerCard = (oldId, id = oldId) => ({ fields: {
    '.r-id': { value: id, dataset: { oldId } }, '.r-eps': { value: 'http://router' }, '.r-user': { value: 'admin' }, '.r-pass': { value: 'keep-router' }, '.r-insec': { checked: false },
  } });
  const servers = [serverCard('Third', 'RenamedServer'), serverCard('10'), serverCard('2')];
  const routers = [routerCard('Alpha', 'RenamedRouter'), routerCard('Beta')];
  let saved;
  const context = {
    CONFIG: cfg,
    $: (selector, card) => card.fields[selector],
    $$: (selector, card) => selector === '.conn-row' ? card.connections : selector.includes('panelsBox') ? servers : routers,
    api: async (url, body) => { assert.equal(url, '/api/config'); saved = body.config; return {config:body.config}; },
    renderMappings() {}, renderAccess() {}, clearDirty() {},
    toast(message, error) { if (error) throw new Error(message); },
  };
  vm.runInNewContext(collect + save, context);
  await context.saveAll('access');
  assert.deepEqual(Array.from(saved.displayOrder.servers), ['RenamedServer', '10', '2']);
  assert.deepEqual(Array.from(saved.displayOrder.routers), ['RenamedRouter', 'Beta']);
  assert.equal(saved.mappings.find(m => m.name === 'a-third').server, 'RenamedServer');
  assert.equal(saved.mappings.find(m => m.name === 'a-third').router, 'RenamedRouter');
  assert.equal(saved.servers.RenamedServer.connections.wg.password, 'keep');
  assert.deepEqual(saved.extra, cfg.extra);
});

test('API persists shared order, sorts sync output, exports/imports it, and serves browser policy', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-order-')), file = path.join(dir, 'config.yaml');
  saveConfig(file, fixture());
  const server = startServer(file, 0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { 'Content-Type': 'application/json' };
  if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS) headers.Authorization = 'Basic ' + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64');
  const get = async p => { const r = await fetch(base + p, { headers }); assert.equal(r.status, 200); return r; };
  const post = async (p, data) => { const {revision}=await (await get('/api/config')).json(); data={...data,revision}; const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(data) }); assert.equal(r.status, 200); return r.json(); };
  const cfg = fixture(); cfg.displayOrder = { servers: ['2', '10', 'Third'], routers: ['Beta', 'Alpha'] };
  await post('/api/config', { config: cfg });
  assert.deepEqual(loadConfig(file).displayOrder, cfg.displayOrder);
  const data = await (await get('/api/mappings')).json();
  assert.deepEqual(data.displayOrder, cfg.displayOrder);
  assert.deepEqual(data.mappings.map(m => m.name), ['b-2-first', 'b-2-second', 'b-10', 'a-10', 'a-third']);
  const yaml = await (await get('/api/export')).text();
  await post('/api/import', { text: yaml });
  const reloaded = await (await get('/api/config')).json();
  assert.deepEqual(reloaded.config.displayOrder, cfg.displayOrder);
  assert.deepEqual(reloaded.config.extra, cfg.extra);
  assert.equal(reloaded.config.servers['10'].connections.wg.password, PASSWORD_MASK);
  const asset = await get('/order.js');
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(await asset.text(), /DisplayOrder/);
});
