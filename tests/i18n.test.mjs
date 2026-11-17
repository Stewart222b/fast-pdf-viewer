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
    assert.doesNotMatch(messages[locale].ask, /beta|bêta/i, `${locale}: Ask is no longer beta`);
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

test("the API key hint never claims the key stays on the device", async () => {
  // openAiRequestHeaders sends the key to the configured endpoint as
  // `Authorization: Bearer …`, so "never uploaded" would be a false promise.
  // Every catalog must instead say where the key actually goes. Note that the
  // same sentences legitimately say the *PDF file* is never uploaded, so only
  // the key-specific hint is checked for a false claim.
  const falseClaims = {
    "zh-CN": /不(?:会上传|會上傳)|不上传|不上傳/,
    "zh-TW": /不(?:会上传|會上傳)|不上传|不上傳/,
    en: /never\s+(?:uploaded|sent|transmitted)/i,
    ja: /送信されることはありません|アップロードしません/,
    ko: /업로드되지 않|전송되지 않/,
    de: /nie\s+(?:hochgeladen|gesendet|übertragen)/i,
    fr: /jamais\s+(?:envoyée|téléversée|transmise)/i,
    es: /nunca\s+se\s+(?:envía|sube|transmite)/i,
  };
  const hintDestination = {
    "zh-CN": /发送到你配置的 API 服务/,
    "zh-TW": /僅傳送至你設定的 API 服務/,
    en: /sent solely to the API service you configure/,
    ja: /設定した API サービスにのみ送信/,
    ko: /설정한 API 서비스로만 전송/,
    de: /an den von dir konfigurierten API-Dienst gesendet/,
    fr: /au service API que vous configurez/,
    es: /al servicio de API que configures/,
  };
  const privacyDestination = {
    "zh-CN": /Key 只随请求发送到你配置的 API 服务/,
    "zh-TW": /Key 只隨請求傳送你設定的 API 服務/,
    en: /key is sent only with requests to the API service you configure/,
    ja: /Key は設定した API サービスへの要求時にのみ送信/,
    ko: /Key는 설정한 API 서비스로 보내는 요청에만/,
    de: /Key wird nur mit Anfragen an den von dir konfigurierten API-Dienst/,
    fr: /la clé n’est envoyée qu’avec les requêtes adressées au service API que vous configurez/,
    es: /la clave solo se envía con las solicitudes al servicio de API que configures/,
  };
  for (const [locale] of INTERFACE_LANGUAGES) {
    assert.doesNotMatch(messages[locale].apiKeyHint, falseClaims[locale], `${locale}.apiKeyHint must not claim the key stays local`);
    assert.match(messages[locale].apiKeyHint, hintDestination[locale], `${locale}.apiKeyHint must name the destination`);
    assert.match(messages[locale].localPrivacy, privacyDestination[locale], `${locale}.localPrivacy must state where the key goes`);
  }

  // The static markup mirrors zh-CN so the string is right before i18n runs.
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const defaultHint = /data-i18n="apiKeyHint">([^<]+)</.exec(html)?.[1] ?? "";
  assert.ok(defaultHint, "web/index.html keeps the apiKeyHint default text");
  assert.doesNotMatch(defaultHint, falseClaims["zh-CN"]);
  assert.match(defaultHint, hintDestination["zh-CN"]);
  const defaultNote = /data-i18n="localPrivacy">([^<]+)</.exec(html)?.[1] ?? "";
  assert.match(defaultNote, privacyDestination["zh-CN"], "the static privacy note matches the catalog");
});
