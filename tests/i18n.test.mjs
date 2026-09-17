import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentTranslations, getLocale, setLocale, t } from "../web/js/i18n.js";

test("interface locale supports Chinese, English, and a Chinese fallback", () => {
  setLocale("en");
  assert.equal(getLocale(), "en");
  assert.equal(t("save"), "Save");
  assert.equal(t("modelFound", { model: "demo", count: 3 }), "✓ Found demo in the model list (3 models)");

  setLocale("fr");
  assert.equal(getLocale(), "zh-CN");
  assert.equal(t("save"), "保存");
});

test("document translations update text, titles, labels, placeholders, and html lang", () => {
  const elements = [
    { attrs: { "data-i18n": "save" }, getAttribute(name) { return this.attrs[name]; } },
    { attrs: { "data-i18n-title": "settings" }, getAttribute(name) { return this.attrs[name]; } },
    { attrs: { "data-i18n-aria": "search" }, getAttribute(name) { return this.attrs[name]; }, setAttribute(name, value) { this.attrs[name] = value; } },
    { attrs: { "data-i18n-placeholder": "searchDocument" }, getAttribute(name) { return this.attrs[name]; } },
  ];
  const root = {
    documentElement: { lang: "" },
    querySelectorAll(selector) {
      const attribute = selector.slice(1, -1);
      return elements.filter(element => attribute in element.attrs);
    },
  };

  setLocale("en");
  applyDocumentTranslations(root);
  assert.equal(root.documentElement.lang, "en");
  assert.equal(elements[0].textContent, "Save");
  assert.equal(elements[1].title, "Settings");
  assert.equal(elements[2].attrs["aria-label"], "Search");
  assert.equal(elements[3].placeholder, "Search document");
  setLocale("zh-CN");
});
