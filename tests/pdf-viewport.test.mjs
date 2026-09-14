import assert from 'node:assert/strict';
import test from 'node:test';
import { convertCssToPdfPoint, convertPdfToCssPoint } from '../web/js/pdf-viewport.js';

const layout90 = {
  viewBox: [0, 0, 612, 792],
  rotation: 90,
  userUnit: 1,
};

test('rotated page maps CSS probe through viewport inverse transform', () => {
  const scale = 1.5;
  const [pdfX, pdfY] = convertCssToPdfPoint(layout90, scale, 100, 200);
  const [cssX, cssY] = convertPdfToCssPoint(layout90, scale, pdfX, pdfY);
  assert.ok(Math.abs(cssX - 100) < 0.01);
  assert.ok(Math.abs(cssY - 200) < 0.01);
});

test('convertCssToPdfPoint falls back to NaN without viewBox metadata', () => {
  const [x, y] = convertCssToPdfPoint({ width: 612, height: 792 }, 1, 10, 20);
  assert.equal(Number.isNaN(x), true);
  assert.equal(Number.isNaN(y), true);
});
