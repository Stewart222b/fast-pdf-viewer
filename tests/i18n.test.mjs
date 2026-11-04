import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentTranslations, getLocale, setLocale, t, messages } from "../web/js/i18n.js";
import { INTERFACE_LANGUAGES, TRANSLATION_LANGUAGES, browserUiLanguage, normalizeLocale } from "../web/js/languages.js";
import { readFile } from "node:fs/promises";

test("interface locale supports eight languages and a Chinese fallback", () => {
  setLocale("en");
  assert.equal(getLocale(), "en");
  assert.equal(t("save"), "Save");
  assert.equal(t("modelFound", { model: "demo", count: 3 }), "✓ Found demo in the model list (3 models)");

  setLocale("fr");
  assert.equal(getLocale(), "fr");
  assert.equal(t("save"), "Enregistrer");
  setLocale("unsupported");
  assert.equal(getLocale(), "zh-CN");
  assert.equal(t("save"), "保存");
});

test("all eight interface catalogs cover every message and retain interpolation fields", () => {
  const keys = Object.keys(messages.en).sort();
  const fields = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  assert.equal(INTERFACE_LANGUAGES.length, 8);
  for (const [locale] of INTERFACE_LANGUAGES) {
    assert.deepEqual(Object.keys(messages[locale]).sort(), keys, locale);
    for (const key of keys) {
      assert.equal(typeof messages[locale][key], "string", `${locale}.${key}`);
      assert.ok(messages[locale][key].trim(), `${locale}.${key}`);
      assert.deepEqual(fields(messages[locale][key]), fields(messages.en[key]), `${locale}.${key}`);
    }
  }
});

test("regional browser preferences resolve to supported locales in preference order", () => {
  for (const [input, expected] of [["zh-Hant", "zh-TW"], ["zh-HK", "zh-TW"], ["zh_Hant_MO", "zh-TW"], ["zh-SG", "zh-CN"], ["fr-CA", "fr"], ["es-MX", "es"], ["ko-KR", "ko"], ["ja-JP", "ja"], ["de-DE", "de"], ["en-GB", "en"]]) {
    assert.equal(normalizeLocale(input), expected);
  }
  assert.equal(browserUiLanguage({ languages: ["fi-FI", "de-DE", "en-US"], language: "en-US" }), "de");
  assert.equal(browserUiLanguage({ language: "unavailable" }), "zh-CN");
});

test("settings and floating translator expose the same 24 target languages with native labels", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.equal(TRANSLATION_LANGUAGES.length, 24);
  assert.equal(new Set(TRANSLATION_LANGUAGES.map(([code]) => code)).size, 24);
  for (const [id, languages] of [["setting-lang", TRANSLATION_LANGUAGES], ["bubble-target-lang", TRANSLATION_LANGUAGES], ["setting-ui-language", INTERFACE_LANGUAGES]]) {
    const options = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`))[1];
    const actual = [...options.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(match => [match[1], match[2]]);
    assert.deepEqual(actual, languages.map(([code, label]) => [code, label]));
  }
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

test("reasoning setting strings exist in both locales", () => {
  setLocale("zh-CN");
  assert.equal(t("reasoningEffortDefault"), "跟随模型默认");
  assert.equal(t("showThinking"), "显示问答思考过程");
  assert.equal(t("thinkingProcess"), "思考过程");
  setLocale("en");
  assert.equal(t("reasoningEffortDefault"), "Follow the model default");
  assert.equal(t("showThinking"), "Show Ask reasoning");
  assert.equal(t("thinkingProcess"), "Thinking");
  setLocale("zh-CN");
});

test("extension startup error strings exist in both locales", () => {
  setLocale("en");
  assert.match(t("extensionOriginNotGranted", { origin: "https://example.com" }), /example\.com/);
  setLocale("zh-CN");
  assert.match(t("extensionOriginNotGranted", { origin: "https://example.com" }), /example\.com/);
});
