import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function setup({ platform = 'Linux x86_64', startup = null,
  requestHostAccess = async () => true, saveSettings = () => ({}),
  loadSettings = () => ({}), initSettings = async () => {},
  platformId = 'test', canFallbackToBrowser = undefined,
  clearBrowserFallback = undefined,
  chrome = undefined, localStorageStore = new Map(), clipboardWrite = async () => {} } = {}) {
  const elements = new Map(), timers = new Map(), documentListeners = {};
  let currentSelection = { rangeCount: 0 };
  let timerId = 0, viewer, fileInput;
  const windowListeners = {};
  const revoked = [];
  let nextBlob = 0;
  const documentElement = element();
  documentElement.style.setProperty = (name, value) => { documentElement.style[name] = value; };
  documentElement.style.getPropertyValue = name => documentElement.style[name] || '';
  function element() {
    const el = { value: '', textContent: '', children: [], options: [], listeners: {}, style: {}, toggles: {}, attrs: {}, dataset: {},
      hidden: false, disabled: false, title: '', inert: false, tabIndex: 0,
      offsetWidth: 320, offsetHeight: 180,
      classList: { toggle(name, on) { el.toggles[name] = on; }, add() {}, remove() {},
        contains(name) { return Boolean(el.toggles[name]); } },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      removeEventListener() {},
      replaceChildren() { this.children = []; },
      appendChild(child) { this.children.push(child); },
      append(...kids) { for (const kid of kids) this.appendChild(kid); },
      contains() { return false; }, focus() {}, select() {},
      getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
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
        const parts = String(sel).split(',').map((part) => part.trim());
        const walk = (nodes) => {
          for (const node of nodes) {
            for (const part of parts) {
              if (part.startsWith('.')) {
                const cls = part.slice(1);
                if (String(node.className || '').split(/\s+/).includes(cls)) out.push(node);
              } else if (part === 'button' && String(node.tagName || '').toUpperCase() === 'BUTTON') {
                out.push(node);
              } else if (part.startsWith('input') && String(node.tagName || '').toUpperCase() === 'INPUT') {
                out.push(node);
              }
            }
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
      this.onState = options.onState;
      this.onPassword = options.onPassword;
    }
    close() { this.generation++; this.indexPromise = null; this.pageTexts = []; }
    async open(source) {
      this.close();
      this.source = source;
      this.name = source.name;
      this.pageTexts = [{ pageNumber: 1, text: 'Alpha Beta' }];
      this.pdf = { async getDestination(d) { return d; }, async getPageIndex() { return 0; } };
      this.pageCount = 5;
      this.onState?.({});
      return this;
    }
    async getOutline() { return this.outlinePromise || null; }
    getReadingPoint() { return { page: this.currentPage || 1, pdfY: this.readingPdfY }; }
    async goToDest() {}
    setZoom(mode, options) { (this.zoomCalls ||= []).push({ mode, options }); }
    bumpZoom() { return '150'; }
    clearHits() { this.shown.push(''); this.hitIndex = -1; this.query = ''; }
    async showHits(hits, query, index = 0, _options) { this.shown.push(query); this.hitIndex = hits.length ? index : -1; this.query = query; }
  }
  const context = vm.createContext({
    URL: { createObjectURL: () => `blob:test-${++nextBlob}`, revokeObjectURL: url => revoked.push(url) },
    console, fetch: async () => ({ ok: false }),
    document: {
      title: 'Fast PDF Viewer – AI Translation',
      getElementById: get,
      createElement: tag => {
        const el = element();
        el.tagName = String(tag || '').toUpperCase();
        if (tag === 'input') fileInput = el;
        return el;
      },
      createTextNode: text => ({ textContent: text }),
      body: element(),
      documentElement,
      activeElement: null,
      querySelector: sel => (sel === '.workspace' ? workspace : null),
      querySelectorAll: () => [],
      addEventListener(name, fn) { (documentListeners[name] ||= []).push(fn); },
    },
    window: {
      innerWidth: 1280,
      addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
      getSelection() { return currentSelection; },
    },
    localStorage: {
      getItem(key) { return localStorageStore.has(key) ? localStorageStore.get(key) : null; },
      setItem(key, value) { localStorageStore.set(key, String(value)); },
    },
    navigator: {
      platform,
      userAgent: /Mac|iPhone|iPad/i.test(platform) ? 'Mozilla/5.0 (Macintosh)' : 'Mozilla/5.0 (X11; Linux x86_64)',
      clipboard: { writeText: clipboardWrite },
    },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { return ++timerId; }, cancelAnimationFrame() {},
    chrome,
  });
  const exports = {
    './viewer.js': { PdfViewer: Viewer },
    './history.js': { ViewHistory: class { onChange() {} canBack() { return false; } canForward() { return false; } } },
    './settings.js': { loadSettings, saveSettings, initSettings },
    './platform/extension.js': { requestHostAccess, fallbackToBrowser: async () => {} },
    './translate.js': { translateText() {}, MAX_TRANSLATE_CHARS: 4000 },
    './reading-position.js': {
      readingFingerprint: () => '',
      loadReadingPosition: () => null,
      saveReadingPosition: () => {},
    },
    './platform/index.js': {
      createPlatform: () => ({
        id: platformId,
        async startupOpen() { return typeof startup === 'function' ? startup() : startup; },
        async pickFile() { return null; },
        ...(canFallbackToBrowser !== undefined ? { canFallbackToBrowser } : {}),
        ...(clearBrowserFallback !== undefined ? { clearBrowserFallback } : {}),
      }),
    },
    './model-picker.js': {
      wireModelPicker: () => ({ refresh() {}, hideMenu() {}, invalidatePending() {} }),
    },
  };
  const main = new vm.SourceTextModule(await readFile(new URL('../web/js/main.js', import.meta.url), 'utf8'), { context });
  await main.link(async spec => {
    if (
      spec === './search.js' ||
      spec === './outline-active.js' ||
      spec === './translate-bubble-placement.js' ||
      spec === './selection-anchor.js' ||
      spec === './selection-text.js' ||
      spec === './bubble-text-render.js' ||
      spec === './translate-provider.js' ||
      spec === './i18n.js'
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
  get('translate-bubble').hidden = true;
  get('settings-modal').hidden = true;
  get('pdf-password-modal').hidden = true;
  get('zoom-menu').hidden = true;
  get('btn-original-pdf').hidden = true;
  return { viewer, get, fileInput, revoked, document: context.document, localStorageStore,
    setSelection(selection) { currentSelection = selection; },
    dispatch(type, event) { for (const fn of windowListeners[type] || []) fn(event); },
    dispatchDocument(type, event) { for (const fn of documentListeners[type] || []) fn(event); },
    dispatchElement(id, type, event) { get(id).listeners[type]?.(event); },
    setViewportWidth(width) { context.window.innerWidth = width; },
    input(value) { const el = get('search-input'); el.value = value; el.listeners.input({ target: el }); },
    runTimer() { const [id, fn] = [...timers].at(-1); timers.delete(id); return fn(); },
    click(id) { const el = get(id); el.listeners.click?.({ target: el, preventDefault() {}, stopPropagation() {} }); },
  };
}

test('tab title matches the open document name', async () => {
  const app = await setup({
    startup: {
      data: new Uint8Array([37, 80, 68, 70]),
      name: '1706.03762',
      path: 'https://arxiv.org/pdf/1706.03762',
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.title, '1706.03762');
});

test('startup forwards MIME bytes and legacy credentials through the real reader entry', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const app = await setup({ startup: { data: bytes, name: 'paper.pdf', path: 'https://example.org/paper.pdf', withCredentials: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.viewer.source.data, bytes);
  assert.equal(app.viewer.source.path, 'https://example.org/paper.pdf');
  assert.equal(app.viewer.source.withCredentials, true);
});

test('pinned translation bubble survives outside clicks and closes on request', async () => {
  const app = await setup();
  const bubble = app.get('translate-bubble');
  const pin = app.get('btn-bubble-pin');
  const outside = { closest() { return null; } };
  bubble.hidden = false;

  app.click('btn-bubble-pin');
  assert.equal(pin.attrs['aria-pressed'], 'true');
  assert.equal(pin.title, '取消固定翻译窗');

  app.dispatchDocument('pointerdown', { target: outside });
  app.dispatchDocument('mouseup', { target: outside });
  assert.equal(bubble.hidden, false);

  app.click('btn-bubble-close');
  assert.equal(bubble.hidden, true);
  assert.equal(pin.attrs['aria-pressed'], 'false');
});

test('copy button shows a temporary success check only after writing to clipboard', async () => {
  const copied = [];
  const app = await setup({ clipboardWrite: async text => copied.push(text) });
  app.get('translate-result').textContent = '翻译结果';
  const button = app.get('btn-copy');

  await button.listeners.click();
  assert.deepEqual(copied, ['翻译结果']);
  assert.equal(button.dataset.copyState, 'success');
  assert.equal(button.title, '已复制');
  assert.equal(button.attrs['aria-label'], '已复制');
  assert.equal(app.get('copy-status').textContent, '翻译结果已复制到剪贴板');

  app.runTimer();
  assert.equal(button.dataset.copyState, 'idle');
  assert.equal(button.title, '复制翻译结果');
  assert.equal(app.get('copy-status').textContent, '');
});

test('copy button reports a rejected clipboard write as an error', async () => {
  const app = await setup({ clipboardWrite: async () => { throw new Error('not allowed'); } });
  app.get('translate-result').textContent = '翻译结果';
  const button = app.get('btn-copy');

  await button.listeners.click();
  assert.equal(button.dataset.copyState, 'error');
  assert.equal(button.title, '复制失败');
  assert.equal(app.get('copy-status').textContent, '复制失败，请检查浏览器剪贴板权限');
});

test('clearing a selection hides its translate chip while keeping a pinned bubble open', async () => {
  const app = await setup();
  const bubble = app.get('translate-bubble');
  const chip = app.get('translate-chip');
  bubble.hidden = false;
  app.click('btn-bubble-pin');
  chip.hidden = false;

  const textLayer = { closest(selector) { return selector === '.textLayer' ? this : null; } };
  app.setSelection({ rangeCount: 0 });
  app.dispatchDocument('mouseup', { target: textLayer });
  assert.equal(chip.hidden, true);
  assert.equal(bubble.hidden, false);

  chip.hidden = false;
  const outside = { closest() { return null; } };
  app.dispatchDocument('mouseup', { target: outside });
  assert.equal(chip.hidden, true);
  assert.equal(bubble.hidden, false);
});

test('dragging the translation bubble moves it without pinning and still allows outside close', async () => {
  const app = await setup();
  const bubble = app.get('translate-bubble');
  const header = app.get('bubble-header');
  const handle = app.get('bubble-drag-handle');
  bubble.hidden = false;
  bubble.style.left = '100px';
  bubble.style.top = '120px';
  const event = (values = {}) => ({
    button: 0,
    pointerId: 3,
    clientX: 120,
    clientY: 130,
    preventDefault() {},
    stopPropagation() {},
    ...values,
  });

  header.listeners.pointerdown(event({ target: { closest: selector => selector === 'button' ? {} : null } }));
  assert.equal(bubble.classList.contains('is-dragging'), false);

  header.listeners.pointerdown(event());
  assert.equal(app.get('btn-bubble-pin').attrs['aria-pressed'], 'false');
  header.listeners.pointermove(event({ clientX: 180, clientY: 210 }));
  assert.equal(bubble.style.left, '160px');
  assert.equal(bubble.style.top, '200px');
  header.listeners.pointerup(event());
  assert.equal(bubble.classList.contains('is-dragging'), false);

  bubble.style.left = '470px';
  bubble.style.top = '510px';
  handle.listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(bubble.style.left, '472px');
  assert.equal(bubble.style.top, '510px');
  assert.equal(app.get('btn-bubble-pin').attrs['aria-pressed'], 'false');

  const outside = { closest() { return null; } };
  app.dispatchDocument('pointerdown', { target: outside });
  assert.equal(bubble.hidden, true);
});

test('boot reloads settings after initSettings', async () => {
  const afterInit = [];
  let ready = false;
  await setup({
    loadSettings() {
      afterInit.push(ready);
      return {};
    },
    async initSettings() {
      ready = true;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(afterInit.at(-1), true);
});

test('denied translation host access leaves settings open and never saves credentials', async () => {
  let saved = false;
  const app = await setup({ requestHostAccess: async () => false, saveSettings() { saved = true; } });
  app.get('settings-modal').hidden = false;
  app.get('setting-key').value = 'test-only';
  app.get('setting-base').value = 'https://example.org/v1';
  await app.get('btn-settings-save').listeners.click();
  assert.equal(saved, false);
  assert.equal(app.get('settings-modal').hidden, false);
  assert.equal(app.get('settings-error').hidden, false);
  assert.equal(app.get('btn-settings-save').disabled, false);
});

test('search entry, outline switch and Escape preserve query and synchronize button', async () => {
  const app = await setup();
  app.click('btn-search-toggle');
  assert.equal(app.get('sidebar').inert, false);
  assert.equal(app.get('sidebar-tab-search').attrs['aria-selected'], 'true');
  assert.equal(app.get('btn-search-toggle').attrs['aria-expanded'], 'true');
  app.get('search-input').value = 'manual';
  app.click('btn-sidebar');
  assert.equal(app.get('btn-search-toggle').attrs['aria-expanded'], 'false');
  app.click('btn-search-toggle');
  await app.get('search-input').listeners.keydown({key:'Escape',preventDefault(){},stopPropagation(){}});
  assert.equal(app.get('sidebar').inert, true);
  assert.equal(app.get('btn-search-toggle').attrs['aria-expanded'], 'false');
  assert.equal(app.get('search-input').value, 'manual');
});

test('Escape closes search when focus is on a hit, not the search box', async () => {
  const app = await setup();
  app.click('btn-search-toggle');
  app.get('search-input').value = 'manual';
  app.dispatch('keydown', {
    key: 'Escape',
    target: { matches() { return false; } },
    preventDefault() {},
  });
  assert.equal(app.get('sidebar').inert, true);
  assert.equal(app.get('btn-search-toggle').attrs['aria-expanded'], 'false');
  assert.equal(app.get('search-input').value, 'manual');
});

test('Escape on the zoom menu closes only the menu while search stays open', async () => {
  const app = await setup();
  app.click('btn-search-toggle');
  app.click('zoom-button');
  assert.equal(app.get('zoom-menu').hidden, false);
  assert.equal(app.get('sidebar').inert, false);
  const event = {
    key: 'Escape',
    preventDefault() {},
    stopPropagation() { this.stopped = true; },
  };
  app.get('zoom-menu').listeners.keydown(event);
  if (!event.stopped) app.dispatch('keydown', event);
  assert.equal(app.get('zoom-menu').hidden, true);
  assert.equal(app.get('sidebar').inert, false);
  assert.equal(app.get('btn-search-toggle').attrs['aria-expanded'], 'true');
});

test('ArrowDown in the sidebar does not step the PDF page', async () => {
  const app = await setup();
  const jumps = [];
  app.viewer.pageCount = 10;
  app.viewer.currentPage = 3;
  app.viewer.goToPage = (page) => { jumps.push(page); app.viewer.currentPage = page; };
  app.dispatch('keydown', {
    key: 'ArrowDown',
    target: {
      matches() { return false; },
      closest(sel) { return String(sel).includes('#sidebar') ? {} : null; },
    },
    preventDefault() {},
  });
  assert.deepEqual(jumps, []);
});

test('typing a query does not flash the empty-keyword search copy', async () => {
  const app = await setup();
  app.click('btn-search-toggle');
  app.input('Alpha');
  assert.equal(String(app.get('search-list').innerHTML || '').includes('输入关键词'), false);
});

test('empty-state zoom does not skip first-open page-width fit', async () => {
  const app = await setup();
  const zooms = [];
  app.viewer.setZoom = (mode) => { zooms.push(mode); };
  app.click('btn-zoom-in');
  app.fileInput.files = [{ name: 'A.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  assert.equal(zooms.includes('page-width'), true);
});

test('a zoom change on an open document is kept for the next unsaved file', async () => {
  const app = await setup();
  const zooms = [];
  app.viewer.setZoom = (mode) => { zooms.push(mode); };
  app.fileInput.files = [{ name: 'A.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  zooms.length = 0;
  app.click('btn-zoom-in');
  app.fileInput.files = [{ name: 'B.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  assert.equal(zooms.includes('page-width'), false);
});

test('password dialog Escape cancels from the dialog chrome', async () => {
  const app = await setup();
  const pending = app.viewer.onPassword(1);
  assert.equal(app.get('pdf-password-modal').hidden, false);
  assert.equal(app.get('app').attrs.inert, '');
  app.get('pdf-password-modal').listeners.keydown({
    key: 'Escape',
    preventDefault() {},
    stopPropagation() {},
  });
  await assert.rejects(pending, /已取消输入密码/);
  assert.equal(app.get('pdf-password-modal').hidden, true);
  assert.equal(app.get('app').attrs.inert, undefined);
});

test('shortcut labels use Ctrl on Linux and Cmd on Mac', async () => {
  const linux = await setup();
  assert.match(linux.get('btn-open').title, /Ctrl\+O/);
  assert.equal(linux.get('empty-shortcut').textContent, 'Ctrl+O');
  assert.match(linux.get('btn-search-toggle').title, /Ctrl\+F/);
  const mac = await setup({ platform: 'MacIntel' });
  assert.match(mac.get('btn-open').title, /Cmd\+O/);
  assert.equal(mac.get('empty-shortcut').textContent, 'Cmd+O');
  assert.match(mac.get('btn-search-toggle').title, /Cmd\+F/);
  assert.match(mac.get('btn-zoom-in').title, /Cmd\+=/);
});

test('page input arrows immediately navigate like reading shortcuts, including bounds', async () => {
  const app = await setup();
  const input = app.get('page-input');
  input.disabled = false;
  app.viewer.pageCount = 779;
  app.viewer.currentPage = 644;
  const jumps = [];
  app.viewer.goToPage = page => { jumps.push(page); app.viewer.currentPage = page; };
  const key = key => input.listeners.keydown({key,target:input,preventDefault(){},stopPropagation(){}});
  input.value = '644';
  key('ArrowDown'); assert.equal(input.value, '645');
  key('ArrowUp'); assert.equal(input.value, '644');
  assert.deepEqual(jumps, [645, 644]);
  input.value = '700'; key('Enter'); assert.equal(app.viewer.currentPage, 700);
  input.value = '12'; key('ArrowDown'); assert.equal(input.value, '701');
  app.viewer.currentPage = 779; key('ArrowDown'); assert.equal(input.value, '779');
  app.viewer.currentPage = 1; key('ArrowUp'); assert.equal(input.value, '1');
  assert.deepEqual(jumps, [645, 644, 700, 701]);
});

test('Enter follows the active search result inside its own scroller, including result batches', async () => {
  const app = await setup();
  const list = app.get('search-list');
  list.scrollTop = 0;
  list.getBoundingClientRect = () => ({top: 0, bottom: 100});
  const append = list.appendChild.bind(list);
  list.appendChild = child => {
    append(child);
    child.getBoundingClientRect = () => {
      const top = list.children.indexOf(child) * 30 - list.scrollTop;
      return {top, bottom: top + 30};
    };
  };
  app.viewer.jumpToHit = async index => { app.viewer.hitIndex = index; };
  app.viewer.pageTexts = [{pageNumber: 1, text: 'needle '.repeat(260)}];
  app.click('btn-search-toggle');
  app.input('needle'); await app.runTimer();
  const enter = async shiftKey => app.get('search-input').listeners.keydown({key:'Enter', shiftKey, preventDefault(){}});
  for (let i = 0; i < 220; i++) await enter(false);
  const active = () => list.children.find(el => el.className?.includes(' active')).getBoundingClientRect();
  assert.equal(app.viewer.hitIndex, 220);
  assert.ok(list.scrollTop > 0);
  assert.ok(active().top >= 0 && active().bottom <= 100);
  for (let i = 0; i < 220; i++) await enter(true);
  assert.equal(app.viewer.hitIndex, 0);
  assert.ok(active().top >= 0 && active().bottom <= 100);
});

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

test('sidebar width can be dragged, persists, and stays the same when toggled', async () => {
  const app = await setup();
  const handle = app.get('sidebar-resize-handle');
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '272px');
  assert.equal(handle.attrs.role, 'separator');
  assert.equal(handle.attrs['aria-valuemin'], '272');

  app.click('btn-sidebar');
  app.viewer.pdf = {};
  app.viewer.zoomMode = 'page-width';
  app.viewer.zoomCalls = [];
  app.dispatchElement('sidebar-resize-handle', 'pointerdown', {
    button: 0, isPrimary: true, pointerId: 1, clientX: 272, preventDefault() {},
  });
  app.dispatchElement('sidebar-resize-handle', 'pointermove', { pointerId: 1, clientX: 400 });
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '400px');
  assert.equal(handle.attrs['aria-valuenow'], '400');
  assert.equal(app.viewer.zoomCalls.length, 0);
  app.dispatchElement('sidebar-resize-handle', 'pointerup', { pointerId: 1 });
  assert.equal(app.viewer.zoomCalls.length, 1);
  assert.equal(app.viewer.zoomCalls[0].mode, 'page-width');
  assert.equal(app.viewer.zoomCalls[0].options.silent, true);
  assert.equal(app.localStorageStore.get('fast-pdf-viewer-sidebar-width-v1'), '400');

  app.click('btn-sidebar');
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '400px');
  app.click('btn-sidebar');
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '400px');

  const reopened = await setup({ localStorageStore: app.localStorageStore });
  assert.equal(reopened.document.documentElement.style.getPropertyValue('--sidebar-w'), '400px');
});

test('sidebar keyboard resizing respects width limits and viewport changes', async () => {
  const store = new Map([['fast-pdf-viewer-sidebar-width-v1', '460']]);
  const app = await setup({ localStorageStore: store });
  const handle = app.get('sidebar-resize-handle');
  app.viewer.pdf = {};
  app.viewer.zoomMode = 'page-width';
  app.viewer.zoomCalls = [];
  const keydown = (key, shiftKey = false) => app.dispatchElement('sidebar-resize-handle', 'keydown', {
    key, shiftKey, preventDefault() {},
  });

  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '460px');
  app.setViewportWidth(360);
  app.dispatch('resize', {});
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '336px');
  assert.equal(store.get('fast-pdf-viewer-sidebar-width-v1'), '460');

  app.click('btn-sidebar');
  app.dispatchElement('sidebar-resize-handle', 'pointerdown', {
    button: 0, isPrimary: true, pointerId: 2, clientX: 336, preventDefault() {},
  });
  app.dispatchElement('sidebar-resize-handle', 'pointerup', { pointerId: 2 });
  assert.equal(store.get('fast-pdf-viewer-sidebar-width-v1'), '460');

  app.setViewportWidth(1280);
  app.dispatch('resize', {});
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '460px');
  app.runTimer();
  assert.equal(app.viewer.zoomCalls.at(-1).mode, 'page-width');

  keydown('End');
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '480px');
  keydown('ArrowLeft', true);
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '432px');
  keydown('Home');
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '272px');
  assert.equal(store.get('fast-pdf-viewer-sidebar-width-v1'), '272');
});

test('collapsed sidebar removes focusable controls from tab order', async () => {
  const app = await setup();
  const sidebar = app.get('sidebar');
  const tab = app.get('sidebar-tab-outline');
  tab.tagName = 'BUTTON';
  sidebar.children.push(tab);
  app.click('btn-sidebar');
  app.click('btn-sidebar');
  assert.equal(tab.tabIndex, -1);
  assert.equal(tab.attrs['aria-hidden'], 'true');
});

test('outline renders as a one-line tree with disclosure state', async () => {
  const app = await setup();
  app.viewer.pdf = {
    async getDestination(dest) {
      return dest;
    },
    async getPageIndex(ref) {
      return ref;
    },
  };
  // Current page sits on the deep child: its ancestor chain must expand.
  app.viewer.currentPage = 12;
  const longTitle = '5.4.2.4. Z Classification Norm with a very long heading that must not wrap';
  app.viewer.outlinePromise = Promise.resolve([
    { title: 'Chapter 5', dest: [0, 'XYZ', null, null], items: [
      { title: longTitle, dest: [10, 'XYZ', null, null], items: [
        { title: 'Deep child', dest: [11, 'XYZ', null, null] },
      ] },
      { title: 'Sibling leaf', dest: [12, 'XYZ', null, null] },
    ] },
  ]);
  app.fileInput.files = [{ name: 'doc.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const pane = app.get('outline-pane');
  assert.equal(pane.attrs.role, 'tree');
  const nodes = pane.querySelectorAll('.outline-node');
  assert.equal(nodes.length, 4);
  assert.deepEqual(
    nodes.map((node) => node.attrs['aria-level']),
    ['1', '2', '3', '2'],
  );
  for (const node of nodes) assert.equal(node.attrs.role, 'treeitem');
  const groups = pane.querySelectorAll('.outline-branch');
  assert.equal(groups.length, 2);
  for (const group of groups) assert.equal(group.attrs.role, 'group');
  // Long headings stay on one line: full text in title, no wrapping span.
  const longBtn = pane.querySelectorAll('.outline-item').find((btn) => btn.textContent === longTitle);
  assert.ok(longBtn);
  assert.equal(longBtn.title, longTitle);
  // Parents expose disclosure state; leaves reserve alignment space instead.
  const parentToggle = nodes[1].querySelector('.outline-toggle');
  assert.equal(parentToggle.attrs['aria-expanded'], 'true');
  assert.equal(nodes[1].attrs['aria-expanded'], 'true');
  const leafToggle = nodes[2].querySelector('.outline-toggle');
  assert.equal(leafToggle.attrs['aria-hidden'], 'true');
  assert.equal(leafToggle.attrs['aria-expanded'], undefined);
  // Off-path branches stay collapsed; the active deep child highlights.
  assert.equal(nodes[3].attrs['aria-expanded'], undefined);
  const deepBtn = nodes[2].querySelector('.outline-item');
  assert.equal(deepBtn.toggles.active, true);
  assert.equal(deepBtn.attrs['aria-current'], 'true');
});

test('same-page outline headings highlight the dest at the reading Y, not the last sibling', async () => {
  const app = await setup();
  app.viewer.currentPage = 11;
  app.viewer.readingPdfY = 700;
  app.viewer.outlinePromise = Promise.resolve([
    { title: '1.1 Precautions', dest: [10, 'XYZ', 0, 700, null] },
    { title: '1.2 Emergency', dest: [10, 'XYZ', 0, 500, null] },
    { title: '1.3 Overview', dest: [10, 'XYZ', 0, 300, null] },
  ]);
  app.fileInput.files = [{ name: 'doc.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const items = app.get('outline-pane').querySelectorAll('.outline-item');
  assert.equal(items[0].textContent, '1.1 Precautions');
  assert.equal(items[0].toggles.active, true);
  assert.equal(items[2].toggles.active, false);
  app.viewer.readingPdfY = 300;
  app.viewer.onState({ page: 11, zoom: 150 });
  assert.equal(items[0].toggles.active, false);
  assert.equal(items[2].toggles.active, true);
});

test('outline expand-all and collapse-all controls disclosure state', async () => {
  const app = await setup();
  app.viewer.pdf = {
    async getDestination(dest) {
      return dest;
    },
    async getPageIndex(ref) {
      return ref;
    },
  };
  app.viewer.currentPage = 12;
  app.viewer.outlinePromise = Promise.resolve([
    { title: 'Chapter 5', dest: [0, 'XYZ', null, null], items: [
      { title: 'Section', dest: [10, 'XYZ', null, null], items: [
        { title: 'Deep', dest: [11, 'XYZ', null, null] },
      ] },
      { title: 'Sibling', dest: [12, 'XYZ', null, null] },
    ] },
  ]);
  app.fileInput.files = [{ name: 'doc.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const actions = app.get('outline-tree-actions');
  assert.equal(actions.hidden, false);
  const pane = app.get('outline-pane');
  const expandBtn = app.get('btn-outline-expand-all');
  const collapseBtn = app.get('btn-outline-collapse-all');
  assert.equal(expandBtn.title, '全部展开');
  assert.equal(expandBtn.attrs['aria-label'], '全部展开');
  assert.equal(collapseBtn.title, '全部折叠');
  assert.equal(collapseBtn.attrs['aria-label'], '全部折叠');
  app.click('btn-outline-collapse-all');
  const nodes = pane.querySelectorAll('.outline-node');
  for (const node of nodes) {
    const toggle = node.querySelector('.outline-toggle');
    if (toggle.attrs['aria-hidden'] === 'true') continue;
    assert.equal(toggle.attrs['aria-expanded'], 'false');
  }
  // Page follow must not re-open branches after an explicit collapse-all.
  app.viewer.currentPage = 12;
  app.viewer.onState({ page: 12, zoom: 150 });
  assert.equal(nodes[0].querySelector('.outline-toggle').attrs['aria-expanded'], 'false');
  assert.equal(nodes[1].querySelector('.outline-toggle').attrs['aria-expanded'], 'false');
  app.click('btn-outline-expand-all');
  for (const node of nodes) {
    const toggle = node.querySelector('.outline-toggle');
    if (toggle.attrs['aria-hidden'] === 'true') continue;
    assert.equal(toggle.attrs['aria-expanded'], 'true');
  }
  app.click('sidebar-tab-search');
  assert.equal(actions.hidden, true);
});

test('outline toggle expands and collapses its branch', async () => {
  const app = await setup();
  app.viewer.pdf = {
    async getDestination(dest) {
      return dest;
    },
    async getPageIndex(ref) {
      return ref;
    },
  };
  app.viewer.outlinePromise = Promise.resolve([
    { title: 'Chapter 5', dest: [0, 'XYZ', null, null], items: [
      { title: 'Child', dest: [1, 'XYZ', null, null] },
    ] },
  ]);
  app.fileInput.files = [{ name: 'doc.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const node = app.get('outline-pane').querySelectorAll('.outline-node')[0];
  const toggle = node.querySelector('.outline-toggle');
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  toggle.listeners.click({ stopPropagation() {} });
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(node.attrs['aria-expanded'], 'false');
  toggle.listeners.click({ stopPropagation() {} });
  assert.equal(toggle.attrs['aria-expanded'], 'true');
});

test('lone destination-less root is pruned from the outline tree', async () => {
  const app = await setup();
  app.viewer.pdf = {
    async getDestination(dest) {
      return dest;
    },
    async getPageIndex(ref) {
      return ref;
    },
  };
  app.viewer.outlinePromise = Promise.resolve([
    { title: 'system', items: [
      { title: 'A section', dest: [0, 'XYZ', null, null] },
      { title: 'B section', dest: [1, 'XYZ', null, null] },
    ] },
  ]);
  app.fileInput.files = [{ name: 'doc.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const pane = app.get('outline-pane');
  assert.deepEqual(
    pane.querySelectorAll('.outline-item').map((btn) => btn.textContent),
    ['A section', 'B section'],
  );
  assert.deepEqual(
    pane.querySelectorAll('.outline-node').map((node) => node.attrs['aria-level']),
    ['1', '1'],
  );
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

test('extension chrome sits in the toolbar and settings footer', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const toolbar = html.slice(html.indexOf('class="toolbar"'), html.indexOf('id="settings-modal"'));
  const settings = html.slice(html.indexOf('id="settings-modal"'));
  assert.match(toolbar, /id="btn-open"[\s\S]*id="btn-original-pdf"[\s\S]*id="btn-sidebar"/);
  assert.match(toolbar, /原始 PDF/);
  assert.doesNotMatch(toolbar, /id="btn-extension-options"/);
  assert.doesNotMatch(settings, /id="btn-original-pdf"/);
  assert.match(
    settings,
    /class="modal-actions"[\s\S]*id="btn-extension-options"[\s\S]*扩展设置[\s\S]*id="btn-settings-cancel"/,
  );
});

test('extension boot failure without file keeps original-pdf button hidden', async () => {
  const openOptionsPage = [];
  const app = await setup({
    platformId: 'extension',
    canFallbackToBrowser: () => false,
    chrome: { runtime: { openOptionsPage: () => { openOptionsPage.push(1); } } },
    startup: () => Promise.reject(new Error('no file')),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('btn-original-pdf').hidden, true);
  assert.equal(app.get('btn-extension-options').hidden, false);
  assert.equal(openOptionsPage.length, 0);
});

test('extension local open clears original-pdf fallback state', async () => {
  let fallbackCleared = 0;
  const app = await setup({
    platformId: 'extension',
    canFallbackToBrowser: () => true,
    clearBrowserFallback: () => { fallbackCleared += 1; },
    startup: () => ({
      url: 'https://example.com/remote.pdf',
      name: 'remote.pdf',
      withCredentials: true,
    }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('btn-original-pdf').hidden, false);

  app.fileInput.files = [{ name: 'local.pdf', arrayBuffer: async () => new ArrayBuffer(8) }];
  await app.fileInput.listeners.change();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fallbackCleared, 1);
  assert.equal(app.get('btn-original-pdf').hidden, true);
});

test('extension boot failure with file shows original-pdf button', async () => {
  const openOptionsPage = [];
  const app = await setup({
    platformId: 'extension',
    canFallbackToBrowser: () => true,
    chrome: { runtime: { openOptionsPage: () => { openOptionsPage.push(1); } } },
    startup: () => Promise.reject(new Error('permission denied')),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('btn-original-pdf').hidden, false);
  assert.equal(app.get('btn-extension-options').hidden, false);
  assert.equal(openOptionsPage.length, 0);
});
