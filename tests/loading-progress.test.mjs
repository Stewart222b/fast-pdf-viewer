import test from "node:test";
import assert from "node:assert/strict";
import { createLoadingProgress, formatLoadingBytes } from "../web/js/loading-progress.js";

function fixture() {
  const node = () => ({ hidden: true, dataset: {}, style: {}, attrs: {}, textContent: "",
    setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; } });
  const elements = { wrap: node(), track: node(), fill: node(), detail: node() };
  const progress = createLoadingProgress(elements, {
    translate: (key, values = {}) => `${key} ${JSON.stringify(values)}`, locale: () => "en",
  });
  return { ...elements, progress };
}

test("unknown sizes remain indeterminate and report actual received bytes", () => {
  const { progress, wrap, track, detail } = fixture();
  progress.start();
  assert.equal(wrap.hidden, false);
  assert.equal(wrap.dataset.mode, "indeterminate");
  progress.update({ loaded: 1024 * 1024, total: 0 });
  assert.equal(track.attrs["aria-valuenow"], undefined);
  assert.match(detail.textContent, /1 MB/);
  assert.doesNotMatch(detail.textContent, /percent/);
});

test("known sizes show byte-based percentages and switch to preparation without a fake percentage", () => {
  const { progress, wrap, track, fill, detail } = fixture();
  progress.start();
  progress.update({ loaded: 5 * 1024 ** 2, total: 20 * 1024 ** 2 });
  assert.equal(wrap.dataset.mode, "determinate");
  assert.equal(fill.style.width, "25%");
  assert.equal(track.attrs["aria-valuenow"], "25");
  progress.update({ phase: "prepare" });
  assert.equal(wrap.dataset.mode, "indeterminate");
  assert.equal(track.attrs["aria-valuenow"], undefined);
  assert.match(detail.textContent, /pdfLoadingPrepare/);
  progress.stop();
  progress.update({ loaded: 20, total: 20 });
  assert.equal(wrap.hidden, true);
  assert.equal(detail.textContent, "");
});

test("inconsistent totals do not produce percentages above 100 and new opens reset counters", () => {
  const { progress, wrap, track } = fixture();
  progress.start(); progress.update({ loaded: 2000, total: 1000 });
  assert.equal(wrap.dataset.mode, "indeterminate");
  assert.equal(track.attrs["aria-valuenow"], undefined);
  progress.start(); progress.update({ loaded: 10, total: 100 });
  assert.equal(track.attrs["aria-valuenow"], "10");
  assert.equal(formatLoadingBytes(20 * 1024 ** 2), "20 MB");
});
