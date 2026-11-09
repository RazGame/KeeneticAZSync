import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function converter() {
  const nodes = new Map(), downloads = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', hidden: false, disabled: true, dataset: {}, listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; }, querySelectorAll() { return []; } });
    return nodes.get(id);
  };
  let blob;
  const scope = vm.createContext({ document: { getElementById: element, body: { appendChild() {} },
    createElement() { return { click() { downloads.push({ name: this.download, blob }); }, remove() {} }; } },
    Blob, URL: { createObjectURL(value) { blob = value; return 'blob:local-test'; }, revokeObjectURL() {} }, setTimeout,
    fetch() { throw Error('Converter must not contact the server'); } });
  for (const name of ['awg.cjs', 'converter.js']) vm.runInContext(fs.readFileSync(new URL('../web/' + name, import.meta.url), 'utf8'), scope);
  return { element, downloads, select: file => element('cvFile').listeners.change({ target: { files: [file] } }) };
}
const profile = '[Interface]\nPrivateKey = local-private-key\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = local-public-key\nEndpoint = vpn.example.com:51820\nAllowedIPs = 14.16.0.0/14\n';

test('shared converter creates downloadable profiles and routes locally without API access', async () => {
  const c = converter();
  await c.select({ name: 'home.conf', size: profile.length, text: async () => profile });
  assert.equal(c.element('cvDlConf').disabled, false);
  c.element('cvDlConf').onclick(); c.element('cvDlBat').onclick();
  assert.equal(c.downloads[0].name, 'home.patched.conf');
  assert.match(await c.downloads[0].blob.text(), /PrivateKey = local-private-key/);
  assert.match(await c.downloads[0].blob.text(), /AllowedIPs = 14.16.0.0\/14, 77.88.8.8\/32/);
  assert.equal(c.downloads[1].name, 'home.routes.bat');
  assert.match(await c.downloads[1].blob.text(), /route add 77.88.8.8 mask 255.255.255.255 10.0.0.2/);
  assert.equal(c.element('cvAscPanel').hidden, true, 'plain WireGuard needs no ASC command');
});

test('oversized or invalid files clear old secrets/results, and stale reads cannot replace the latest selection', async () => {
  const c = converter();
  await c.select({ name: 'valid.conf', text: async () => profile });
  await c.select({ name: 'large.conf', size: 4 * 1024 * 1024 + 1, text() { throw Error('must not read'); } });
  assert.match(c.element('cvStatus').textContent, /4 МиБ/);
  assert.equal(c.element('cvConf').value, ''); assert.equal(c.element('cvDlConf').disabled, true);
  let release;
  const pending = c.select({ name: 'old.conf', text: () => new Promise(resolve => { release = resolve; }) });
  await c.select({ name: 'latest.conf', text: async () => profile.replace('10.0.0.2', '10.0.0.3') });
  release(profile); await pending;
  assert.match(c.element('cvConf').value, /10.0.0.3/);
  await c.select({ name: 'empty.conf', text: async () => '' });
  assert.equal(c.element('cvConf').value, ''); assert.equal(c.element('cvDlBat').disabled, true);
  assert.equal(c.element('cvStatusPanel').dataset.state, 'error');
});
