import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.split('/* sidebar toggle */')[1].split('</script>')[0];
const bootScript = html.match(/<script id="sidebarBoot">([\s\S]*?)<\/script>/)[1];

function fixture(mobile, saved = 'false') {
  const classes = new Set(), attributes = new Map(), events = {}, label = {};
  const sidebar = { classList: {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    contains: name => classes.has(name),
  } };
  const toggle = { setAttribute: (name, value) => attributes.set(name, value), focus() { this.focused = true; } };
  const backdrop = {}, nav = { addEventListener(name, callback) { this[name] = callback; } };
  const media = { matches: mobile, addEventListener(name, callback) { this[name] = callback; } };
  const storage = new Map([['sidebar_collapsed', saved]]);
  const root = { dataset: {} }, frames = [];
  const context = {
    $: (selector, parent) => parent === toggle ? label : ({ '#sidebar': sidebar, '#sidebarToggle': toggle, '#sidebarBackdrop': backdrop })[selector],
    $$: () => [nav],
    matchMedia: () => media,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: { documentElement: root, addEventListener: (name, callback) => { events[name] = callback; } },
    requestAnimationFrame: callback => frames.push(callback),
  };
  vm.runInNewContext(bootScript, context);
  const initialState = root.dataset.sidebarCollapsed;
  vm.runInNewContext(script, context);
  return { toggle, backdrop, nav, media, storage, attributes, label, events, root, frames, initialState, collapsed: () => classes.has('collapsed') };
}

test('mobile menu opens and closes with visible labels and backdrop without changing desktop preference', () => {
  const f = fixture(true);
  assert.equal(f.collapsed(), true);
  assert.equal(f.attributes.get('aria-expanded'), 'false');
  assert.equal(f.attributes.get('aria-label'), 'Развернуть меню');
  assert.equal(f.backdrop.hidden, true);
  f.toggle.onclick();
  assert.equal(f.collapsed(), false);
  assert.equal(f.attributes.get('aria-expanded'), 'true');
  assert.equal(f.label.textContent, 'Свернуть меню');
  assert.equal(f.backdrop.hidden, false);
  assert.equal(f.root.dataset.sidebarCollapsed, 'false');
  f.toggle.onclick();
  assert.equal(f.collapsed(), true);
  assert.equal(f.backdrop.hidden, true);
  assert.equal(f.root.dataset.sidebarCollapsed, 'true');
  assert.equal(f.storage.get('sidebar_collapsed'), 'false');
});

test('mobile menu dismisses on navigation, backdrop and Escape', () => {
  const f = fixture(true);
  for (const dismiss of [() => f.nav.click(), () => f.backdrop.onclick(), () => f.events.keydown({ key: 'Escape' })]) {
    f.toggle.onclick();
    assert.equal(f.backdrop.hidden, false);
    dismiss();
    assert.equal(f.collapsed(), true);
    assert.equal(f.backdrop.hidden, true);
  }
  assert.equal(f.toggle.focused, true);
});

test('desktop collapse preference survives switching to mobile and back', () => {
  const f = fixture(false, 'true');
  assert.equal(f.collapsed(), true);
  f.toggle.onclick();
  assert.equal(f.collapsed(), false);
  assert.equal(f.storage.get('sidebar_collapsed'), 'false');
  assert.equal(f.backdrop.hidden, true);
  f.media.matches = true; f.media.change();
  assert.equal(f.collapsed(), true);
  f.toggle.onclick();
  assert.equal(f.backdrop.hidden, false);
  f.media.matches = false; f.media.change();
  assert.equal(f.collapsed(), false);
  assert.equal(f.backdrop.hidden, true);
  f.nav.click();
  assert.equal(f.collapsed(), false, 'desktop navigation keeps the menu expanded');
});

test('first-paint state already matches the initialized menu and startup does not animate it', () => {
  for (const [mobile, saved, expected] of [[true, 'false', 'true'], [true, 'true', 'true'], [false, 'true', 'true'], [false, 'false', 'false']]) {
    const f = fixture(mobile, saved);
    assert.equal(f.initialState, expected);
    assert.equal(f.root.dataset.sidebarCollapsed, expected);
    assert.equal(f.root.dataset.sidebarReady, undefined);
    f.frames.shift()();
    assert.equal(f.root.dataset.sidebarReady, undefined);
    f.frames.shift()();
    assert.equal(f.root.dataset.sidebarReady, 'true');
  }
});

test('early menu initialization also works before body exists and when storage is unavailable', () => {
  const root = { dataset: {} };
  vm.runInNewContext(bootScript, {
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem() { throw new Error('Storage blocked'); } },
    document: { documentElement: root },
  });
  assert.equal(root.dataset.sidebarCollapsed, 'false');
});
