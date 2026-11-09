import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const boot = html.match(/<script id="themeBoot">([\s\S]*?)<\/script>/)[1];
const script = fs.readFileSync(new URL('../web/theme.js', import.meta.url), 'utf8');
function fixture(saved = null, dark = false, blocked = false) {
  const storage = new Map(saved === null ? [] : [['awg_sync_theme', saved]]), events = {}, documentEvents = {};
  const root = { dataset: {} }, media = { matches: dark, addEventListener(type, fn) { this[type] = fn; } };
  const pickers = [0, 1].map(() => {
    const summary = { focus() { this.focused = true; } };
    const buttons = ['auto', 'light', 'dark'].map(mode => ({ dataset: { themeOption: mode }, attributes: {},
      setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, fn) { this[k] = fn; } }));
    return { open: false, summary, buttons, querySelector() { return summary; }, querySelectorAll() { return buttons; }, contains(target) { return target === summary || buttons.includes(target); } };
  });
  const localStorage = { getItem(k) { if (blocked) throw Error(); return storage.get(k) ?? null; }, setItem(k, v) { if (blocked) throw Error(); storage.set(k, v); } };
  const context = { matchMedia: () => media, localStorage, window: { addEventListener(k, fn) { events[k] = fn; } },
    document: { documentElement: root, querySelectorAll: () => pickers, addEventListener(k, fn) { documentEvents[k] = fn; } } };
  vm.runInNewContext(boot, context); const initial = root.dataset.theme;
  vm.runInNewContext(script, context);
  return { root, media, pickers, storage, events, documentEvents, initial, localStorage };
}
test('saved theme is applied before styles without a light flash; invalid or blocked storage follows the system', () => {
  assert.ok(html.indexOf('id="themeBoot"') < html.indexOf('rel="stylesheet"'));
  for (const [saved, dark, expected] of [['dark', false, 'dark'], ['light', true, 'light'], [null, true, 'dark'], ['invalid', true, 'dark']]) {
    const f = fixture(saved, dark); assert.equal(f.initial, expected); assert.equal(f.root.dataset.theme, expected);
  }
  const f = fixture(null, true, true); assert.equal(f.initial, 'dark'); f.pickers[0].buttons[1].click(); assert.equal(f.root.dataset.theme, 'light');
});
test('theme choice persists and synchronizes the login and application controls without reload', () => {
  const f = fixture(); f.pickers[0].open = true; f.pickers[0].buttons[2].click();
  assert.equal(f.root.dataset.theme, 'dark'); assert.equal(f.storage.get('awg_sync_theme'), 'dark');
  assert.equal(f.pickers[0].open, false); assert.ok(f.pickers[0].summary.focused);
  assert.ok(f.pickers.every(p => p.buttons[2].attributes['aria-pressed'] === 'true'));
  f.pickers[1].buttons[1].click(); assert.equal(f.root.dataset.theme, 'light');
});
test('automatic mode tracks system changes while explicit themes remain fixed, including changes in another tab', () => {
  const f = fixture(); f.media.matches = true; f.media.change(); assert.equal(f.root.dataset.theme, 'dark');
  f.pickers[0].buttons[1].click(); f.media.change(); assert.equal(f.root.dataset.theme, 'light');
  f.pickers[0].buttons[0].click(); assert.equal(f.root.dataset.theme, 'dark');
  f.events.storage({ key: 'awg_sync_theme', newValue: 'light', storageArea: f.localStorage }); assert.equal(f.root.dataset.theme, 'light');
  f.events.storage({ key: null, newValue: null, storageArea: f.localStorage }); assert.equal(f.root.dataset.themePreference, 'auto'); assert.equal(f.root.dataset.theme, 'dark');
});
test('theme picker dismisses with Escape and outside clicks without closing when selecting within it', () => {
  const f = fixture(); const p = f.pickers[0]; p.open = true;
  f.documentEvents.click({ target: p.summary }); assert.equal(p.open, true);
  f.documentEvents.keydown({ key: 'Escape' }); assert.equal(p.open, false); assert.ok(p.summary.focused);
  p.open = true; f.documentEvents.click({ target: {} }); assert.equal(p.open, false);
});
