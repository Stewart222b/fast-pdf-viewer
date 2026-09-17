// Run: node --experimental-vm-modules --test tests/bubble-text-render.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  renderBubbleSource,
  renderBubbleTranslation,
  readBubblePlainText,
} from "../web/js/bubble-text-render.js";

function element(tagName = "div") {
  const el = {
    tagName: tagName.toUpperCase(),
    children: [],
    className: "",
    attributes: {},
    classList: {
      toggles: {},
      toggle(name, on) { this.toggles[name] = Boolean(on); },
      remove(name) { this.toggles[name] = false; },
    },
    append(...nodes) {
      this._textContent = "";
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this._textContent = "";
      this.children = [...nodes];
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
  };
  Object.defineProperty(el, "textContent", {
    get() {
      return `${el._textContent || ""}${el.children.map((child) => child.textContent || "").join("")}`;
    },
    set(value) {
      el._textContent = String(value ?? "");
      el.children = [];
    },
  });
  return el;
}

function sourceEl() {
  return element();
}

function withDocument(callback) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => element(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
  };
  try {
    return callback();
  } finally {
    globalThis.document = previous;
  }
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

test("renderBubbleTranslation formats inline emphasis and ordered or bullet lists", () => {
  withDocument(() => {
    const el = sourceEl();
    renderBubbleTranslation(
      el,
      "Name\n\n**name** [n]\n\n**n.**\n1. 名字，名称\n2. 名誉，名望\n\n- First meaning\n• Second meaning",
      "term",
    );

    assert.deepEqual(el.children.map((node) => node.tagName), ["P", "P", "P", "OL", "UL"]);
    assert.equal(el.children[1].children[0].tagName, "STRONG");
    assert.equal(el.children[1].textContent, "name [n]");
    assert.deepEqual(el.children[3].children.map((node) => node.textContent), ["名字，名称", "名誉，名望"]);
    assert.equal(el.children[4].children.length, 2);
    assert.doesNotMatch(readBubblePlainText(el), /\*\*/);
  });
});

test("renderBubbleTranslation keeps HTML and links as plain text", () => {
  withDocument(() => {
    const el = sourceEl();
    const raw = '<img src=x onerror="alert(1)"> [link](javascript:alert(1))';
    renderBubbleTranslation(el, raw, "passage");
    assert.equal(el.children[0].tagName, "P");
    assert.equal(el.children[0].textContent, raw);
    assert.deepEqual(el.children[0].children.map((node) => node.tagName || "TEXT"), ["TEXT"]);
  });
});

test("renderBubbleTranslation formats headings, quotes, and fenced code blocks", () => {
  withDocument(() => {
    const el = sourceEl();
    renderBubbleTranslation(el, "## Notes\n\n> A *quoted* line.\n\n```html\n<img src=x>\n```", "passage");
    assert.deepEqual(el.children.map((node) => node.tagName), ["H2", "BLOCKQUOTE", "PRE"]);
    assert.equal(el.children[1].children[0].children[1].tagName, "EM");
    assert.equal(el.children[2].children[0].textContent, "<img src=x>");
  });
});

test("renderBubbleTranslation leaves streaming markdown raw until completion", () => {
  withDocument(() => {
    const el = sourceEl();
    renderBubbleTranslation(el, "**partial**", "term", { streaming: true });
    assert.equal(el.children[0].textContent, "**partial**");
    assert.equal(el.children[1].className, "translate-caret");
  });
});
