import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request } from '../src/util/http.js';

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
test('a transient reset while reading a config is retried once', async t => {
  let calls = 0;
  const url = await serve(t, (req, res) => { if (++calls === 1) req.socket.destroy(); else res.end('complete-config'); });
  assert.equal((await request({ url, timeout: 2000 })).text, 'complete-config');
  assert.equal(calls, 2);
});
test('an incomplete response is rejected and re-read instead of hanging or returning partial config', async t => {
  let calls = 0;
  const url = await serve(t, (req, res) => {
    if (++calls === 1) { res.writeHead(200, { 'Content-Length': 100 }); res.write('partial'); setImmediate(() => res.destroy()); }
    else res.end('complete-config');
  });
  assert.equal((await request({ url, timeout: 2000 })).text, 'complete-config');
  assert.equal(calls, 2);
});
test('persistent reset is bounded to two attempts', async t => {
  let calls = 0;
  const url = await serve(t, req => { calls++; req.socket.destroy(); });
  await assert.rejects(() => request({ url, timeout: 2000 }), { code: 'ECONNRESET' });
  assert.equal(calls, 2);
});
test('POST is never replayed after a reset, preventing duplicate clients or router commands', async t => {
  let writes = 0;
  const url = await serve(t, req => { writes++; req.socket.destroy(); });
  await assert.rejects(() => request({ url, method: 'POST', body: 'create-client', timeout: 2000 }));
  assert.equal(writes, 1);
});
