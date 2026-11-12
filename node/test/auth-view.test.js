import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
const views = html.slice(html.indexOf('function setAuthView('), html.indexOf('async function handleLoginSubmit('));
const startup = html.slice(html.indexOf('async function loadApplication('), html.indexOf('\nloadApplication();'));

test('initial HTML hides both private UI and login until the session check resolves, including slow and failed responses', async () => {
  for (const id of ['appContainer', 'loginScreen']) assert.match(html, new RegExp('<div id="' + id + '" hidden>'));
  assert.match(html, /id="authPending" role="status"/);
  assert.match(css, /#authPending\[hidden\], #appContainer\[hidden\], #loginScreen\[hidden\]\s*\{\s*display:\s*none !important/);
  for (const result of [false, true, new Error('offline')]) {
    const nodes = Object.fromEntries(['authPending','appContainer','loginScreen','loginPass','loginError','logoutBtn'].map(id => [id,{ hidden: id !== 'authPending', style: {}, value: 'old-password' }]));
    let resolve, reject, configReads = 0;
    const request = new Promise((yes,no) => { resolve = yes; reject = no; });
    const scope = vm.createContext({ $: selector => nodes[selector.slice(1)], AUTHENTICATED: false,
      api: async path => { assert.equal(path, '/api/session'); return request; },
      loadCfg: async () => { configReads++; return true; }, loadSync: async () => {},
      stopSyncStatus() {}, stopTrafficMonitor() {}, clearTrafficHistory() {}, toast() {} });
    vm.runInContext(views + startup, scope);
    const pending = scope.loadApplication();
    assert.equal(nodes.authPending.hidden, false);
    assert.equal(nodes.appContainer.hidden, true, 'private UI must never flash during a pending request');
    assert.equal(nodes.loginScreen.hidden, true, 'a valid session should not see a login flash');
    assert.equal(configReads, 0);
    if (result instanceof Error) reject(result); else resolve({ authenticated: result });
    await pending;
    assert.equal(nodes.authPending.hidden, true);
    assert.equal(nodes.appContainer.hidden, result !== true);
    assert.equal(nodes.loginScreen.hidden, result === true);
    assert.equal(configReads, result === true ? 1 : 0);
    scope.showLoginScreen();
    assert.equal(nodes.appContainer.hidden, true, 'logout/expired sessions return directly to login');
    assert.equal(nodes.loginScreen.hidden, false);
    assert.equal(nodes.loginPass.value, '');
  }
});
