import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearReadingPositions,
  loadReadingPosition,
  pruneReadingPositions,
  readingFingerprint,
  saveReadingPosition,
} from '../web/js/reading-position.js';

test('readingFingerprint uses stable file identity without storing a raw path', () => {
  const a = readingFingerprint({ name: 'a.pdf', path: '/home/u/a.pdf', url: '/opened/deadbeef0123456789abcdef01234567.pdf' });
  assert.equal(
    readingFingerprint({ name: 'a.pdf', path: '/home/u/a.pdf', url: '/opened/00000000000000000000000000000001.pdf' }),
    a,
  );
  assert.match(a, /^path:[a-f0-9]{16}$/);
  assert.equal(a.includes('/home/u/'), false);
  assert.match(readingFingerprint({ name: 'a.pdf', url: 'blob:abc', size: 42, lastModified: 7 }), /^file:[a-f0-9]{16}$/);
  assert.notEqual(
    readingFingerprint({ name: 'a.pdf', url: 'blob:1', size: 1, lastModified: 1 }),
    readingFingerprint({ name: 'a.pdf', url: 'blob:2', size: 2, lastModified: 1 }),
  );
});

test('URL keys hide query values while preserving distinct documents', () => {
  const first = readingFingerprint({ path: 'https://example.test/download?id=one&token=secret' });
  const second = readingFingerprint({ path: 'https://example.test/download?id=two&token=secret' });
  assert.notEqual(first, second);
  assert.equal(first.includes('secret'), false);
  const bytes = new Uint8Array([37, 80, 68, 70, 1, 2]);
  assert.equal(
    readingFingerprint({ path: 'https://example.test/download?sig=old', data: bytes }),
    readingFingerprint({ path: 'https://example.test/download?sig=new', data: bytes }),
  );
  assert.notEqual(
    readingFingerprint({ path: 'https://example.test/download?sig=new', data: bytes }),
    readingFingerprint({ path: 'https://example.test/download?sig=new', data: new Uint8Array([37, 80, 68, 70, 1, 3]) }),
  );
});

function withStore(run) {
  const store = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  try { run(store); } finally { globalThis.localStorage = original; }
}

test('save and load roundtrip', () => {
  const store = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const fp = readingFingerprint({ name: 'doc.pdf', url: 'blob:x', size: 10, lastModified: 3 });
  saveReadingPosition(fp, { page: 3, zoom: '150', scrollTop: 120, scrollLeft: 0 });
  const loaded = loadReadingPosition(fp);
  assert.equal(loaded.page, 3);
  assert.equal(loaded.scrollTop, 120);
  globalThis.localStorage = original;
});

test('save and load preserves a PDF-space reading anchor', () => {
  const store = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const fp = readingFingerprint({ name: 'doc.pdf', url: 'blob:x', size: 10, lastModified: 3 });
  const anchor = { page: 8, pdfX: 12.5, pdfY: 640 };
  saveReadingPosition(fp, { page: 8, zoom: 'page-width', scrollTop: 4000, scrollLeft: 0, anchor });
  assert.deepEqual(loadReadingPosition(fp).anchor, anchor);
  globalThis.localStorage = original;
});

test('legacy URL key migrates to a private key and expired records are removed', () => withStore(store => {
  const source = { path: 'https://example.test/download?token=old-secret' };
  const legacyKey = `fast-pdf-reader-position:path:${source.path}`;
  store.set(legacyKey, JSON.stringify({ page: 7, savedAt: Date.now() }));
  const fingerprint = readingFingerprint(source);
  assert.equal(loadReadingPosition(fingerprint, source).page, 7);
  assert.equal(store.has(legacyKey), false);
  assert.equal(store.has(`fast-pdf-reader-position:${fingerprint}`), true);
  const key = `fast-pdf-reader-position:${fingerprint}`;
  store.set(key, JSON.stringify({ page: 7, savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 }));
  assert.equal(loadReadingPosition(fingerprint), null);
  assert.equal(store.has(key), false);
}));

test('pruning rewrites legacy URL keys before the document is reopened', () => withStore(store => {
  const source = {
    path: 'https://example.test/download?token=old-secret',
    data: new Uint8Array([37, 80, 68, 70, 1]),
  };
  const legacyKey = `fast-pdf-reader-position:path:${source.path}`;
  store.set(legacyKey, JSON.stringify({ page: 4, savedAt: Date.now() }));
  pruneReadingPositions();
  assert.equal(store.has(legacyKey), false);
  assert.equal([...store.keys()].some(key => key.includes('old-secret')), false);
  assert.equal(loadReadingPosition(readingFingerprint(source), source).page, 4);
}));

test('reading records are capped and can be cleared without touching other storage', () => withStore(store => {
  store.set('unrelated', 'keep');
  for (let i = 0; i < 102; i += 1) {
    saveReadingPosition(readingFingerprint({ path: `/documents/document-${i}.pdf` }), { page: i + 1 });
  }
  pruneReadingPositions();
  assert.equal([...store.keys()].filter(key => key.startsWith('fast-pdf-reader-position:')).length, 100);
  assert.equal(store.has(`fast-pdf-reader-position:${readingFingerprint({ path: '/documents/document-101.pdf' })}`), true);
  clearReadingPositions();
  assert.deepEqual([...store.keys()], ['unrelated']);
}));
