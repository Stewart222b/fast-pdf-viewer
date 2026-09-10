// Run: node --experimental-vm-modules --test tests/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function layer() {
  return { children: [], style: { setProperty() {} }, replaceChildren() { this.children = []; }, appendChild(el) { this.children.push(el); } };
}
function pageElement() {
  const layers = { '.hlLayer': layer(), '.textLayer': layer(), '.linkLayer': layer(), canvas: { style: {}, getContext() { return {}; } } };
  return { dataset: {}, style: { setProperty() {} }, offsetTop: 100, offsetLeft: 0, querySelector: name => layers[name] };
}
async function setup(load = () => { throw new Error('unexpected load'); }) {
  const context = vm.createContext({
    URL, console, setTimeout, clearTimeout,
    window: { devicePixelRatio: 1 },
    document: { createElement: () => ({ style: {} }) },
    requestAnimationFrame: f => f(),
  });
  const mock = new vm.SyntheticModule(['getDocument', 'GlobalWorkerOptions', 'TextLayer', 'setLayerDimensions'], function () {
    this.setExport('getDocument', load);
    this.setExport('GlobalWorkerOptions', {});
    this.setExport('TextLayer', class { async render() {} cancel() {} });
    this.setExport('setLayerDimensions', () => {});
  }, { context });
  const modules = new Map();
  async function module(name) {
    if (!modules.has(name)) {
      const source = await readFile(new URL(`../web/js/${name}.js`, import.meta.url), 'utf8');
      const result = new vm.SourceTextModule(source, { context, initializeImportMeta: meta => { meta.url = `file:///web/js/${name}.js`; } });
      modules.set(name, result);
      await result.link(spec => spec.includes('vendor') ? mock : module(spec.replace('./', '').replace('.js', '')));
      await result.evaluate();
    }
    return modules.get(name);
  }
  const Viewer = (await module('viewer')).namespace.PdfViewer;
  const History = (await module('history')).namespace.ViewHistory;
  const history = new History();
  const wrapEl = { scrollTop: 0, scrollLeft: 0, clientHeight: 500, removeEventListener() {}, addEventListener() {}, scrollTo(p) { this.scrollTop = p.top ?? this.scrollTop; this.scrollLeft = p.left ?? this.scrollLeft; } };
  const viewer = new Viewer({ pagesEl: { replaceChildren() {} }, wrapEl, history });
  viewer.buildPlaceholders = () => { viewer.pageEls = Array.from({ length: viewer.pageCount }, pageElement); };
  viewer.setZoom = () => {};
  viewer.observe = () => {};
  return { viewer, history, wrapEl };
}
const content = text => ({ items: [{ str: text, width: text.length * 10, height: 10, transform: [10, 0, 0, 10, 0, 700] }] });
const viewport = { width: 600, height: 800, scale: 1, convertToViewportPoint: (x, y) => [x, y] };
function pdf(text) {
  return { numPages: 1, destroyed: false, destroy() { this.destroyed = true; }, getPage: async () => ({
    getViewport: () => viewport, getTextContent: async () => content(text),
    render: () => ({ promise: Promise.resolve(), cancel() {} }), getAnnotations: async () => [],
  }) };
}

test('latest open wins when an earlier loading task finishes late', async () => {
  const a = deferred(), b = deferred();
  let destroyed = 0, call = 0;
  const { viewer } = await setup(() => ({ promise: (++call === 1 ? a : b).promise, destroy() { destroyed++; } }));
  const openingA = viewer.open({ name: 'A' });
  const openingB = viewer.open({ name: 'B' });
  b.resolve(pdf('B')); await openingB; await viewer.indexPromise;
  a.resolve(pdf('A')); assert.equal(await openingA, null);
  assert.equal(viewer.name, 'B'); assert.equal(viewer.pageTexts[0].text, 'B');
  assert.equal(destroyed, 1);
});

test('stale index cannot write text into the next document', async () => {
  const { viewer } = await setup();
  const waiting = deferred();
  viewer.pdf = { numPages: 2, destroy() {}, getPage: async () => ({ getTextContent: () => waiting.promise }) };
  const indexing = viewer.indexText(); await Promise.resolve();
  viewer.close(); viewer.pdf = pdf('B');
  await viewer.indexText(); waiting.resolve(content('A')); await indexing;
  assert.equal(viewer.pageTexts[0].text, 'B');
  assert.equal(viewer.textContents.has(1), false);
});

test('close resets document state and releases loading resources', async () => {
  const { viewer, wrapEl } = await setup();
  let destroyed = 0, cancelled = 0;
  viewer.loadingTask = { destroy() { destroyed++; } };
  viewer.tasks.set(1, { cancel() { cancelled++; } });
  viewer.textLayers.set(1, { cancel() { cancelled++; } });
  viewer.currentPage = 50; viewer.pageCount = 100; viewer.name = 'old'; wrapEl.scrollTop = 500;
  viewer.close(); await Promise.resolve();
  assert.equal(destroyed, 1); assert.equal(cancelled, 2);
  assert.equal(viewer.currentPage, 1); assert.equal(viewer.pageCount, 0);
  assert.equal(viewer.name, ''); assert.equal(wrapEl.scrollTop, 0);
});

test('old render waiting for a page never starts drawing after close', async () => {
  const { viewer } = await setup();
  const waiting = deferred(); let rendered = false;
  viewer.pdf = { getPage: () => waiting.promise, destroy() {} };
  viewer.pageEls = [pageElement()];
  const rendering = viewer.renderPage(1); await Promise.resolve();
  viewer.close(); waiting.resolve({ render() { rendered = true; } });
  await rendering; assert.equal(rendered, false);
});

test('clearing or changing hits removes highlights from previous pages', async () => {
  const { viewer } = await setup();
  viewer.pdf = pdf('ABC'); viewer.pageEls = [pageElement(), pageElement()];
  viewer.textContents.set(1, content('ABC')); viewer.textContents.set(2, content('ABC'));
  viewer.jumpToHit = async () => {};
  await viewer.showHits([{ pageNumber: 1, offset: 0, length: 1 }], 'A');
  assert.equal(viewer.pageEls[0].querySelector('.hlLayer').children.length, 1);
  await viewer.showHits([{ pageNumber: 2, offset: 1, length: 1 }], 'B');
  assert.equal(viewer.pageEls[0].querySelector('.hlLayer').children.length, 0);
  await viewer.showHits([], '');
  assert.equal(viewer.pageEls[1].querySelector('.hlLayer').children.length, 0);
});

test('late highlight painting cannot resurrect a cleared query', async () => {
  const { viewer } = await setup(); const waiting = deferred();
  viewer.pdf = { getPage: () => waiting.promise }; viewer.pageEls = [pageElement()];
  viewer.textContents.set(1, content('A')); viewer.jumpToHit = async () => {};
  const old = viewer.showHits([{ pageNumber: 1, offset: 0, length: 1 }], 'A');
  await viewer.showHits([], ''); waiting.resolve({ getViewport: () => viewport }); await old;
  assert.equal(viewer.pageEls[0].querySelector('.hlLayer').children.length, 0);
});

test('search jump positions the match and history restores reading position', async () => {
  const { viewer, history, wrapEl } = await setup();
  viewer.pdf = pdf('ABC'); viewer.pageCount = 1; viewer.pageEls = [pageElement()];
  wrapEl.scrollTop = 20; history.reset(viewer.getState());
  await viewer.showHits([{ pageNumber: 1, offset: 1, length: 1 }], 'B');
  assert.equal(wrapEl.scrollTop, 736);
  viewer.back(); assert.equal(wrapEl.scrollTop, 20);
  viewer.forward(); assert.equal(wrapEl.scrollTop, 736);
});

test('obsolete load failure does not close the new document', async () => {
  const a = deferred(); let call = 0;
  const { viewer } = await setup(() => ({ promise: ++call === 1 ? a.promise : Promise.resolve(pdf('B')), destroy() {} }));
  const old = viewer.open({ name: 'A' }); await viewer.open({ name: 'B' });
  a.reject(new Error('cancelled old load')); assert.equal(await old, null);
  assert.equal(viewer.name, 'B');
});

test('page navigation records the destination before immediate back/forward', async () => {
  const { viewer, history, wrapEl } = await setup();
  viewer.pageCount = 2;
  viewer.pageEls = [pageElement(), pageElement()];
  viewer.pageEls[1].offsetTop = 1000;
  wrapEl.scrollTop = 120;
  history.reset(viewer.getState());
  const scrollTo = wrapEl.scrollTo.bind(wrapEl);
  wrapEl.scrollTo = position => {
    // Browsers do not update scrollTop to the destination synchronously for smooth scrolling.
    if (position.behavior !== 'smooth') scrollTo(position);
  };
  viewer.goToPage(2, { push: true });
  assert.equal(history.current().scrollTop, 984);
  viewer.back(); assert.equal(wrapEl.scrollTop, 120);
  viewer.forward(); assert.equal(wrapEl.scrollTop, 984);
  assert.equal(viewer.currentPage, 2);
});

test('a late link destination cannot override a newer page navigation', async () => {
  const { viewer } = await setup();
  const waiting = deferred();
  viewer.pdf = { getDestination: () => waiting.promise };
  viewer.pageCount = 3; viewer.pageEls = [pageElement(), pageElement(), pageElement()];
  const old = viewer.goToDest('old-link', true);
  viewer.goToPage(3, { push: true });
  waiting.resolve([0]); await old;
  assert.equal(viewer.currentPage, 3);
});

test('back navigation cancels a pending search jump', async () => {
  const { viewer, history, wrapEl } = await setup();
  viewer.pdf = pdf('A'); viewer.pageCount = 2; viewer.pageEls = [pageElement(), pageElement()];
  wrapEl.scrollTop = 20; history.reset(viewer.getState());
  viewer.pageEls[1].offsetTop = 1000;
  viewer.goToPage(2, { push: true, instant: true });
  viewer.hits = [{ pageNumber: 1, offset: 0, length: 1 }];
  const waiting = deferred(); viewer.renderPage = () => waiting.promise;
  const jumping = viewer.jumpToHit(0, { push: true });
  viewer.back(); waiting.resolve(); await jumping;
  assert.equal(wrapEl.scrollTop, 20);
  assert.equal(history.index, 0);
});


test('page cache evicts offscreen canvases and retains visible pages', async () => {
  const { viewer, wrapEl } = await setup();
  viewer.pageEls = Array.from({ length: 12 }, (_, i) => {
    const el = pageElement(); el.offsetTop = i * 900; el.offsetHeight = 800;
    el.querySelector('canvas').width = 600; el.querySelector('canvas').height = 800;
    el.dataset.renderedZoom = '1.500'; return el;
  });
  let cleaned = 0;
  for (let i = 1; i <= 12; i++) {
    viewer.renderedPages.set(i, { cleanup() { cleaned++; } });
    viewer.textContents.set(i, content('test'));
  }
  wrapEl.scrollTop = 10 * 900;
  viewer.trimCache();
  assert.equal(viewer.renderedPages.size, 8);
  assert.equal(cleaned, 4);
  assert.equal(viewer.pageEls[0].querySelector('canvas').width, 0);
  assert.equal(viewer.renderedPages.has(11), true);
  assert.equal(viewer.textContents.has(1), false);
});

test('index exposes early page results while a later page is still pending', async () => {
  const { viewer } = await setup();
  const slow = deferred(), indexed = deferred();
  viewer.pdf = { numPages: 2, getPage: async n => ({ getTextContent: () => n === 1 ? Promise.resolve(content('early')) : slow.promise }) };
  viewer.onIndex = () => { if (viewer.indexedPages === 1) indexed.resolve(); };
  const job = viewer.indexText();
  await indexed.promise;
  assert.equal(viewer.pageTexts[0].text, 'early');
  assert.equal(viewer.indexedPages, 1);
  slow.resolve(content('late')); await job;
  assert.equal(viewer.indexedPages, 2);
});
