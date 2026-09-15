import assert from 'node:assert/strict';
import test from 'node:test';
import { destPdfY, pickOutlineActive } from '../web/js/outline-active.js';

function entry(title, page, pdfY) {
  return { title, page, pdfY };
}

test('destPdfY reads XYZ and FitH tops', () => {
  assert.equal(destPdfY([10, 'XYZ', 0, 720, null]), 720);
  assert.equal(destPdfY([10, { name: 'XYZ' }, 0, 500, 0]), 500);
  assert.equal(destPdfY([10, 'FitH', 640]), 640);
  assert.equal(Number.isNaN(destPdfY([10, 'XYZ', 0, null, null])), true);
  assert.equal(Number.isNaN(destPdfY('named')), true);
});

test('same-page 1.1/1.2/1.3 highlight the heading at the reading Y, not the last one', () => {
  const a = entry('1.1', 11, 700);
  const b = entry('1.2', 11, 500);
  const c = entry('1.3', 11, 300);
  const items = [a, b, c];
  assert.equal(pickOutlineActive(items, { page: 11, pdfY: 700 }), a);
  assert.equal(pickOutlineActive(items, { page: 11, pdfY: 500 }), b);
  assert.equal(pickOutlineActive(items, { page: 11, pdfY: 300 }), c);
  assert.equal(pickOutlineActive(items, { page: 11, pdfY: 790 }), a);
});

test('same-page entries without Y snap to the first heading, not the last', () => {
  const a = entry('1.1', 11, NaN);
  const b = entry('1.2', 11, NaN);
  const c = entry('1.3', 11, NaN);
  assert.equal(pickOutlineActive([a, b, c], { page: 11, pdfY: NaN }), a);
});

test('same-page ties follow outline preorder (parent before children)', () => {
  const parent = entry('Chapter', 8, NaN);
  const child = entry('Section', 8, NaN);
  assert.equal(pickOutlineActive([parent, child], { page: 8, pdfY: NaN }), parent);
  assert.equal(pickOutlineActive([child, parent], { page: 8, pdfY: NaN }), child);
});

test('later page still wins over earlier chapters', () => {
  const chapter = entry('1', 10, 100);
  const a = entry('1.1', 11, 700);
  assert.equal(pickOutlineActive([chapter, a], { page: 11, pdfY: 700 }), a);
});

test('before any destination the outline highlights nothing', () => {
  const later = entry('Chapter 2', 12, 700);
  assert.equal(pickOutlineActive([later], { page: 1, pdfY: 400 }), null);
  const cover = entry('Cover', 3, NaN);
  const end = entry('Later', 20, NaN);
  assert.equal(pickOutlineActive([cover, end], { page: 1, pdfY: NaN }), null);
});
