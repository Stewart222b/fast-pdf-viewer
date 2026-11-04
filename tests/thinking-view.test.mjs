import test from "node:test";
import assert from "node:assert/strict";
import { renderThinking, thinkingPreview } from "../web/js/thinking-view.js";

function elements() {
  return { wrap: { hidden: true, open: false, classList: { toggle() {} } },
    body: { textContent: "", scrollHeight: 900, scrollTop: 0, clientHeight: 200 },
    preview: {}, status: {} };
}

test("streaming updates one collapsed preview and all expanded content without changing disclosure", () => {
  const els = elements();
  const options = { enabled: true, streaming: true, label: active => active ? "Thinking" : "Done" };
  renderThinking(els, "First line\nLatest partial", options);
  assert.equal(els.preview.textContent, "Latest partial");
  assert.equal(els.wrap.open, false);
  els.wrap.open = true;
  renderThinking(els, "First line\nLatest partial completed", options);
  assert.equal(els.wrap.open, true);
  assert.equal(els.body.textContent, "First line\nLatest partial completed");
  assert.equal(els.body.scrollTop, 0, "user reading above the bottom is not pulled down");
  renderThinking(els, els.body.textContent, { ...options, streaming: false });
  assert.equal(els.status.textContent, "Done");
  assert.equal(els.wrap.open, true);
  renderThinking(els, "private", { enabled: false });
  assert.equal(els.wrap.hidden, true);
  assert.equal(els.body.textContent, "");
  assert.equal(els.preview.textContent, "");
});

test("one-line preview is bounded and never interprets HTML", () => {
  assert.equal(thinkingPreview("old\n<script>raw</script>"), "<script>raw</script>");
  assert.equal(thinkingPreview("x".repeat(900)).length, 240);
});
