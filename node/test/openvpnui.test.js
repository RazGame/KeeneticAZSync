import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenVpnUi } from '../src/openvpnui.js';

async function panel(t, { fail = false, formToken = true } = {}) {
  const clients = ['existing']; let posts = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    if (req.url === '/login') {
      if (req.method === 'GET') { res.setHeader('Set-Cookie', 'session=test'); res.end('<input name="_xsrf" value="login-token">'); }
      else { assert.equal(body.get('_xsrf'), 'login-token'); res.writeHead(302, { Location: '/' }); res.end(); }
      return;
    }
    assert.match(req.headers.cookie, /session=test/);
    if (req.method === 'POST') {
      posts++; assert.equal(req.url, '/certificates'); assert.equal(body.get('_xsrf'), formToken ? 'cert-token' : 'login-token');
      assert.equal(body.get('Name'), 'Router_OVPN'); assert.equal(body.has('passphrase'), false);
      if (!fail) clients.push(body.get('Name'));
    }
    res.end((formToken?'<input name="_xsrf" value="cert-token">':'')+clients.map(n=>`<a href="/certificates/${n}">download</a>`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const ui = new OpenVpnUi({ url: `http://127.0.0.1:${server.address().port}`, username: 'admin', password: 'test' });
  await ui.login(); return { ui, posts: () => posts };
}
test('certificate creation uses authenticated form with fresh XSRF and verifies result', async t => {
  const { ui, posts } = await panel(t);
  assert.deepEqual(await ui.createClient('Router_OVPN'), { name: 'Router_OVPN' });
  assert.equal(posts(), 1);
  await assert.rejects(() => ui.createClient('Router_OVPN'), /уже есть/);
  assert.equal(posts(), 1);
});
test('HTTP 200 with panel error is not reported as successful creation', async t => {
  const { ui } = await panel(t, { fail: true });
  await assert.rejects(() => ui.createClient('Router_OVPN'), /не подтвердила/);
});
test('0.9.5.6 form without hidden token keeps authenticated login token and cookie', async t => {
  const { ui } = await panel(t, { formToken: false });
  assert.equal((await ui.createClient('Router_OVPN')).name, 'Router_OVPN');
});
test('unsafe CN is rejected before submitting to EasyRSA', async t => {
  const { ui, posts } = await panel(t);
  for (const name of ['../client', 'test;reboot', 'test name', '', 'a'.repeat(65)]) {
    await assert.rejects(() => ui.createClient(name), /имя должно/);
  }
  assert.equal(posts(), 0);
});
