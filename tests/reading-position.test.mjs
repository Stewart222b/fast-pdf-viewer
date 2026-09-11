import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadReadingPosition,
  readingFingerprint,
  saveReadingPosition,
} from '../web/js/reading-position.js';

test('readingFingerprint distinguishes blob and desktop ids', () => {
  assert.equal(readingFingerprint({ name: 'a.pdf', url: 'blob:abc' }), 'blob:a.pdf');
  assert.equal(
    readingFingerprint({ name: 'a.pdf', url: '/opened/deadbeef0123456789abcdef01234567.pdf' }),
    'desktop:deadbeef0123456789abcdef01234567:a.pdf',
  );
});

test('save and load roundtrip', () => {
  const store = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const fp = readingFingerprint({ name: 'doc.pdf', url: 'blob:x' });
  saveReadingPosition(fp, { page: 3, zoom: '150', scrollTop: 120, scrollLeft: 0 });
  const loaded = loadReadingPosition(fp);
  assert.equal(loaded.page, 3);
  assert.equal(loaded.scrollTop, 120);
  globalThis.localStorage = original;
});
