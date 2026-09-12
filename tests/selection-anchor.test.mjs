import assert from "node:assert/strict";
import test from "node:test";
import { getSelectionAnchorRect } from "../web/js/selection-anchor.js";

const viewport = { left: 0, top: 100, right: 800, bottom: 900, width: 800, height: 800 };

function mockRange(clientRects, union, endRects = []) {
  const endBox = endRects[endRects.length - 1] || union;
  return {
    getClientRects: () => clientRects,
    cloneRange: () => ({
      collapse: () => {},
      getClientRects: () => endRects,
      getBoundingClientRect: () => endBox,
    }),
    getBoundingClientRect: () => union,
  };
}

test("prefers collapsed end range client rect over earlier visible lines", () => {
  const endLine = { left: 80, top: 820, right: 420, bottom: 840, width: 340, height: 20 };
  const range = mockRange(
    [
      { left: 80, top: 200, right: 420, bottom: 220, width: 340, height: 20 },
      endLine,
    ],
    { left: 80, top: 200, right: 420, bottom: 840, width: 340, height: 640 },
    [endLine],
  );
  const anchor = getSelectionAnchorRect(range, viewport);
  assert.equal(anchor.bottom, 840);
});

test("uses last visible client rect instead of huge union box", () => {
  const endLine = { left: 40, top: 820, right: 400, bottom: 840, width: 360, height: 20 };
  const range = mockRange(
    [
      { left: 40, top: 50, right: 400, bottom: 70, width: 360, height: 20 },
      endLine,
    ],
    { left: 40, top: 50, right: 400, bottom: 840, width: 360, height: 790 },
    [endLine],
  );
  const anchor = getSelectionAnchorRect(range, viewport);
  assert.equal(anchor.bottom, 840);
  assert.ok(anchor.top > viewport.top);
});

test("falls back to last client rect when none intersect viewport", () => {
  const range = mockRange(
    [{ left: 10, top: 10, right: 100, bottom: 30, width: 90, height: 20 }],
    { left: 10, top: 10, right: 100, bottom: 30, width: 90, height: 20 },
  );
  const anchor = getSelectionAnchorRect(range, viewport);
  assert.equal(anchor.bottom, 30);
});
