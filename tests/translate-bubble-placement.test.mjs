import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBubblePlacement,
  maxBubbleWidthForViewport,
} from "../web/js/translate-bubble-placement.js";

const viewport = { left: 200, top: 48, right: 1720, bottom: 1032, width: 1520, height: 984 };

test("selection near bottom of viewport places bubble above", () => {
  const selection = {
    left: 400,
    top: 980,
    right: 700,
    bottom: 1000,
    width: 300,
    height: 20,
  };
  const bubbleW = 420;
  const bubbleH = 160;
  const { top, placeBelow } = computeBubblePlacement(selection, viewport, bubbleW, bubbleH);
  assert.equal(placeBelow, false);
  assert.ok(top + bubbleH <= selection.top);
});

test("selection near top of viewport places bubble below", () => {
  const selection = {
    left: 400,
    top: 80,
    right: 700,
    bottom: 100,
    width: 300,
    height: 20,
  };
  const bubbleW = 420;
  const bubbleH = 160;
  const { top, placeBelow } = computeBubblePlacement(selection, viewport, bubbleW, bubbleH);
  assert.equal(placeBelow, true);
  assert.ok(top >= selection.bottom);
});

test("horizontal position clamps inside viewport", () => {
  const selection = {
    left: 1650,
    top: 400,
    right: 1700,
    bottom: 420,
    width: 50,
    height: 20,
  };
  const bubbleW = 420;
  const bubbleH = 120;
  const { left } = computeBubblePlacement(selection, viewport, bubbleW, bubbleH);
  assert.ok(left >= viewport.left + 8);
  assert.ok(left + bubbleW <= viewport.right - 8);
});

test("narrow viewport clamps bubble left inside viewer when wider than scrollport", () => {
  const narrow = { left: 320, top: 48, right: 520, bottom: 1032, width: 200, height: 984 };
  const bubbleW = maxBubbleWidthForViewport(narrow);
  assert.ok(bubbleW < 420);
  const { left } = computeBubblePlacement(
    { left: 100, top: 400, right: 200, bottom: 420, width: 100, height: 20 },
    narrow,
    bubbleW,
    120,
  );
  assert.ok(left >= narrow.left + 8);
  assert.ok(left + bubbleW <= narrow.right - 8);
});

test("maxHeight keeps bubble inside viewport", () => {
  const selection = {
    left: 500,
    top: 900,
    right: 800,
    bottom: 920,
    width: 300,
    height: 20,
  };
  const bubbleW = 420;
  const bubbleH = 400;
  const { top, maxHeight } = computeBubblePlacement(selection, viewport, bubbleW, bubbleH);
  assert.ok(top + maxHeight <= viewport.bottom - 8);
});

test("mid-text selection is not covered after clamping", () => {
  // Tall bubble in a short viewport: the first choice clamps over the
  // selection line, so placement must try the other side.
  const short = { left: 200, top: 48, right: 1720, bottom: 420, width: 1520, height: 372 };
  const selection = {
    left: 400,
    top: 300,
    right: 700,
    bottom: 320,
    width: 300,
    height: 20,
  };
  const bubbleW = 420;
  const bubbleH = 300;
  const { top } = computeBubblePlacement(selection, short, bubbleW, bubbleH);
  const gap = 8;
  const overlaps =
    top < selection.bottom + gap &&
    top + bubbleH > selection.top - gap &&
    400 < selection.right &&
    400 + bubbleW > selection.left;
  assert.equal(overlaps, false);
});
