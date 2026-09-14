// Run: node --experimental-vm-modules --test tests/bubble-text-render.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  renderBubbleSource,
  readBubblePlainText,
} from "../web/js/bubble-text-render.js";

function sourceEl() {
  return {
    classList: { toggles: {}, toggle(name, on) { this.toggles[name] = on; } },
    textContent: "",
    replaceChildren() {
      this.children = [];
      this.textContent = "";
    },
    children: [],
    append(child) {
      this.children.push(child);
    },
  };
}

test("renderBubbleSource truncates long previews by default", () => {
  const el = sourceEl();
  const text = "x".repeat(600);
  renderBubbleSource(el, text, "term");
  assert.equal(readBubblePlainText(el).length, 481);
  assert.match(readBubblePlainText(el), /…$/);
});

test("renderBubbleSource can render the full selection when expanded", () => {
  const el = sourceEl();
  const text = "y".repeat(600);
  renderBubbleSource(el, text, "term", { full: true });
  assert.equal(readBubblePlainText(el).length, 600);
  assert.doesNotMatch(readBubblePlainText(el), /…$/);
});
