import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function setup() {
  const elements = new Map(), timers = new Map();
  let timerId = 0, viewer, fileInput;
  const windowListeners = {};
  const revoked = [];
  let nextBlob = 0;
  function element() {
    const el = { value: '', textContent: '', children: [], options: [], listeners: {}, style: {}, toggles: {}, attrs: {}, dataset: {},
      hidden: false, disabled: false, title: '', inert: false,
      classList: { toggle(name, on) { el.toggles[name] = on; }, add() {}, remove() {},
        contains(name) { return Boolean(el.toggles[name]); } },
      addEventListener(name, fn) { this.listeners[name] = fn; }, replaceChildren() { this.children = []; },
      appendChild(child) { this.children.push(child); },
      append(...kids) { for (const kid of kids) this.appendChild(kid); },
      contains() { return false; }, focus() {}, select() {},
      closest() { return null; },
      getAttribute(name) { return this.attrs[name]; },
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute(name) { delete this.attrs[name]; },
      querySelector(sel) {
        const all = this.querySelectorAll(sel);
        return all[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (nodes) => {
          for (const node of nodes) {
            if (sel === '.outline-item' && node.className === 'outline-item') out.push(node);
            if (node.children?.length) walk(node.children);
          }
        };
        walk(this.children);
        return out;
      },
    };
    return el;
  }
  function get(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }
  const workspace = element();
  get('btn-sidebar');
  class Viewer {
    constructor(options = {}) {
      viewer = this; this.generation = 0; this.pageTexts = []; this.hitIndex = -1; this.shown = []; this.query = '';
      this.onIndex = options.onIndex;
    }
    close() { this.generation++; this.indexPromise = null; this.pageTexts = []; }
    async open(source) { this.close(); this.source = source; this.pageTexts = [{ pageNumber: 1, text: 'Alpha Beta' }]; this.pdf = { async getDestination(d) { return d; }, async getPageIndex() { return 0; } }; return this; }
    async getOutline() { return this.outlinePromise || null; }
    setZoom() {}
    bumpZoom() { return '150'; }
    clearHits() { this.shown.push(''); this.hitIndex = -1; this.query = ''; }
    async showHits(hits, query, index = 0, _options) { this.shown.push(query); this.hitIndex = hits.length ? index : -1; this.query = query; }
  }
  const context = vm.createContext({
    URL: { createObjectURL: () => `blob:test-${++nextBlob}`, revokeObjectURL: url => revoked.push(url) },
    console, fetch: async () => ({ ok: false }),
    document: {
      getElementById: get,
      createElement: tag => { const el = element(); if (tag === 'input') fileInput = el; return el; },
      createTextNode: text => ({ textContent: text }),
      body: element(),
      activeElement: null,
      querySelector: sel => (sel === '.workspace' ? workspace : null),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  const exports = {
    './viewer.js': { PdfViewer: Viewer },
    './history.js': { ViewHistory: class { onChange() {} } },
    './settings.js': { loadSettings: () => ({}), saveSettings: () => ({}) },
    './translate.js': { translateText() {}, MAX_TRANSLATE_CHARS: 4000 },
    './reading-position.js': {
      readingFingerprint: () => '',
      loadReadingPosition: () => null,
      saveReadingPosition: () => {},
    },
    './platform/index.js': {
      createPlatform: () => ({
        id: 'test',
        async startupOpen() { return null; },
        async pickFile() { return null; },
      }),
    },
    './model-picker.js': {
      wireModelPicker: () => ({ refresh() {}, hideMenu() {} }),
    },
  };
  const main = new vm.SourceTextModule(await readFile(new URL('../web/js/main.js', import.meta.url), 'utf8'), { context });
  await main.link(async spec => {
    if (
      spec === './search.js' ||
      spec === './translate-bubble-placement.js' ||
      spec === './selection-anchor.js' ||
      spec === './selection-text.js' ||
      spec === './bubble-text-render.js' ||
      spec === './translate-provider.js'
    ) {
      return new vm.SourceTextModule(await readFile(new URL(`../web/js/${spec.slice(2)}`, import.meta.url), 'utf8'), { context });
    }
    if (spec.includes('vendor/pdfjs')) {
      return new vm.SyntheticModule(['PasswordResponses'], function () {
        this.setExport('PasswordResponses', { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 });
      }, { context });
    }
    return new vm.SyntheticModule(Object.keys(exports[spec]), function () {
      for (const [key, value] of Object.entries(exports[spec])) this.setExport(key, value);
    }, { context });
  });
  await main.evaluate();
  // Mirror shipped empty-state chrome: em-dash page readout until a doc opens.
  get('page-input').value = '—';
  get('page-count').textContent = '—';
  return { viewer, get, fileInput, revoked,
    dispatch(type, event) { for (const fn of windowListeners[type] || []) fn(event); },
    input(value) { const el = get('search-input'); el.value = value; el.listeners.input({ target: el }); },
    runTimer() { const [id, fn] = [...timers].at(-1); timers.delete(id); return fn(); },
    click(id) { const el = get(id); el.listeners.click?.({ target: el, preventDefault() {}, stopPropagation() {} }); },
  };
}

test('queries show available results without waiting for full indexing', async () => {
  const app = await setup(), waiting = deferred();
  app.viewer.indexPromise = waiting.promise;
  app.viewer.pageTexts = [{ pageNumber: 1, text: 'Alpha Beta' }];
  app.input('Alpha'); const a = app.runTimer();
  app.input('Beta'); const b = app.runTimer();
  waiting.resolve(); await Promise.all([a, b]);
  assert.deepEqual(app.viewer.shown, ['', 'Alpha', '', 'Beta']);
  assert.equal(app.get('search-count').textContent, '1 / 1');
});

test('file loading uses revocable blob URLs without reading entire files', async () => {
  const app = await setup(), waiting = deferred();
  app.fileInput.files = [{ name: 'A', arrayBuffer: () => waiting.promise }];
  const a = app.fileInput.listeners.change();
  app.fileInput.files = [{ name: 'B', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  waiting.resolve(new ArrayBuffer(0)); await a;
  assert.equal(app.viewer.source.name, 'B');
  assert.equal(app.viewer.source.url, 'blob:test-2');
  assert.deepEqual(app.revoked, ['blob:test-1']);
});

test('late empty outline does not leave an active search sidebar', async () => {
  const app = await setup(), waiting = deferred();
  app.viewer.outlinePromise = waiting.promise;
  app.fileInput.files = [{ name: 'A', arrayBuffer: async () => new ArrayBuffer(0) }];
  const opening = app.fileInput.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  app.click('sidebar-tab-search');
  assert.equal(app.get('search-pane').toggles.active, true);
  waiting.resolve([]);
  await opening;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('search-pane').toggles.active, true);
  assert.equal(app.get('outline-pane').toggles.active, false);
});

test('late outline response cannot overwrite a newer document outline', async () => {
  const app = await setup(), waiting = deferred();
  app.viewer.outlinePromise = waiting.promise;
  app.fileInput.files = [{ name: 'A', arrayBuffer: async () => new ArrayBuffer(0) }];
  const a = app.fileInput.listeners.change();
  // Let A reach getOutline before starting B.
  await new Promise(resolve => setImmediate(resolve));
  app.viewer.outlinePromise = Promise.resolve([{ title: 'B outline', dest: 1 }]);
  app.fileInput.files = [{ name: 'B', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  waiting.resolve([{ title: 'A outline', dest: 1 }]); await a;
  assert.equal(app.get('outline-pane').querySelector('.outline-item')?.textContent, 'B outline');
});


test('one physical side-button release navigates exactly once', async () => {
  const app = await setup();
  const calls = [];
  app.viewer.back = () => calls.push('back');
  app.viewer.forward = () => calls.push('forward');
  for (const button of [3, 4, 3]) {
    for (const type of ['mousedown', 'pointerup', 'mouseup', 'auxclick']) {
      let prevented = false;
      app.dispatch(type, { button, preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    }
  }
  assert.deepEqual(calls, ['back', 'forward', 'back']);
});

test('primary and middle clicks keep their default behavior', async () => {
  const app = await setup();
  app.viewer.back = app.viewer.forward = () => assert.fail('unexpected navigation');
  for (const button of [0, 1, 2]) {
    for (const type of ['mousedown', 'pointerup', 'mouseup', 'auxclick']) {
      app.dispatch(type, { button, preventDefault() { assert.fail('unexpected prevention'); } });
    }
  }
});

test('indexing refresh does not switch the sidebar to search', async () => {
  const app = await setup();
  app.viewer.pageTexts = [{ pageNumber: 1, text: 'Alpha Beta' }];
  app.viewer.query = 'Alpha';
  app.get('search-input').value = 'Alpha';
  app.viewer.onIndex();
  app.runTimer();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.viewer.shown, ['Alpha']);
  assert.equal(app.get('search-count').textContent, '1 / 1');
  assert.equal(app.get('search-pane').toggles.active, false);
  assert.equal(app.get('outline-pane').toggles.active, true);
});

test('user search still selects the search sidebar tab', async () => {
  const app = await setup();
  app.viewer.pageTexts = [{ pageNumber: 1, text: 'Alpha Beta' }];
  app.input('Alpha');
  await app.runTimer();
  assert.equal(app.get('search-pane').toggles.active, true);
  assert.equal(app.get('outline-pane').toggles.active, false);
});

test('outline entry with numeric dest 0 maps to page 1', async () => {
  const app = await setup();
  app.viewer.pdf = {
    async getDestination(dest) {
      return dest;
    },
    async getPageIndex(ref) {
      return ref;
    },
  };
  app.viewer.outlinePromise = Promise.resolve([{ title: 'Cover', dest: [0, 'XYZ', null, null] }]);
  app.fileInput.files = [{ name: 'doc.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const item = app.get('outline-pane').querySelector('.outline-item');
  assert.equal(item?.dataset.page, '1');
});

test('目录 always returns to outline without clearing the search query', async () => {
  const app = await setup();
  app.viewer.pageTexts = [{ pageNumber: 1, text: 'Alpha Beta' }];
  app.input('Alpha');
  await app.runTimer();
  assert.equal(app.get('search-pane').toggles.active, true);
  // 目录 opens outline even with a live query; query persists for return.
  app.click('btn-sidebar');
  assert.equal(app.get('outline-pane').toggles.active, true);
  assert.equal(app.get('search-pane').toggles.active, false);
  assert.equal(app.get('search-input').value, 'Alpha');
  // Sidebar tabs flip back to the preserved search mode.
  app.click('sidebar-tab-search');
  assert.equal(app.get('search-pane').toggles.active, true);
  assert.equal(app.get('search-input').value, 'Alpha');
});

test('collapsed sidebar leaves the tab order via inert', async () => {
  const app = await setup();
  const sidebar = app.get('sidebar');
  assert.equal(sidebar.attrs['aria-hidden'], 'true');
  assert.equal(sidebar.inert, true);
  app.click('btn-sidebar');
  assert.equal(sidebar.attrs['aria-hidden'], 'false');
  assert.equal(sidebar.inert, false);
  // Outline-open 目录 toggles the panel shut again.
  app.click('btn-sidebar');
  assert.equal(sidebar.attrs['aria-hidden'], 'true');
  assert.equal(sidebar.inert, true);
});

test('open failure surfaces in the viewer with a reselect action', async () => {
  const app = await setup();
  app.viewer.open = async () => { throw new Error('bad pdf'); };
  app.fileInput.files = [{ name: 'broken.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.get('viewer-status').hidden, false);
  assert.match(app.get('viewer-status-text').textContent, /打开失败/);
  assert.equal(app.get('viewer-status-action').hidden, false);
  // Unopened document keeps the em-dash page readout, not 1 / 0.
  assert.equal(app.get('page-input').value, '—');
  assert.equal(app.get('page-count').textContent, '—');
});
