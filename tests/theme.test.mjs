import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../web/js/theme.js', import.meta.url), 'utf8');
function setup(stored, blocked = false) {
  const attrs = {}, listeners = {};
  const button = { setAttribute(k,v) { attrs[k] = v; }, addEventListener(k,fn) { listeners[k] = fn; } };
  const root = { dataset: {} };
  const storageListeners = [];
  const storage = {
    getItem() { if(blocked) throw Error(); return stored; },
    setItem(k,v) { if(blocked) throw Error(); stored=v; },
  };
  let ready;
  vm.runInNewContext(source, {
    document: { documentElement: root, getElementById() { return button; }, addEventListener(k,fn) { ready = fn; } },
    localStorage: storage,
    globalThis: {
      addEventListener(k, fn) {
        if (k === "storage") storageListeners.push(fn);
      },
    },
  });
  return {
    root,
    attrs,
    ready: () => ready(),
    click: () => listeners.click(),
    stored: () => stored,
    storageEvent: (newValue) => {
      for (const listener of storageListeners) {
        listener({ key: "fast-pdf-viewer-theme", newValue, storageArea: storage });
      }
    },
  };
}
test('defaults dark before DOM ready and persists switching both ways', () => {
  const a=setup(null);
  assert.equal(a.root.dataset.theme,'dark');
  a.ready(); a.click();
  assert.equal(a.root.dataset.theme,'light');
  assert.equal(a.stored(),'light');
  assert.equal(a.attrs['aria-label'],'切换到暗色主题');
  a.click(); assert.equal(a.stored(),'dark');
});
test('restores light and ignores invalid stored values', () => {
  assert.equal(setup('light').root.dataset.theme,'light');
  assert.equal(setup('invalid').root.dataset.theme,'dark');
});
test('storage failures do not disable theme switching', () => {
  const a=setup(null,true); a.ready(); a.click();
  assert.equal(a.root.dataset.theme,'light');
});
test('syncs theme when another extension page updates localStorage', () => {
  const a = setup("dark");
  assert.equal(a.root.dataset.theme, "dark");
  a.storageEvent("light");
  assert.equal(a.root.dataset.theme, "light");
  assert.equal(a.attrs["aria-label"], "切换到暗色主题");
});
