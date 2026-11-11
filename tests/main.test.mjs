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
  translateText = async () => '', fetchResponse = async () => ({ ok: false }),
  platformId = 'test', canFallbackToBrowser = undefined,
  clearBrowserFallback = undefined, restoreFile = undefined,
  chrome = undefined, localStorageStore = new Map(), clipboardWrite = async () => {},
  toolbarCompact = false, readingFingerprint = () => '',
  saveReadingPosition = () => {}, clearReadingPositions = () => {},
  loadReadingPosition = () => null, showSaveFilePicker, innerWidth = 1024 } = {}) {
  const elements = new Map(), timers = new Map(), documentListeners = {};
  let currentSelection = { rangeCount: 0 };
  let timerId = 0, viewer, fileInput;
  const windowListeners = {};
  const revoked = [];
  const createdBlobs = [];
  const openedTabs = [];
  const downloads = [];
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
      click() { if (this.tagName === "A") downloads.push({ href: this.href, filename: this.download }); },
      remove() { const index = this.parentElement?.children.indexOf(this); if (index >= 0) this.parentElement.children.splice(index, 1); this.parentElement = null; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      removeEventListener() {},
      replaceChildren() { this.children = []; },
      appendChild(child) {
        if (child?.parentElement?.children) {
          const idx = child.parentElement.children.indexOf(child);
          if (idx >= 0) child.parentElement.children.splice(idx, 1);
        }
        this.children.push(child);
        child.parentElement = this;
        return child;
      },
      append(...kids) { for (const kid of kids) this.appendChild(kid); },
      after(...nodes) {
        const parent = this.parentElement;
        if (!parent?.children) return;
        const idx = parent.children.indexOf(this);
        if (idx < 0) return;
        for (const [offset, node] of nodes.entries()) {
          if (node?.parentElement?.children) {
            const from = node.parentElement.children.indexOf(node);
            if (from >= 0) node.parentElement.children.splice(from, 1);
          }
          parent.children.splice(idx + 1 + offset, 0, node);
          node.parentElement = parent;
        }
      },
      contains(node) {
        let cur = node;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentElement;
        }
        return false;
      }, focus() {}, select() {},
      getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
      closest() { return null; },
      getAttribute(name) { return this.attrs[name]; },
      setAttribute(name, value) {
        this.attrs[name] = String(value);
        if (name === 'tabindex') this.tabIndex = Number(value);
      },
      removeAttribute(name) {
        delete this.attrs[name];
        if (name === 'tabindex') this._tabIndex = /^(INPUT|TEXTAREA|BUTTON)$/.test(this.tagName || '') ? 0 : -1;
      },
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
              } else if (['button', 'input', 'textarea'].includes(part) && String(node.tagName || '').toLowerCase() === part) {
                if (!out.includes(node)) out.push(node);
              } else if (part === '[tabindex]' && node.attrs?.tabindex != null) {
                if (!out.includes(node)) out.push(node);
              }
            }
            if (node.children?.length) walk(node.children);
          }
        };
        walk(this.children);
        return out;
      },
    };
    Object.defineProperty(el, 'tabIndex', {
      get() { return this._tabIndex ?? 0; },
      set(value) { this._tabIndex = Number(value); this.attrs.tabindex = String(value); },
    });
    return el;
  }
  function get(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }
  const workspace = element();
  const toolbarMore = element();
  get('btn-sidebar');
  get('btn-ask-toggle');
  get('rail');
  get('rail-panes');
  get('rail-tab-search');
  get('rail-tab-ask');
  get('btn-rail-close');
  get('rail-resize-handle');
  const sidebarInner = element();
  sidebarInner.className = 'sidebar-inner';
  get('sidebar').appendChild(sidebarInner);
  sidebarInner.appendChild(get('outline-pane'));
  sidebarInner.appendChild(get('search-pane'));
  sidebarInner.appendChild(get('ask-pane'));
  for (const [id, tag] of [['ask-input', 'TEXTAREA'], ['ask-submit', 'BUTTON']]) {
    get(id).tagName = tag;
    get('ask-pane').appendChild(get(id));
  }
  get('ask-meter-summary').tagName = 'BUTTON';
  get('ask-meter').appendChild(get('ask-meter-summary'));
  get('ask-meter').appendChild(get('ask-meter-detail'));
  get('ask-pane').appendChild(get('ask-meter'));
  for (const [id, tag] of [['search-input', 'INPUT'], ['search-match-case', 'BUTTON'], ['search-whole-word', 'BUTTON']]) {
    get(id).tagName = tag;
    get('search-pane').appendChild(get(id));
  }
  get('rail').appendChild(get('rail-panes'));
  class Viewer {
    constructor(options = {}) {
      viewer = this; this.generation = 0; this.pageTexts = []; this.hitIndex = -1; this.shown = []; this.query = '';
      this.onIndex = options.onIndex;
      this.onState = options.onState;
      this.onPassword = options.onPassword;
      this.openedSources = [];
      this.appliedPositions = [];
      this.shownOptions = [];
    }
    close() { this.generation++; this.indexPromise = null; this.pageTexts = []; }
    async open(source) {
      this.close();
      this.openedSources.push(source);
      this.source = source;
      this.name = source.name;
      this.pageTexts = [{ pageNumber: 1, text: 'Alpha Beta' }];
      this.pdf = { async getDestination(d) { return d; }, async getPageIndex() { return 0; } };
      this.pageCount = 5;
      this.onState?.({});
      return this;
    }
    async getOutline() { return this.outlinePromise || null; }
    async getDocumentInfo() {
      return this.documentInfo || {
        fileName: this.name,
        fileSize: this.source?.size || 0,
        pageCount: this.pageCount,
        pageWidth: 612,
        pageHeight: 792,
        info: {},
      };
    }
    getState() {
      const wrap = get('viewer-wrap');
      return { page: this.currentPage || 1, zoom: this.zoomMode || 'page-fit',
        scrollTop: wrap.scrollTop || 0, scrollLeft: wrap.scrollLeft || 0 };
    }
    getReadingPoint() { return { page: this.currentPage || 1, pdfY: this.readingPdfY }; }
    applyReadingPosition(position) { this.appliedPositions.push(position); this.currentPage = position.page; }
    async goToDest() {}
    setZoom(mode, options) { (this.zoomCalls ||= []).push({ mode, options }); }
    bumpZoom() { return '150'; }
    clearHits() { this.shown.push(''); this.hitIndex = -1; this.query = ''; }
    async showHits(hits, query, index = 0, options) {
      this.shown.push(query); this.shownOptions.push(options);
      (this.shownHits ||= []).push(hits);
      this.hitIndex = hits.length ? index : -1; this.query = query;
    }
  }
  class TestURL extends URL {}
  TestURL.createObjectURL = value => { createdBlobs.push(value); return `blob:test-${++nextBlob}`; };
  TestURL.revokeObjectURL = url => revoked.push(url);
  const context = vm.createContext({
    URL: TestURL, Blob,
    console, fetch: fetchResponse,
    document: {
      title: 'Fast PDF Viewer – AI Translation',
      getElementById: get,
      createElement: tag => {
        const el = element();
        el.tagName = String(tag || '').toUpperCase();
        if (tag === 'input') fileInput = el;
        return el;
      },
      createElementNS: (_ns, tag) => {
        const el = element();
        el.tagName = String(tag || '').toUpperCase();
        return el;
      },
      createTreeWalker: () => ({ nextNode() { return false; } }),
      createTextNode: text => ({ textContent: text }),
      body: element(),
      documentElement,
      activeElement: null,
      querySelector: sel => (sel === '.workspace' ? workspace : sel === '.toolbar-more' ? toolbarMore : null),
      querySelectorAll: () => [],
      addEventListener(name, fn) { (documentListeners[name] ||= []).push(fn); },
    },
    window: {
      showSaveFilePicker,
      innerWidth,
      innerHeight: 800,
      matchMedia: () => ({ matches: toolbarCompact, addEventListener() {} }),
      addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
      getSelection() { return currentSelection; },
      open(url, target) { openedTabs.push({ url, target }); return { closed: false }; },
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
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    Node: { TEXT_NODE: 3 },
    AbortController,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { return ++timerId; }, cancelAnimationFrame() {},
    chrome,
  });
  const exports = {
    './viewer.js': { PdfViewer: Viewer },
    './history.js': { ViewHistory: class { onChange() {} canBack() { return false; } canForward() { return false; } } },
    './settings.js': { loadSettings, saveSettings, initSettings },
    './platform/extension.js': {
      requestHostAccess,
      fallbackToBrowser: async () => {},
      formatExtensionError(error, translate) {
        if (!error?.code) return error?.message || '';
        const localized = translate?.(error.code, error.params);
        if (localized && localized !== error.code) return localized;
        return error.message || error.code;
      },
    },
    './translate.js': { translateText, MAX_TRANSLATE_CHARS: 4000 },
    './reading-position.js': {
      clearReadingPositions,
      readingFingerprint,
      loadReadingPosition,
      pruneReadingPositions: () => {},
      saveReadingPosition,
    },
    './platform/index.js': {
      createPlatform: () => ({
        id: platformId,
        async startupOpen(options) { return typeof startup === 'function' ? startup(options) : startup; },
        async pickFile() { return null; },
        ...(canFallbackToBrowser !== undefined ? { canFallbackToBrowser } : {}),
        ...(clearBrowserFallback !== undefined ? { clearBrowserFallback } : {}),
        ...(restoreFile !== undefined ? { restoreFile } : {}),
      }),
    },
    './model-picker.js': {
      wireModelPicker: () => ({ refresh() {}, hideMenu() {}, invalidatePending() {}, showPrompt() {} }),
    },
  };
  const main = new vm.SourceTextModule((await readFile(new URL('../web/js/main.js', import.meta.url), 'utf8')) + '\nexport { runAsk, askMemory, askThread, saveCurrentPdf };', { context });
  await main.link(async spec => {
    if (
      spec === './search.js' ||
      spec === './outline-active.js' ||
      spec === './translate-bubble-placement.js' ||
      spec === './selection-anchor.js' ||
      spec === './selection-text.js' ||
      spec === './bubble-text-render.js' ||
      spec === './translate-provider.js' ||
      spec === './openai-chat.js' ||
      spec === './ask-document.js' ||
      spec === './ask-memory.js' ||
      spec === './model-context.js' ||
      spec === './document-tools.js' ||
      spec === './thinking-view.js' ||
      spec === './document-properties.js' ||
      spec === './pdf-download.js' ||
      spec === './loading-progress.js' ||
      spec === './i18n.js' || spec === './languages.js' || spec === './locale-messages.js'
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
  get('viewer-status').hidden = true;
  await main.evaluate();
  // Mirror shipped empty-state chrome: em-dash page readout until a doc opens.
  get('page-input').value = '—';
  get('page-count').textContent = '—';
  get('translate-bubble').hidden = true;
  get('settings-modal').hidden = true;
  get('pdf-password-modal').hidden = true;
  get('zoom-menu').hidden = true;
  get('doc-title-popover').hidden = true;
  get('btn-original-pdf').hidden = true;
  get('doc-properties-modal').hidden = true;
  get('btn-doc-properties').hidden = true;
  return { downloads, savePdf: main.namespace.saveCurrentPdf, ask: main.namespace, viewer, get, fileInput, revoked, createdBlobs, openedTabs, document: context.document, localStorageStore,
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

test('clearing reading records does not recreate them on pagehide until the position changes', async () => {
  const writes = [];
  let clears = 0;
  const app = await setup({
    startup: { data: new Uint8Array([37, 80, 68, 70]), name: 'sample.pdf' },
    readingFingerprint: () => 'content:sample',
    saveReadingPosition: (fingerprint, state) => writes.push({ fingerprint, state }),
    clearReadingPositions: () => { clears += 1; },
  });
  await new Promise(resolve => setImmediate(resolve));

  app.click('btn-clear-reading-positions');
  app.dispatch('pagehide', {});
  app.document.visibilityState = 'hidden';
  app.dispatchDocument('visibilitychange', {});
  assert.equal(clears, 1);
  assert.deepEqual(writes, []);

  app.viewer.currentPage = 2;
  app.viewer.onState?.(app.viewer.getState());
  app.dispatch('pagehide', {});
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fingerprint, 'content:sample');
  assert.equal(writes[0].state.page, 2);
});

test('Escape closes only the compact toolbar menu', async () => {
  const app = await setup({ toolbarCompact: true });
  app.get('translate-bubble').hidden = false;
  app.click('btn-toolbar-more');
  assert.equal(app.get('btn-toolbar-more').getAttribute('aria-expanded'), 'true');

  let stopped = false;
  const event = {
    key: 'Escape', target: app.get('btn-toolbar-more'),
    preventDefault() {}, stopPropagation() { stopped = true; },
  };
  app.dispatchDocument('keydown', event);
  if (!stopped) app.dispatch('keydown', event);

  assert.equal(stopped, true);
  assert.equal(app.get('btn-toolbar-more').getAttribute('aria-expanded'), 'false');
  assert.equal(app.get('translate-bubble').hidden, false);
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

test('an error translation result never writes to the clipboard', async () => {
  let writes = 0;
  const app = await setup({ clipboardWrite: async () => { writes += 1; } });
  const result = app.get('translate-result');
  result.textContent = '翻译失败：缺少 API Key';
  result.classList.toggle('error', true);

  await app.get('btn-copy').listeners.click();

  assert.equal(writes, 0);
});

test('closing the bubble ignores a late clipboard success', async () => {
  let resolveWrite;
  const app = await setup({
    clipboardWrite: () => new Promise((resolve) => { resolveWrite = resolve; }),
  });
  app.get('translate-result').textContent = '翻译结果';
  const button = app.get('btn-copy');
  const pending = button.listeners.click();
  app.click('btn-bubble-close');
  resolveWrite();
  await pending;
  assert.equal(button.dataset.copyState, 'idle');
  assert.equal(app.get('copy-status').textContent, '');
});

test('switching interface language re-renders the empty outline message', async () => {
  const app = await setup({
    startup: { url: 'https://example.com/a.pdf', name: 'a.pdf' },
    loadSettings: () => ({ uiLanguage: 'zh-CN', apiKey: '', apiBaseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', targetLang: 'zh-CN', autoTranslateOnSelect: false }),
    saveSettings: async (next) => next,
  });
  await new Promise((resolve) => setImmediate(resolve));
  app.viewer.outlinePromise = Promise.resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  const pane = app.get('outline-pane');
  assert.match(String(pane.innerHTML || pane.textContent), /没有目录/);
  app.get('settings-modal').hidden = false;
  app.get('setting-ui-language').value = 'en';
  const saveClick = app.get('btn-settings-save').listeners.click({ preventDefault() {}, stopPropagation() {} });
  await Promise.resolve(saveClick);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(String(pane.innerHTML || pane.textContent), /no outline/i);
});

test('settings opened from 更多 restores focus and toggles inert', async () => {
  const app = await setup({
    loadSettings: () => ({ apiKey: '', apiBaseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', targetLang: 'zh-CN', uiLanguage: 'zh-CN', autoTranslateOnSelect: false }),
  });
  const menu = app.get('toolbar-more-menu');
  const menuSettingsButton = app.get('btn-settings');
  const moreButton = app.get('btn-toolbar-more');
  let restoredFocus = 0;
  menu.contains = node => node === menuSettingsButton;
  moreButton.focus = () => { restoredFocus += 1; };
  app.document.activeElement = menuSettingsButton;

  app.click('btn-settings');
  assert.equal(app.get('settings-modal').inert, false);
  app.click('btn-settings-cancel');
  assert.equal(app.get('settings-modal').inert, true);
  assert.equal(restoredFocus, 1);
});

test('settings save writes reasoning effort and show-thinking', async () => {
  let saved;
  const app = await setup({
    loadSettings: () => ({
      apiKey: 'k',
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
      targetLang: 'zh-CN',
      uiLanguage: 'zh-CN',
      autoTranslateOnSelect: false,
      reasoningEffort: 'default',
      showThinking: false,
    }),
    saveSettings: async (next) => { saved = next; return next; },
  });
  app.get('setting-key').value = 'k';
  app.get('setting-base').value = 'https://openrouter.ai/api/v1';
  app.get('setting-model').value = 'openai/gpt-4o-mini';
  app.get('setting-lang').value = 'zh-CN';
  app.get('setting-ui-language').value = 'zh-CN';
  app.get('setting-reasoning-effort').value = 'high';
  app.get('setting-show-thinking').checked = true;
  await app.get('btn-settings-save').listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(saved.reasoningEffort, 'high');
  assert.equal(saved.showThinking, true);
});

test('translation bubble ignores reasoning even when Ask reasoning display is enabled', async () => {
  const textLayer = { closest(selector) { return selector === '.textLayer' ? this : null; } };
  const node = { parentElement: textLayer };
  const rect = { left: 10, top: 10, right: 30, bottom: 20, width: 20, height: 10 };
  const range = {
    commonAncestorContainer: { nodeType: 1 },
    startContainer: node, endContainer: node,
    cloneRange() { return { collapse() {}, getClientRects: () => [rect], getBoundingClientRect: () => rect }; },
    getClientRects: () => [rect], getBoundingClientRect: () => rect,
  };
  const hiddenApp = await setup({
    loadSettings: () => ({
      apiKey: 'key', targetLang: 'zh-CN', uiLanguage: 'zh-CN',
      autoTranslateOnSelect: true, showThinking: false,
    }),
    async translateText(_text, _settings, options) {
      options.onDelta?.('译文', { reasoning: 'secret think' });
      return '译文';
    },
  });
  hiddenApp.setSelection({ rangeCount: 1, toString: () => 'Selected text.', getRangeAt: () => range });
  hiddenApp.dispatchDocument('mouseup', { target: textLayer });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hiddenApp.get('bubble-thinking').textContent, '');

  const shownApp = await setup({
    loadSettings: () => ({
      apiKey: 'key', targetLang: 'zh-CN', uiLanguage: 'zh-CN',
      autoTranslateOnSelect: true, showThinking: true,
    }),
    async translateText(_text, _settings, options) {
      options.onDelta?.('译文', { reasoning: 'secret think' });
      return '译文';
    },
  });
  shownApp.setSelection({ rangeCount: 1, toString: () => 'Selected text.', getRangeAt: () => range });
  shownApp.dispatchDocument('mouseup', { target: textLayer });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shownApp.get('bubble-thinking').textContent, '');
  const markup = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.equal(markup.includes('id="bubble-thinking-wrap"'), false);
});

test('translation bubble language picker persists and stays in sync with settings', async () => {
  const state = { apiKey: '', targetLang: 'zh-CN', uiLanguage: 'zh-CN' };
  const writes = [];
  const app = await setup({
    loadSettings: () => ({ ...state }),
    async saveSettings(next) { Object.assign(state, next); writes.push(next); return { ...state }; },
  });
  const bubblePicker = app.get('bubble-target-lang');
  bubblePicker.value = 'ja';
  await bubblePicker.listeners.change({ target: bubblePicker });
  assert.equal(state.targetLang, 'ja');
  assert.equal(app.get('setting-lang').value, 'ja');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].targetLang, 'ja');

  app.get('settings-modal').hidden = false;
  app.get('setting-lang').value = 'zh-TW';
  await app.get('btn-settings-save').listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(state.targetLang, 'zh-TW');
  assert.equal(bubblePicker.value, 'zh-TW');
});

test('changing bubble language prevents a late translation response from replacing the new request', async () => {
  const state = { apiKey: 'key', targetLang: 'zh-CN', uiLanguage: 'zh-CN', autoTranslateOnSelect: true };
  const requests = [];
  const app = await setup({
    loadSettings: () => ({ ...state }),
    async saveSettings(next) { Object.assign(state, next); return { ...state }; },
    translateText(text, settings, options) {
      const pending = deferred();
      requests.push({ text, lang: settings.targetLang, signal: options.signal, pending });
      return pending.promise;
    },
  });
  const textLayer = { closest(selector) { return selector === '.textLayer' ? this : null; } };
  const node = { parentElement: textLayer };
  const rect = { left: 10, top: 10, right: 30, bottom: 20, width: 20, height: 10 };
  const range = {
    commonAncestorContainer: { nodeType: 1 },
    startContainer: node, endContainer: node,
    cloneRange() { return { collapse() {}, getClientRects: () => [rect], getBoundingClientRect: () => rect }; },
    getClientRects: () => [rect], getBoundingClientRect: () => rect,
  };
  app.setSelection({ rangeCount: 1, toString: () => 'Selected text.', getRangeAt: () => range });
  app.dispatchDocument('mouseup', { target: textLayer });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].lang, 'zh-CN');

  const picker = app.get('bubble-target-lang');
  picker.value = 'en';
  await picker.listeners.change({ target: picker });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].lang, 'en');

  requests[0].pending.resolve('旧语言结果');
  await Promise.resolve();
  const resultText = () => {
    const text = node => node.textContent || (node.children || []).map(text).join('');
    return text(app.get('translate-result'));
  };
  assert.doesNotMatch(resultText(), /旧语言结果/);
  requests[1].pending.resolve('New language result');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(resultText(), /New language result/);
});

test('stopping translation aborts the request and ignores a late response', async () => {
  const pending = deferred();
  let requestSignal;
  const state = { apiKey: 'key', targetLang: 'zh-CN', uiLanguage: 'zh-CN', autoTranslateOnSelect: true };
  const app = await setup({
    loadSettings: () => ({ ...state }),
    translateText(text, settings, options) { requestSignal = options.signal; return pending.promise; },
  });
  const textLayer = { closest(selector) { return selector === '.textLayer' ? this : null; } };
  const node = { parentElement: textLayer };
  const rect = { left: 10, top: 10, right: 30, bottom: 20, width: 20, height: 10 };
  const range = { commonAncestorContainer: { nodeType: 1 }, startContainer: node, endContainer: node,
    cloneRange() { return { collapse() {}, getClientRects: () => [rect], getBoundingClientRect: () => rect }; },
    getClientRects: () => [rect], getBoundingClientRect: () => rect };
  app.setSelection({ rangeCount: 1, toString: () => 'Selected text.', getRangeAt: () => range });
  app.dispatchDocument('mouseup', { target: textLayer });
  assert.equal(app.get('btn-translate-stop').hidden, false);
  assert.equal(app.get('btn-copy').hidden, true);

  app.click('btn-translate-stop');
  assert.equal(requestSignal.aborted, true);
  assert.equal(app.get('btn-translate-stop').hidden, true);
  const result = app.get('translate-result');
  assert.equal(result.hidden, false);
  assert.equal(result.children[1].id, 'btn-translate-retry');
  pending.resolve('late translation');
  await new Promise(resolve => setImmediate(resolve));
  const text = node => node.textContent || (node.children || []).map(text).join('');
  assert.match(text(result), /已停止翻译/);
  assert.doesNotMatch(text(result), /late translation/);
});

test('missing translation key shows one neutral settings action without copy', async () => {
  const app = await setup({
    loadSettings: () => ({ targetLang: 'zh-CN', autoTranslateOnSelect: true }),
    async translateText() { throw new Error('API Key is required'); },
  });
  const textLayer = { closest(selector) { return selector === '.textLayer' ? this : null; } };
  const node = { parentElement: textLayer };
  const rect = { left: 10, top: 10, right: 30, bottom: 20, width: 20, height: 10 };
  const range = { commonAncestorContainer: { nodeType: 1 }, startContainer: node, endContainer: node,
    cloneRange() { return { collapse() {}, getClientRects: () => [rect], getBoundingClientRect: () => rect }; },
    getClientRects: () => [rect], getBoundingClientRect: () => rect };
  app.setSelection({ rangeCount: 1, toString: () => 'Selected text.', getRangeAt: () => range });
  app.dispatchDocument('mouseup', { target: textLayer });
  await new Promise(resolve => setImmediate(resolve));

  const result = app.get('translate-result');
  assert.equal(app.get('btn-copy').hidden, true);
  assert.match(result.children[0].textContent, /配置翻译服务后即可使用/);
  assert.equal(result.children[1].id, 'btn-translate-settings');
  assert.equal(result.children.filter(child => child.id?.startsWith('btn-translate-')).length, 1);
});

test('translation bubble can be resized and restored to default dimensions', async () => {
  const app = await setup();
  const bubble = app.get('translate-bubble');
  const wrap = app.get('viewer-wrap');
  wrap.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
  bubble.hidden = false;
  bubble.getBoundingClientRect = () => ({ left: 20, top: 20, right: 340, bottom: 200, width: 320, height: 180 });
  const event = (values = {}) => ({ target: bubble, pointerId: 4, button: 0, clientX: 339, clientY: 199,
    preventDefault() {}, stopPropagation() {}, ...values });
  bubble.listeners.pointerdown(event());
  bubble.listeners.pointermove(event({ clientX: 419, clientY: 259 }));
  assert.equal(bubble.style.width, '400px');
  assert.equal(bubble.style.height, '240px');
  bubble.listeners.pointerup(event());

  bubble.getBoundingClientRect = () => ({ left: 20, top: 20, right: 440, bottom: 260, width: 420, height: 240 });
  bubble.listeners.pointerdown(event({ clientX: 21, clientY: 120 }));
  bubble.listeners.pointermove(event({ clientX: 41, clientY: 120 }));
  assert.equal(bubble.style.width, '400px');
  assert.equal(bubble.style.left, '40px');
  bubble.listeners.pointercancel(event());

  app.click('btn-bubble-reset-size');
  assert.equal(bubble.style.width, '420px');
  assert.equal(bubble.style.height, '');
  assert.equal(app.get('btn-bubble-reset-size').hidden, true);
});

test('top-edge resize wins over header drag, and controls keep their clicks', async () => {
  const app = await setup();
  const bubble = app.get('translate-bubble');
  const header = app.get('bubble-header');
  bubble.hidden = false;
  bubble.style.left = '40px';
  bubble.style.top = '80px';
  bubble.getBoundingClientRect = () => ({ left: 40, top: 80, right: 460, bottom: 320, width: 420, height: 240 });
  const event = (values = {}) => ({
    target: header,
    button: 0,
    pointerId: 9,
    clientX: 200,
    clientY: 82,
    preventDefault() {},
    stopPropagation() {},
    ...values,
  });

  header.listeners.pointerdown(event());
  assert.equal(bubble.classList.contains('is-dragging'), false);
  bubble.listeners.pointerdown(event());
  assert.equal(bubble.classList.contains('is-resizing'), true);
  bubble.listeners.pointermove(event({ clientY: 50 }));
  assert.ok(Number.parseFloat(bubble.style.top) < 80);
  bubble.listeners.pointerup(event());
  assert.equal(bubble.classList.contains('is-resizing'), false);
  assert.equal(bubble.style.cursor, '');

  const select = { closest: (selector) => (selector.includes('select') ? select : null) };
  bubble.listeners.pointerdown(event({ target: select }));
  assert.equal(bubble.classList.contains('is-resizing'), false);
  const button = { closest: (selector) => (selector.includes('button') ? button : null) };
  bubble.listeners.pointerdown(event({ target: button, clientX: 452, clientY: 82 }));
  assert.equal(bubble.classList.contains('is-resizing'), false);

  bubble.listeners.pointerdown(event({ clientX: 38, clientY: 78 }));
  assert.equal(bubble.classList.contains('is-resizing'), true);
  bubble.listeners.pointerup(event());
  bubble.listeners.pointerdown(event({ clientX: 200, clientY: 40 }));
  assert.equal(bubble.classList.contains('is-resizing'), false);
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

test('empty-state zoom does not skip first-open page fit', async () => {
  const app = await setup();
  const zooms = [];
  app.viewer.setZoom = (mode) => { zooms.push(mode); };
  app.click('btn-zoom-in');
  app.fileInput.files = [{ name: 'A.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  assert.equal(zooms.includes('page-fit'), true);
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

test('automatic zoom modes reflow on viewport resize without overriding fixed zoom', async () => {
  const app = await setup();
  app.viewer.pdf = {};
  app.viewer.zoomMode = 'page-fit';
  app.viewer.zoomCalls = [];
  app.dispatch('resize', {});
  app.runTimer();
  assert.equal(app.viewer.zoomCalls.at(-1).mode, 'page-fit');
  assert.equal(app.viewer.zoomCalls.at(-1).options.silent, true);

  app.viewer.zoomMode = '150';
  app.viewer.zoomCalls = [];
  app.dispatch('resize', {});
  app.runTimer();
  assert.deepEqual(app.viewer.zoomCalls, []);
});

test('reader arrows scroll within a page and Alt+PageDown changes PDF page', async () => {
  const app = await setup();
  const wrap = app.get('viewer-wrap');
  wrap.scrollTop = 0;
  wrap.clientHeight = 600;
  app.viewer.pdf = {};
  app.viewer.pageCount = 3;
  app.viewer.currentPage = 1;
  const jumps = [];
  app.viewer.goToPage = page => { jumps.push(page); app.viewer.currentPage = page; };
  const target = { matches: () => false, closest: () => null };
  const key = (name, modifiers = {}, focused = target) => {
    let prevented = false;
    app.dispatch('keydown', { key: name, target: focused, ...modifiers, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(key('ArrowDown'), true);
  assert.equal(wrap.scrollTop, 48);
  assert.equal(key('PageDown'), true);
  assert.equal(wrap.scrollTop, 588);
  assert.deepEqual(jumps, []);
  assert.equal(key('ArrowDown', { shiftKey: true }), false);
  assert.equal(wrap.scrollTop, 588);
  assert.equal(key('PageDown', {}, { matches: () => false, closest: () => ({}) }), false);
  assert.equal(key('PageDown', { altKey: true }), true);
  assert.deepEqual(jumps, [2]);
});

test('page input rejects malformed values and restores the actual page on Enter and blur', async () => {
  const app = await setup();
  const input = app.get('page-input');
  input.disabled = false;
  app.viewer.pageCount = 120;
  app.viewer.currentPage = 15;
  const jumps = [];
  app.viewer.goToPage = page => { jumps.push(page); app.viewer.currentPage = page; };
  for (const value of ['1.5', 'abc', '-2', '0', '', '12abc', '9007199254740992']) {
    for (const type of ['keydown', 'change']) {
      input.value = value;
      input.listeners[type]({key: 'Enter', target: input, preventDefault() {}});
      assert.equal(input.value, '15', `${type}: ${value}`);
    }
  }
  assert.deepEqual(jumps, []);
  input.value = ' 020 ';
  input.listeners.keydown({key: 'Enter', target: input, preventDefault() {}});
  assert.equal(input.value, '20');
  input.value = '999';
  input.listeners.change({target: input});
  assert.equal(input.value, '120');
  assert.deepEqual(jumps, [20, 120]);
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

test('automatic search previews use one history group across successive queries', async () => {
  const app = await setup();
  app.input('Alpha');
  await app.runTimer();
  app.input('Alpha B');
  await app.runTimer();

  assert.equal(app.viewer.shownOptions.at(-1).historyGroup, 'search-input');
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

test('local files can open in the browser PDF viewer', async () => {
  const app = await setup();
  app.fileInput.files = [{ name: 'manual.pdf', arrayBuffer: async () => new ArrayBuffer(8) }];
  await app.fileInput.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('btn-original-pdf').hidden, false);
  const before = app.createdBlobs.length;
  app.click('btn-original-pdf');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.openedTabs.length, 1);
  assert.match(app.openedTabs[0].url, /^blob:test-/);
  assert.equal(app.openedTabs[0].target, '_blank');
  assert.ok(app.createdBlobs.length > before);
});

test('web MIME PDF uses download and Ctrl+S saves the retained original bytes', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 0, 255]);
  const app = await setup({ startup: { data: bytes, name: '1706.03762', originalUrl: 'https://arxiv.org/pdf/1706.03762', mimeStream: true } });
  await new Promise(resolve => setImmediate(resolve));
  const button = app.get('btn-save-pdf');
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(app.get('pdf-save-icon').getAttribute('href'), '#i-download');
  assert.match(button.title, /下载 PDF.*Ctrl\+S/);
  let prevented = false;
  app.dispatch('keydown', { key: 's', ctrlKey: true, preventDefault() { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(app.downloads.length, 1);
  assert.equal(app.downloads[0].filename, '1706.03762.pdf');
  assert.deepEqual(new Uint8Array(await app.createdBlobs.at(-1).arrayBuffer()), bytes);
  assert.equal(button.disabled, false);
});

test('local selection uses the save icon and exports a copy of the original file', async () => {
  const app = await setup();
  assert.equal(app.get('btn-save-pdf').hidden, true);
  const file = new Blob(['%PDF-local-original'], { type: 'application/pdf' });
  file.name = '本地手册.pdf';
  app.fileInput.files = [file];
  await app.fileInput.listeners.change();
  assert.equal(app.get('pdf-save-icon').getAttribute('href'), '#i-save');
  assert.match(app.get('btn-save-pdf').title, /保存副本.*Ctrl\+S/);
  await app.savePdf();
  assert.equal(app.downloads[0].filename, file.name);
  assert.equal(app.createdBlobs.at(-1), file);
  assert.equal(await file.text(), '%PDF-local-original');
});

test('file MIME sources and desktop paths stay local despite transferred bytes and proxy URLs', async () => {
  for (const source of [
    { originalUrl: 'file:///C:/manual.pdf', data: new Uint8Array([37, 80, 68, 70]), mimeStream: true },
    { path: 'C:\\manual.pdf', url: '/opened/123.pdf' },
  ]) {
    const app = await setup({ startup: { name: 'manual.pdf', ...source }, platform: 'MacIntel' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.get('pdf-save-icon').getAttribute('href'), '#i-save');
    assert.match(app.get('btn-save-pdf').title, /保存副本.*Cmd\+S/);
  }
});

test('download ignores repeated clicks and discards an old request after switching documents', async () => {
  const pending = deferred();
  const app = await setup({ startup: { name: 'remote.pdf', url: 'https://example.org/remote.pdf' } });
  await new Promise(resolve => setImmediate(resolve));
  let reads = 0;
  app.viewer.pdf.getData = () => { reads++; return pending.promise; };
  const first = app.savePdf();
  await app.savePdf();
  assert.equal(reads, 1);
  assert.equal(app.get('btn-save-pdf').disabled, true);
  const next = new Blob(['%PDF-new']); next.name = 'next.pdf';
  app.fileInput.files = [next];
  await app.fileInput.listeners.change();
  pending.resolve(new Uint8Array([37, 80, 68, 70]));
  await first;
  assert.equal(app.downloads.length, 0);
  assert.equal(app.get('btn-save-pdf').disabled, false);
  assert.equal(app.get('pdf-save-icon').getAttribute('href'), '#i-save');
  await app.savePdf();
  assert.equal(app.downloads[0].filename, 'next.pdf');
});

test('download failure allows retry and does not block the PDF reading surface', async () => {
  const app = await setup({ startup: { name: 'remote.pdf', url: 'https://example.org/remote.pdf' } });
  await new Promise(resolve => setImmediate(resolve));
  app.viewer.pdf.getData = async () => { throw new Error('network offline'); };
  await app.savePdf();
  assert.equal(app.downloads.length, 0);
  assert.equal(app.get('btn-save-pdf').disabled, false);
  assert.equal(app.get('viewer-status').hidden, true);
  assert.equal(app.get('pdf-export-notice').hidden, false);
  assert.match(app.get('pdf-export-notice').textContent, /network offline/);
  app.viewer.pdf.getData = async () => new Uint8Array([37, 80, 68, 70]);
  await app.savePdf();
  assert.equal(app.downloads.length, 1);
  assert.equal(app.get('pdf-export-notice').hidden, true);
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

test('an older outline completion does not discard recovery for a newer failed open', async () => {
  const app = await setup(), outline = deferred();
  app.viewer.outlinePromise = outline.promise;
  const open = app.viewer.open.bind(app.viewer);
  app.viewer.open = async source => {
    if (source.name === 'broken.pdf') throw new Error('bad pdf');
    return open(source);
  };
  app.fileInput.files = [{ name: 'previous.pdf', size: 10, lastModified: 1 }];
  const previousOpen = app.fileInput.listeners.change();
  await new Promise(resolve => setImmediate(resolve));

  app.fileInput.files = [{ name: 'broken.pdf', size: 12, lastModified: 2 }];
  await app.fileInput.listeners.change();
  assert.equal(app.get('viewer-status-restore').hidden, false);
  outline.resolve([]);
  await previousOpen;

  app.click('viewer-status-restore');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.viewer.source.name, 'previous.pdf');
  assert.equal(app.get('viewer-status').hidden, true);
});

test('MIME bytes recover through a Blob URL while preserving fingerprint and reading page', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 1, 2]);
  const fingerprintCalls = [], loadedFingerprints = [];
  const savedPosition = { page: 4, zoom: 'page-width', scrollTop: 25, scrollLeft: 0 };
  const app = await setup({
    startup: { data: bytes, name: 'mime.pdf' },
    readingFingerprint: source => { fingerprintCalls.push(source.name); return 'content:mime'; },
    loadReadingPosition: fingerprint => { loadedFingerprints.push(fingerprint); return savedPosition; },
  });
  const open = app.viewer.open.bind(app.viewer);
  app.viewer.open = async source => {
    if (source.name === 'broken.pdf') throw new Error('bad pdf');
    if (source.data) structuredClone(source.data.buffer, { transfer: [source.data.buffer] });
    return open(source);
  };
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.viewer.currentPage, 4);

  app.fileInput.files = [{ name: 'broken.pdf', size: 3, lastModified: 2 }];
  await app.fileInput.listeners.change();
  app.click('viewer-status-restore');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(app.viewer.source.name, 'mime.pdf');
  assert.equal(app.viewer.source.data, undefined);
  assert.match(app.viewer.source.url, /^blob:test-/);
  assert.ok(app.createdBlobs.at(-1) instanceof Blob);
  assert.deepEqual(fingerprintCalls, ['mime.pdf', 'broken.pdf']);
  assert.deepEqual(loadedFingerprints, ['content:mime']);
  assert.equal(app.viewer.appliedPositions.at(-1).page, 4);
  assert.equal(app.viewer.currentPage, 4);
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

test('search options rerun the current query and survive indexing refreshes', async () => {
  const app = await setup();
  app.viewer.pageTexts = [{ pageNumber: 1, text: 'arc Arc search architecture' }];
  app.input('arc');
  await app.runTimer();
  assert.equal(app.viewer.shownHits.at(-1).length, 4);

  app.click('search-whole-word');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('search-whole-word').attrs['aria-pressed'], 'true');
  assert.equal(app.viewer.shownHits.at(-1).length, 2);

  app.click('search-match-case');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('search-match-case').attrs['aria-pressed'], 'true');
  assert.equal(app.viewer.shownHits.at(-1).length, 1);
  assert.equal(app.viewer.shownHits.at(-1)[0].offset, 0);
  const snippet = app.get('search-list').children[0].innerHTML;
  assert.ok(snippet.includes('<mark>arc</mark> Arc search architecture'));

  app.viewer.pageTexts.push({ pageNumber: 2, text: 'Arc arc search' });
  app.viewer.onIndex();
  await app.runTimer();
  assert.equal(app.viewer.shownHits.at(-1).length, 2);
  app.click('sidebar-tab-ask');
  app.click('sidebar-tab-search');
  assert.equal(app.get('search-whole-word').attrs['aria-pressed'], 'true');
  assert.equal(app.get('search-match-case').attrs['aria-pressed'], 'true');
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

test('ask tab opens the ask pane and keeps question across mode flips', async () => {
  const app = await setup();
  app.click('sidebar-tab-ask');
  assert.equal(app.get('sidebar').inert, false);
  assert.equal(app.get('sidebar-tab-ask').attrs['aria-selected'], 'true');
  assert.equal(app.get('ask-pane').toggles.active, true);
  assert.equal(app.get('search-pane').toggles.active, false);
  app.get('ask-input').value = '冷却水规格在哪';
  app.click('sidebar-tab-search');
  assert.equal(app.get('search-pane').toggles.active, true);
  assert.equal(app.get('ask-pane').toggles.active, false);
  assert.equal(app.get('ask-input').value, '冷却水规格在哪');
  app.click('sidebar-tab-ask');
  assert.equal(app.get('ask-pane').toggles.active, true);
  assert.equal(app.get('ask-input').value, '冷却水规格在哪');
  app.click('btn-sidebar');
  assert.equal(app.get('outline-pane').toggles.active, true);
  assert.equal(app.get('ask-pane').toggles.active, false);
  assert.equal(app.get('ask-input').value, '冷却水规格在哪');
});

test('Escape closes ask sidebar without clearing the question', async () => {
  const app = await setup();
  app.click('sidebar-tab-ask');
  app.get('ask-input').value = 'cooling water';
  app.dispatch('keydown', {
    key: 'Escape',
    target: { matches() { return false; } },
    preventDefault() {},
  });
  assert.equal(app.get('sidebar').inert, true);
  assert.equal(app.get('ask-input').value, 'cooling water');
});

test('desktop dual-rail keeps outline open while search uses the right rail', async () => {
  const app = await setup({ innerWidth: 1440 });
  app.click('btn-sidebar');
  assert.equal(app.get('sidebar').inert, false);
  assert.equal(app.get('outline-pane').toggles.active, true);
  app.click('btn-search-toggle');
  assert.equal(app.get('sidebar').inert, false);
  assert.equal(app.get('rail').inert, false);
  assert.equal(app.get('search-pane').toggles.active, true);
  assert.equal(app.get('ask-pane').toggles.active, false);
  assert.equal(app.get('outline-pane').toggles.active, true);
  app.get('search-input').value = 'Alpha';
  app.dispatch('keydown', {
    key: 'Escape',
    target: { matches() { return false; } },
    preventDefault() {},
  });
  assert.equal(app.get('rail').inert, true);
  assert.equal(app.get('sidebar').inert, false);
  assert.equal(app.get('search-input').value, 'Alpha');
});

test('desktop dual-rail ask toggle opens the right rail without closing outline', async () => {
  const app = await setup({ innerWidth: 1440 });
  app.click('btn-sidebar');
  app.click('btn-ask-toggle');
  assert.equal(app.get('rail').inert, false);
  assert.equal(app.get('ask-pane').toggles.active, true);
  assert.equal(app.get('sidebar').inert, false);
  app.get('ask-input').value = 'cooling water';
  app.click('rail-tab-search');
  assert.equal(app.get('search-pane').toggles.active, true);
  assert.equal(app.get('ask-input').value, 'cooling water');
});

test('crossing below 1280 reparents the open rail mode into the left sidebar', async () => {
  const app = await setup({ innerWidth: 1440 });
  app.click('btn-ask-toggle');
  app.get('ask-input').value = 'keep me';
  assert.equal(app.get('rail').inert, false);
  app.setViewportWidth(1200);
  app.dispatch('resize', {});
  assert.equal(app.get('sidebar').inert, false);
  assert.equal(app.get('ask-pane').toggles.active, true);
  assert.equal(app.get('ask-input').value, 'keep me');
});

test('crossing above 1280 moves an open search tab into the right rail', async () => {
  const app = await setup({ innerWidth: 1200 });
  app.click('btn-search-toggle');
  app.get('search-input').value = 'Alpha';
  assert.equal(app.get('sidebar').inert, false);
  assert.equal(app.get('search-pane').toggles.active, true);
  app.setViewportWidth(1280);
  app.dispatch('resize', {});
  assert.equal(app.get('rail').inert, false);
  assert.equal(app.get('search-pane').toggles.active, true);
  assert.equal(app.get('sidebar').inert, true);
  assert.equal(app.get('search-input').value, 'Alpha');
});

test('moving collapsed panes between rails preserves their original tab stops', async () => {
  const app = await setup({ innerWidth: 1200 });
  assert.equal(app.get('ask-input').tabIndex, -1);
  app.setViewportWidth(1440);
  app.dispatch('resize', {});
  app.click('btn-ask-toggle');
  for (const id of ['ask-input', 'ask-submit']) {
    assert.equal(app.get(id).tabIndex, 0, id);
    assert.equal(app.get(id).attrs['aria-hidden'], undefined, id);
    assert.equal(app.get(id).dataset.sidebarTabindex, undefined, id);
  }

  app.click('btn-rail-close');
  app.setViewportWidth(1200);
  app.dispatch('resize', {});
  app.click('sidebar-tab-ask');
  for (const id of ['ask-input', 'ask-submit']) {
    assert.equal(app.get(id).tabIndex, 0, id);
    assert.equal(app.get(id).dataset.railTabindex, undefined, id);
  }
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

test('large desktop viewports give the sidebar scaled bounds', async () => {
  const app = await setup({ localStorageStore: new Map() });
  const handle = app.get('sidebar-resize-handle');

  for (const [width, min, max] of [[1920, 320, 560], [2560, 360, 640], [3840, 420, 720]]) {
    app.setViewportWidth(width);
    app.dispatch('resize', {});
    assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), `${min}px`, width + 'px: sidebar defaults to its scaled minimum');
    assert.equal(handle.attrs['aria-valuemin'], String(min), width + 'px: resize minimum is scaled');
    // aria-valuemax also depends on the workspace width; the browser-level
    // layout test covers the real maximum. Here the fake workspace is fixed.
  }

  // Below 1920 the original compact bounds must come back unchanged.
  app.setViewportWidth(1440);
  app.dispatch('resize', {});
  assert.equal(app.document.documentElement.style.getPropertyValue('--sidebar-w'), '272px');
  assert.equal(handle.attrs['aria-valuemin'], '272');
  assert.equal(handle.attrs['aria-valuemax'], '480');
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
    { title: 'Chapter\t\u00a05', dest: [0, 'XYZ', null, null], items: [
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

test('filename popover lists the current outline path', async () => {
  const app = await setup();
  app.viewer.pdf = {
    async getDestination(dest) { return dest; },
    async getPageIndex(ref) { return ref; },
  };
  app.viewer.currentPage = 12;
  app.viewer.outlinePromise = Promise.resolve([
    { title: 'Chapter\t\u00a05', dest: [0, 'XYZ', null, null], items: [
      { title: '5.4 Heading', dest: [10, 'XYZ', null, null], items: [
        { title: 'Deep child', dest: [11, 'XYZ', null, null] },
      ] },
    ] },
  ]);
  app.fileInput.files = [{ name: 'doc.pdf', arrayBuffer: async () => new ArrayBuffer(0) }];
  await app.fileInput.listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  const dests = [];
  app.viewer.goToDest = async (dest) => { dests.push(dest); };
  app.click('doc-title');
  const pop = app.get('doc-title-popover');
  assert.equal(pop.hidden, false);
  assert.equal(pop.querySelector('.doc-title-file').textContent, 'doc.pdf');
  assert.deepEqual(
    pop.querySelectorAll('.doc-title-crumb').map((crumb) => crumb.textContent),
    ['Chapter 5', '5.4 Heading', 'Deep child'],
  );
  assert.equal((await app.viewer.outlinePromise)[0].title, 'Chapter\t\u00a05');
  const parent = pop.querySelectorAll('.doc-title-crumb')[0];
  parent.listeners.click();
  assert.deepEqual(dests[0], [0, 'XYZ', null, null]);
  assert.equal(pop.hidden, true);
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

test('successful open clears the opening splash text instead of leaving it hidden', async () => {
  const app = await setup();
  app.fileInput.files = [{ name: 'doc.pdf', size: 10, lastModified: 1 }];
  const opening = app.fileInput.listeners.change();
  assert.equal(app.get('viewer-status').hidden, false);
  assert.equal(app.get('viewer-status-text').textContent, '正在打开…');
  await opening;
  assert.equal(app.get('viewer-status').hidden, true);
  assert.equal(app.get('viewer-status-text').textContent, '');
});

test('failed new file can restore the prior document and reading page', async () => {
  const app = await setup();
  const open = app.viewer.open.bind(app.viewer);
  app.viewer.open = async source => {
    if (source.name === 'broken.pdf') throw new Error('bad pdf');
    return open(source);
  };
  app.fileInput.files = [{ name: 'good.pdf', size: 10, lastModified: 1 }];
  await app.fileInput.listeners.change();
  app.viewer.currentPage = 4;

  app.fileInput.files = [{ name: 'broken.pdf', size: 12, lastModified: 2 }];
  await app.fileInput.listeners.change();
  assert.equal(app.get('viewer-status-restore').hidden, false);
  app.click('viewer-status-restore');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(app.viewer.source.name, 'good.pdf');
  assert.equal(app.viewer.appliedPositions.at(-1).page, 4);
  assert.equal(app.viewer.currentPage, 4);
});

test('restored local file retains its native PDF action after repeated failures', async () => {
  const app = await setup();
  const open = app.viewer.open.bind(app.viewer);
  app.viewer.open = async source => {
    if (source.name === 'broken.pdf') throw new Error('bad pdf');
    return open(source);
  };
  const file = { name: 'good.pdf', size: 10, lastModified: 1 };
  app.fileInput.files = [file];
  await app.fileInput.listeners.change();
  for (let i = 0; i < 2; i++) {
    app.fileInput.files = [{ name: 'broken.pdf', size: 12, lastModified: 2 }];
    await app.fileInput.listeners.change();
    app.click('viewer-status-restore');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.viewer.source.name, 'good.pdf');
    assert.equal(app.get('btn-original-pdf').hidden, false);
    app.click('btn-original-pdf');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.createdBlobs.at(-1), file);
  }
});

test('desktop recovery reactivates the document before fetching its URL', async () => {
  let currentId = 'good-id';
  const restored = [];
  const app = await setup({
    platformId: 'desktop',
    startup: { name: 'good.pdf', id: currentId, path: 'C:/good.pdf', url: '/opened/good-id.pdf' },
    restoreFile: async id => { restored.push(id); currentId = id; return true; },
  });
  await new Promise(resolve => setImmediate(resolve));
  const open = app.viewer.open.bind(app.viewer);
  app.viewer.open = async source => {
    if (source.id && source.id !== currentId) throw new Error('409 Document changed');
    if (source.name === 'broken.pdf') throw new Error('bad pdf');
    return open(source);
  };
  app.viewer.currentPage = 4;
  currentId = 'broken-id';
  app.fileInput.files = [{ name: 'broken.pdf', size: 12 }];
  await app.fileInput.listeners.change();
  app.click('viewer-status-restore');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(restored, ['good-id']);
  assert.equal(app.viewer.source.id, 'good-id');
  assert.equal(app.viewer.currentPage, 4);
  assert.equal(app.get('viewer-status').hidden, true);
});

test('document properties open from 更多 with filename and page count', async () => {
  const app = await setup();
  assert.equal(app.get('btn-doc-properties').hidden, true);
  app.fileInput.files = [{ name: 'manual.pdf', size: 2048, lastModified: 1 }];
  await app.fileInput.listeners.change();
  assert.equal(app.get('btn-doc-properties').hidden, false);
  app.viewer.documentInfo = {
    fileName: 'manual.pdf',
    fileSize: 2048,
    pageCount: 5,
    pageWidth: 612,
    pageHeight: 792,
    info: { Title: 'Surfscan', PDFFormatVersion: '1.7', IsLinearized: false },
  };
  app.click('btn-doc-properties');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.get('doc-properties-modal').hidden, false);
  const text = app.get('doc-properties-list').children.map((node) => node.textContent).join(' ');
  assert.match(text, /manual\.pdf/);
  assert.match(text, /Surfscan/);
  assert.match(text, /1\.7/);
  app.click('btn-doc-properties-close');
  assert.equal(app.get('doc-properties-modal').hidden, true);
});

test('ask composer has no title row and a one-line auto-growing input', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /class="ask-label"/);
  assert.match(html, /id="ask-input"[^>]*rows="1"/);
  assert.match(html, /class="ask-input-placeholder"/);
  assert.match(html, /class="ask-empty-title"/);
  assert.match(html, /class="ask-send-slot"/);
  assert.doesNotMatch(html, /class="ask-input-row"/);
  assert.doesNotMatch(html, /class="ask-actions"/);
  assert.match(css, /\.ask-input \{[\s\S]*?resize:\s*none/);
  assert.match(html, /class="ask-compose-actions"[\s\S]*id="ask-more"[\s\S]*class="ask-send-slot"/);
});

test('ask input grows with wrapped text up to max-height', async () => {
  const app = await setup();
  const input = app.get('ask-input');
  input.scrollHeight = 72;
  app.dispatchElement('ask-input', 'input', { target: input });
  assert.equal(input.style.height, '72px');
  input.scrollHeight = 400;
  app.dispatchElement('ask-input', 'input', { target: input });
  assert.equal(input.style.height, '160px');
  assert.equal(input.style.overflowY, 'auto');
  input.value = '';
  input.scrollHeight = 0;
  app.dispatchElement('ask-input', 'input', { target: input });
  assert.equal(input.style.height, '');
});

test('ask send hidden attribute wins over display grid', async () => {
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const start = css.indexOf('.ask-send {');
  assert.ok(start >= 0, 'ask send has a display rule');
  assert.match(css, /\.ask-send\[hidden\]\s*\{[\s\S]*?display:\s*none/);
  // A "display ... allow-discrete" transition keeps the outgoing button rendered
  // for the whole fade, so a hidden send button would still sit on top of stop.
  const blocks = [...css.matchAll(/(^|\n)\.ask-send\s*\{([^}]*)\}/g)];
  assert.ok(blocks.length, 'ask send has a display rule');
  for (const [, , body] of blocks) {
    assert.doesNotMatch(body, /transition:[^;]*\bdisplay\b/);
  }
});

test('ask send stays disabled while empty and becomes stop while answering', async () => {
  const app = await setup();
  const submit = app.get('ask-submit');
  const stop = app.get('ask-stop');
  const input = app.get('ask-input');
  assert.equal(submit.disabled, true);
  assert.equal(stop.hidden, true);

  input.value = '冷却水规格在哪';
  app.dispatchElement('ask-input', 'input', { target: input });
  assert.equal(submit.disabled, false);
  assert.equal(submit.hidden, false);
  assert.equal(stop.hidden, true);

  input.value = '   ';
  app.dispatchElement('ask-input', 'input', { target: input });
  assert.equal(submit.disabled, true);
});

test('ask meter chip opens a floating popover above the line and closes on outside click', async () => {
  const app = await setup();
  const meter = app.get('ask-meter');
  const summary = app.get('ask-meter-summary');
  const detail = app.get('ask-meter-detail');
  meter.hidden = false;
  summary.getBoundingClientRect = () => ({ left: 120, top: 520, right: 400, bottom: 538, width: 280, height: 18 });
  app.get('ask-pane').getBoundingClientRect = () => ({ left: 100, top: 48, right: 420, bottom: 760, width: 320, height: 712 });

  app.click('ask-meter-summary');
  assert.equal(detail.hidden, false);
  assert.equal(detail.parentElement, app.document.body);
  assert.equal(summary.attrs['aria-expanded'], 'true');
  const left = Number.parseFloat(detail.style.left);
  assert.ok(left >= 100 && left <= 120);
  const bottom = Number.parseFloat(detail.style.bottom);
  assert.equal(bottom, 800 - 520 + 6);

  app.click('ask-meter-summary');
  assert.equal(detail.hidden, true);
  assert.equal(detail.parentElement, app.document.body);
  assert.equal(summary.attrs['aria-expanded'], 'false');

  app.click('ask-meter-summary');
  app.dispatchDocument('pointerdown', { target: detail });
  assert.equal(detail.hidden, false);

  app.dispatchDocument('pointerdown', { target: app.get('ask-input') });
  assert.equal(detail.hidden, true);
  assert.equal(detail.parentElement, app.document.body);
});

test('ask foot usage and coverage share a 24px row with even pane padding', async () => {
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#ask-pane\.active \{[\s\S]*?padding-bottom:\s*8px/);
  assert.match(css, /\.ask-meter-summary \{[\s\S]*?height:\s*24px/);
  assert.match(css, /\.ask-status \{[\s\S]*?height:\s*24px/);
  assert.match(css, /\.ask-status \{[\s\S]*?line-height:\s*1/);
});

test('ask effort chip sits by send and mirrors the saved reasoning effort', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.match(html, /class="ask-compose-actions"[\s\S]*id="ask-more"[\s\S]*id="ask-effort"[\s\S]*class="ask-send-slot"/);
  assert.match(html, /id="ask-effort-label"/);
  assert.equal((html.match(/class="ask-effort-item"/g) || []).length, 5);
  assert.match(html, /id="setting-reasoning-effort"/);
  assert.match(css, /\n\.ask-effort \{[\s\S]*?margin-left:\s*auto/);
  assert.match(css, /\.ask-effort-menu \{[\s\S]*?position:\s*fixed/);
  assert.match(css, /\.ask-effort-item\[aria-checked="true"\] \.ask-effort-check \{[\s\S]*?visibility:\s*visible/);
});

test('ask effort chip opens a menu by send and saves the picked effort', async () => {
  let saved;
  const app = await setup({
    saveSettings: async (next) => { saved = { ...next }; return { reasoningEffort: next.reasoningEffort }; },
  });
  const menu = app.get('ask-effort-menu');
  const button = app.get('btn-ask-effort');
  const host = app.get('ask-effort');
  // The fake DOM does not parse index.html, so mirror the shipped start state.
  host.appendChild(menu);
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  const pick = (effort) => app.dispatchElement('ask-effort-menu', 'click', {
    target: { closest: selector => (selector === '.ask-effort-item' ? { dataset: { effort } } : null) },
  });

  assert.equal(menu.hidden, true);
  assert.equal(app.get('ask-effort-label').textContent, '默认');

  app.click('btn-ask-effort');
  assert.equal(menu.hidden, false);
  assert.equal(menu.parentElement, app.document.body);
  assert.equal(button.attrs['aria-expanded'], 'true');

  pick('high');
  assert.equal(menu.hidden, true);
  assert.equal(button.attrs['aria-expanded'], 'false');
  assert.equal(menu.parentElement, host);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.reasoningEffort, 'high');
  assert.equal(app.get('ask-effort-label').textContent, '高');
  assert.match(button.attrs.title, /高/);

  app.click('btn-ask-effort');
  app.dispatchElement('ask-input', 'keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(menu.hidden, true);
  assert.equal(button.attrs['aria-expanded'], 'false');
});

test('ask thread uses a user bubble, answer icons, and a composer clear menu', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.match(html, /id="ask-more"/);
  assert.match(html, /id="ask-clear"[\s\S]*data-i18n="askClear"/);
  assert.match(html, /class="ask-icon-btn ask-copy"/);
  assert.match(html, /class="ask-icon-btn ask-retry"/);
  assert.match(html, /data-i18n="askPrompt"/);
  assert.match(css, /\.ask-turn-question \{[\s\S]*?align-self:\s*flex-end/);
  assert.match(css, /\.ask-turn-question \{[\s\S]*?border-radius:\s*16px/);
  assert.doesNotMatch(html, /id="ask-result-actions"/);
  assert.doesNotMatch(html, /id="ask-retry"/);
});

test('ask thinking stays in the thread without a nested card', async () => {
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const start = css.indexOf('.thinking-body {');
  assert.ok(start >= 0, 'thinking body has styles');
  const block = css.slice(start, css.indexOf('}', start) + 1);
  assert.match(block, /border:\s*none/);
  assert.match(block, /background:\s*transparent/);
  assert.match(block, /overflow:\s*visible/);
  assert.match(block, /max-height:\s*none/);
  assert.doesNotMatch(block, /border-radius/);
  assert.match(css, /\.ask-answer \.md-table \{[\s\S]*?overflow-x:\s*auto/);
});

test('ask thread keeps a stable scrollbar gutter on the pane edge', async () => {
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#search-pane\.active,\s*#ask-pane\.active \{[\s\S]*?padding-right:\s*0;/);
  assert.match(css, /\.ask-thread,\s*#search-list \{[\s\S]*?scrollbar-gutter:\s*stable/);
  const searchControls = css.slice(css.indexOf('.search-controls {'), css.indexOf('}', css.indexOf('.search-controls {')));
  const askComposer = css.slice(css.indexOf('.ask-composer {'), css.indexOf('}', css.indexOf('.ask-composer {')));
  assert.doesNotMatch(searchControls, /scrollbar-gutter/);
  assert.doesNotMatch(askComposer, /scrollbar-gutter/);
  assert.match(askComposer, /padding-right:\s*var\(--pane-inline-pad\)/);
  assert.doesNotMatch(askComposer, /border-top/);
});

test('ask tables scroll sideways instead of squeezing every column', async () => {
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const wrapperStart = css.indexOf('\n.ask-answer .md-table {');
  assert.ok(wrapperStart >= 0, 'table wrapper has its own block');
  const wrapper = css.slice(wrapperStart, css.indexOf('}', wrapperStart));
  assert.match(wrapper, /overflow-x:\s*auto/);
  const tableStart = css.indexOf('\n.ask-answer .md-table table {');
  assert.ok(tableStart >= 0, 'table element has its own block');
  const table = css.slice(tableStart, css.indexOf('}', tableStart));
  assert.match(table, /width:\s*max-content/);
  assert.match(table, /min-width:\s*100%/);
  assert.doesNotMatch(table, /(^|[\s;])width:\s*100%/);
  const cellStart = css.indexOf('\n.ask-answer th,');
  assert.ok(cellStart >= 0, 'table cells have their own block');
  const cell = css.slice(cellStart, css.indexOf('}', cellStart));
  assert.match(cell, /max-width:\s*\d+em/);
});

test('ask folds share one rotating caret and a finished thinking row drops its preview', async () => {
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const caretStart = css.indexOf('\n.ask-turn .ask-reading > summary::before,');
  assert.ok(caretStart >= 0, 'reading log and thinking share a caret rule');
  const caret = css.slice(caretStart, css.indexOf('}', caretStart));
  assert.match(caret, /border-left:\s*5px solid currentColor/);
  assert.match(caret, /transition:\s*transform\s*160ms/);
  assert.match(css, /\.ask-turn \.ask-reading\[open\] > summary::before,\s*\n\.ask-turn \.thinking-fold\[open\] > summary::before \{\s*\n\s*transform:\s*rotate\(90deg\);/);
  assert.match(css, /\.ask-turn \.ask-reading > summary::-webkit-details-marker,\s*\n\.ask-turn \.thinking-fold > summary::-webkit-details-marker \{\s*\n\s*display:\s*none;/);
  assert.match(css, /\.thinking-fold:not\(\.is-streaming\) \.thinking-preview \{ display: none; \}/);
  const content = css.slice(css.indexOf('@supports (interpolate-size: allow-keywords)'));
  assert.match(content, /\.ask-turn \.ask-reading::details-content/);
  assert.match(content, /\.ask-turn \.ask-reading\[open\]::details-content \{ height: auto; \}/);
});

test('bubble language picker keeps focus on its border instead of an outer ring', async () => {
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const start = css.indexOf('.bubble-target-lang:focus');
  assert.ok(start >= 0, 'language picker has a focus override');
  const block = css.slice(start, css.indexOf('}', start) + 1);
  assert.match(block, /outline:\s*none/);
  assert.match(block, /border-color:\s*var\(--accent\)/);
});

test('extension chrome sits in the toolbar and settings footer', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const toolbar = html.slice(html.indexOf('class="toolbar"'), html.indexOf('id="settings-modal"'));
  const settings = html.slice(html.indexOf('id="settings-modal"'));
  assert.match(toolbar, /id="btn-sidebar"[\s\S]*id="toolbar-more-menu"[\s\S]*id="btn-open"[\s\S]*id="btn-original-pdf"[\s\S]*id="btn-doc-properties"/);
  assert.match(html, /class="outline-pane-title"[^>]*data-i18n="outline"/);
  assert.match(toolbar, /href="#i-outline"/);
  assert.doesNotMatch(
    html.slice(html.indexOf('id="btn-sidebar"'), html.indexOf('id="btn-back"')),
    />目录</,
  );
  assert.doesNotMatch(toolbar.slice(0, toolbar.indexOf('class="toolbar-more-menu"')), /id="btn-open"/);
  assert.match(toolbar, /用浏览器打开/);
  assert.doesNotMatch(toolbar, /id="btn-extension-options"/);
  assert.doesNotMatch(settings, /id="btn-original-pdf"/);
  assert.match(
    settings,
    /class="modal-actions"[\s\S]*id="btn-extension-options"[\s\S]*PDF 接管设置[\s\S]*id="btn-settings-cancel"/,
  );
  assert.match(settings, /id="setting-reasoning-effort"/);
  assert.match(settings, /id="setting-show-thinking"/);
  assert.match(html, /id="ask-thinking-wrap"/);
  assert.doesNotMatch(html, /id="bubble-thinking-wrap"/);
  assert.match(html, /id="ask-thread"[\s\S]*class="ask-composer"/);
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
  assert.equal(app.get('viewer-loading').hidden, true);
});

test('extension shows opening during settings initialization and slow MIME startup', async () => {
  const settingsReady = deferred();
  const stream = deferred();
  let startupCalls = 0;
  let reportProgress;
  const app = await setup({
    platformId: 'extension',
    chrome: { runtime: { openOptionsPage() {} } },
    initSettings: () => settingsReady.promise,
    startup: ({ onProgress }) => { startupCalls++; reportProgress = onProgress; return stream.promise; },
  });
  assert.equal(startupCalls, 0);
  assert.equal(app.get('viewer-status').hidden, false);
  assert.equal(app.get('viewer-status-text').textContent, '正在打开…');
  assert.equal(app.get('drop-hint').toggles.hidden, true);
  assert.equal(app.viewer.openedSources.length, 0);

  settingsReady.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(startupCalls, 1);
  assert.equal(app.get('viewer-status').hidden, false);
  assert.equal(app.get('viewer-status-text').textContent, '正在打开…');
  assert.equal(app.get('drop-hint').toggles.hidden, true);
  assert.equal(app.viewer.openedSources.length, 0);

  reportProgress({ loaded: 5 * 1024 ** 2, total: 20 * 1024 ** 2 });
  assert.equal(app.get('viewer-loading').hidden, false);
  assert.equal(app.get('viewer-loading-track').getAttribute('aria-valuenow'), '25');
  assert.match(app.get('viewer-loading-detail').textContent, /5 MB.*20 MB.*25%/);
  const bytes = new Uint8Array([37, 80, 68, 70]);
  stream.resolve({ data: bytes, name: 'large.pdf', originalUrl: 'https://example.org/large.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.viewer.source.data, bytes);
  assert.equal(app.get('viewer-status').hidden, true);
  assert.equal(app.get('viewer-status-text').textContent, '');
  assert.equal(app.get('drop-hint').toggles.hidden, true);
  assert.equal(app.get('viewer-loading').hidden, true);
});

test('extension without an associated PDF returns to the normal empty state', async () => {
  const stream = deferred();
  const app = await setup({ platformId: 'extension', startup: () => stream.promise,
    chrome: { runtime: { openOptionsPage() {} } } });
  assert.equal(app.get('viewer-status').hidden, false);
  stream.resolve(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('viewer-status').hidden, true);
  assert.equal(app.get('drop-hint').toggles.hidden, false);
  assert.equal(app.viewer.openedSources.length, 0);
});

test('a late startup failure cannot replace a locally opened PDF with an error', async () => {
  let failStartup;
  let reportProgress;
  const pending = new Promise((_resolve, reject) => { failStartup = reject; });
  const app = await setup({ platformId: 'extension', startup: ({ onProgress }) => { reportProgress = onProgress; return pending; },
    chrome: { runtime: { openOptionsPage() {} } } });
  await new Promise(resolve => setImmediate(resolve));
  const file = new Blob(['%PDF-local']); file.name = 'local.pdf';
  app.fileInput.files = [file];
  await app.fileInput.listeners.change();
  assert.equal(app.get('viewer-status').hidden, true);
  reportProgress({ loaded: 1, total: 10 });
  assert.equal(app.get('viewer-loading').hidden, true);
  failStartup(new Error('old MIME request failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('viewer-status').hidden, true);
  assert.equal(app.viewer.name, 'local.pdf');
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
  assert.equal(app.get('btn-original-pdf').hidden, false);
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


test('clearing during an answer aborts it and prevents late results from restoring history', async () => {
  const pending = deferred();
  let requestSignal;
  const app = await setup({
    loadSettings: () => ({ apiKey: 'k', apiBaseUrl: 'https://mock.invalid/v1' }),
    fetchResponse: async (_url, init) => { requestSignal = init.signal; return pending.promise; },
  });
  app.viewer.pdf = {};
  app.viewer.pageCount = 1;
  app.viewer.indexedPages = 1;
  app.viewer.pageTexts = [{ pageNumber: 1, text: 'Alpha Beta' }];
  const running = app.ask.runAsk('What is Alpha?');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(requestSignal);
  assert.equal(app.get('ask-stop').hidden, false);
  app.click('ask-clear');
  assert.equal(requestSignal.aborted, true);
  assert.equal(app.ask.askThread.length, 0);
  assert.equal(app.get('ask-stop').hidden, true);
  const clearedStatus = app.get('ask-status').textContent;
  pending.resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({
    choices: [{ message: { content: 'Late answer' }, finish_reason: 'stop' }],
  }) });
  await running;
  assert.equal(app.ask.askMemory.turns.length, 0);
  assert.equal(app.ask.askMemory.summary, '');
  assert.equal(app.ask.askMemory.totalTurns, 0);
  assert.equal(app.ask.askThread.length, 0);
  assert.equal(app.get('ask-status').textContent, clearedStatus);
});


test('ask preserves provider API Key errors when a key is configured', async () => {
  const app = await setup({
    loadSettings: () => ({ apiKey: 'test-key', apiBaseUrl: 'https://mock.invalid/v1' }),
    fetchResponse: async () => { throw new Error('API Key is not authorized for this model'); },
  });
  app.viewer.pdf = {};
  app.viewer.pageCount = 1;
  app.viewer.indexedPages = 1;
  app.viewer.pageTexts = [{ pageNumber: 1, text: 'Alpha Beta' }];
  await app.ask.runAsk('What is Alpha?');
  assert.match(app.get('ask-status').textContent, /API Key is not authorized for this model/);
});


test('pinned bubble updates selections without replaying entrance animation', async () => {
  const app = await setup({ loadSettings: () => ({ autoTranslateOnSelect: true }) });
  let animations = 0;
  app.get('translate-bubble').animate = () => { animations++; return { cancel() {} }; };
  const textLayer = { closest(selector) { return selector === '.textLayer' ? this : null; } };
  const node = { parentElement: textLayer };
  const rect = { left: 10, top: 10, right: 30, bottom: 20, width: 20, height: 10 };
  const range = {
    commonAncestorContainer: { nodeType: 1 }, startContainer: node, endContainer: node,
    cloneRange() { return { collapse() {}, getClientRects: () => [rect], getBoundingClientRect: () => rect }; },
    getClientRects: () => [rect], getBoundingClientRect: () => rect,
  };
  const select = text => {
    app.setSelection({ rangeCount: 1, toString: () => text, getRangeAt: () => range });
    app.dispatchDocument('mouseup', { target: textLayer });
  };
  select('First selection');
  assert.equal(animations, 1);
  app.click('btn-bubble-pin');
  select('Second selection');
  assert.equal(animations, 1);
  app.click('btn-bubble-pin');
  select('Third selection');
  assert.equal(animations, 2);
});


test('local copy uses the save picker and writes original bytes', async () => {
  let options, written, closed = false;
  const app = await setup({ showSaveFilePicker: async value => {
    options = value;
    return { createWritable: async () => ({ write: async blob => { written = blob; }, close: async () => { closed = true; } }) };
  } });
  const file = new Blob(['%PDF-original'], { type: 'application/pdf' });
  file.name = 'local.pdf';
  app.fileInput.files = [file];
  await app.fileInput.listeners.change();
  await app.savePdf();
  assert.equal(options.suggestedName, 'local.pdf');
  assert.equal(written, file);
  assert.equal(closed, true);
  assert.equal(app.downloads.length, 0);
});

test('cancelling local save picker does not download or show an error', async () => {
  const app = await setup({ showSaveFilePicker: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } });
  const file = new Blob(['%PDF']); file.name = 'local.pdf';
  app.fileInput.files = [file];
  await app.fileInput.listeners.change();
  await app.savePdf();
  assert.equal(app.downloads.length, 0);
  assert.equal(app.get('pdf-export-notice').hidden, true);
  assert.equal(app.get('btn-save-pdf').disabled, false);
});

test('remote PDF keeps downloading even when a save picker is available', async () => {
  let picks = 0;
  const app = await setup({ startup: { data: new Uint8Array([37, 80, 68, 70]), name: 'remote.pdf', originalUrl: 'https://example.org/remote.pdf', mimeStream: true }, showSaveFilePicker: async () => { picks++; } });
  await new Promise(resolve => setImmediate(resolve));
  await app.savePdf();
  assert.equal(picks, 0);
  assert.equal(app.downloads.length, 1);
});
