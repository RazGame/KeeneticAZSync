import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { panelLogin } from '../src/panel-login.js';
import { WgEasy } from '../src/wgeasy.js';

test('concurrent WG-Easy clients serialize session writes without replaying login POSTs', async t => {
  let active = 0, peak = 0, posts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/api/auth/password' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    posts++; active++; peak = Math.max(peak, active);
    const conflict = active > 1;
    await delay(15); active--;
    res.writeHead(conflict ? 500 : 200, { 'Set-Cookie':'session=fake; HttpOnly' }); res.end('{}');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const options = { url:`http://127.0.0.1:${server.address().port}`, username:'fake-user', password:'fake-password' };
  const panels = Array.from({length:4}, () => new WgEasy(options));
  await Promise.all(panels.map(p => p.login()));
  assert.equal(posts,4); assert.equal(peak,1);
  for (const panel of panels) assert.equal(panel.jar.cookies.get('session'),'fake');
});

test('panel login queue isolates origins, cancels waiting work and recovers after authentication failure', async () => {
  let release, entered;
  const started = new Promise(r => entered = r), gate = new Promise(r => release = r);
  const first = panelLogin('http://panel-a/login',async () => { entered(); await gate; throw new Error('login failed'); });
  const rejected = assert.rejects(first,/login failed/);
  await started;
  const controller = new AbortController(); let cancelledCalls = 0, nextCalls = 0;
  const cancelled = panelLogin('http://panel-a/other',() => { cancelledCalls++; },{signal:controller.signal});
  controller.abort(); await assert.rejects(cancelled,e => e.name === 'AbortError');
  assert.equal(await panelLogin('http://panel-b',async () => 'independent'),'independent');
  const next = panelLogin('http://panel-a',async () => { nextCalls++; return 'ok'; });
  assert.equal(nextCalls,0);release();await rejected;
  assert.equal(await next,'ok');assert.equal(cancelledCalls,0);assert.equal(nextCalls,1);
});
