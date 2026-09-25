import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadReadingPosition,
  readingFingerprint,
  saveReadingPosition,
} from '../web/js/reading-position.js';

test('readingFingerprint uses path and file identity instead of session ids', () => {
  assert.equal(
    readingFingerprint({ name: 'a.pdf', path: '/home/u/a.pdf', url: '/opened/deadbeef0123456789abcdef01234567.pdf' }),
    'path:/home/u/a.pdf',
  );
  assert.equal(
    readingFingerprint({ name: 'a.pdf', path: '/home/u/a.pdf', url: '/opened/00000000000000000000000000000001.pdf' }),
    'path:/home/u/a.pdf',
  );
  assert.equal(
    readingFingerprint({ name: 'a.pdf', url: 'blob:abc', size: 42, lastModified: 7 }),
    'file:a.pdf:42:7',
  );
  assert.notEqual(
    readingFingerprint({ name: 'a.pdf', url: 'blob:1', size: 1, lastModified: 1 }),
    readingFingerprint({ name: 'a.pdf', url: 'blob:2', size: 2, lastModified: 1 }),
  );
});

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
