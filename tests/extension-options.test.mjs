import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createElement() {
  return {
    checked: false,
    dataset: {},
    disabled: false,
    href: "",
    textContent: "",
    listeners: {},
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  };
}

async function setup({ stored = false, native = false, permissionResult = true, browserLanguage = "zh-CN", readerSettings = {} } = {}) {
  const elements = new Map([
    ["auto-open-pdf", createElement()],
    ["open-reader", createElement()],
    ["extension-details", createElement()],
    ["settings-status", createElement()],
  ]);
  const storageSets = [];
  const mimeCalls = [];
  const permissionCalls = [];
  const tabCalls = [];
  const chrome = {
    runtime: {
      id: "test-extension-id",
      getURL(path) {
        return `chrome-extension://test-extension-id/${path}`;
      },
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, autoOpenPdf: stored, "fast-pdf-viewer-settings": readerSettings };
        },
        async set(value) {
          storageSets.push(value);
          stored = value.autoOpenPdf;
        },
      },
    },
    permissions: {
      async request(value) {
        permissionCalls.push(value);
        return permissionResult;
      },
    },
    tabs: {
      create(value) {
        tabCalls.push(value);
      },
    },
  };

  if (native) {
    chrome.mimeHandler = {
      async setMimeHandlerOptions(...args) {
        mimeCalls.push(args);
      },
    };
  }

  const document = {
    documentElement: {},
    getElementById(id) {
      return elements.get(id);
    },
  };
  vm.runInNewContext(source, {
    chrome,
    console,
    document,
    navigator: { language: browserLanguage },
  });

  await new Promise(resolve => setImmediate(resolve));
  return {
    elements,
    document,
    mimeCalls,
    permissionCalls,
    storageSets,
    tabCalls,
  };
}

test("extension options use the current browser language when reader language is not selected", async () => {
  const firstRun = await setup({ browserLanguage: "en-US" });
  assert.equal(firstRun.document.documentElement.lang, "en");
  assert.equal(firstRun.elements.get("settings-status").textContent, "");

  const notSelected = { uiLanguage: "en", uiLanguageSelected: false };
  const inChineseBrowser = await setup({ browserLanguage: "zh-CN", readerSettings: notSelected });
  assert.equal(inChineseBrowser.document.documentElement.lang, "zh-CN");

  // The same saved settings should follow a changed browser language on the next page load.
  const inEnglishBrowser = await setup({ browserLanguage: "en-US", readerSettings: notSelected });
  assert.equal(inEnglishBrowser.document.documentElement.lang, "en");
});

test("extension options keep an explicitly selected reader language", async () => {
  const selected = await setup({
    browserLanguage: "en-US",
    readerSettings: { uiLanguage: "zh-CN", uiLanguageSelected: true },
  });
  assert.equal(selected.document.documentElement.lang, "zh-CN");
});

test("extension options treat a legacy saved reader language as an explicit preference", async () => {
  const legacy = await setup({
    browserLanguage: "en-US",
    readerSettings: { uiLanguage: "zh-CN" },
  });
  assert.equal(legacy.document.documentElement.lang, "zh-CN");
});

test("native MIME handling uses the exact PDF signature and skips broad permissions", async () => {
  const harness = await setup({ native: true });
  const input = harness.elements.get("auto-open-pdf");

  input.checked = true;
  await input.listeners.change();

  assert.deepEqual(plain(harness.mimeCalls), [["application/pdf", { enabled: true }]]);
  assert.deepEqual(plain(harness.storageSets), [{ autoOpenPdf: true }]);
  assert.deepEqual(plain(harness.permissionCalls), []);
  assert.equal(input.disabled, false);
});

test("native disable syncs MIME handling without requesting host access", async () => {
  const harness = await setup({ stored: true, native: true });
  const input = harness.elements.get("auto-open-pdf");

  input.checked = false;
  await input.listeners.change();

  assert.deepEqual(plain(harness.mimeCalls), [["application/pdf", { enabled: false }]]);
  assert.deepEqual(plain(harness.storageSets), [{ autoOpenPdf: false }]);
  assert.deepEqual(plain(harness.permissionCalls), []);
});

test("legacy fallback requests exact optional access and rolls back on denial", async () => {
  const harness = await setup({ permissionResult: false });
  const input = harness.elements.get("auto-open-pdf");

  input.checked = true;
  await input.listeners.change();

  assert.deepEqual(plain(harness.permissionCalls), [{
    permissions: ["webRequest"],
    origins: ["http://*/*", "https://*/*"],
  }]);
  assert.deepEqual(plain(harness.storageSets), [{ autoOpenPdf: false }]);
  assert.equal(input.checked, false);
  assert.equal(input.disabled, false);
  assert.match(harness.elements.get("settings-status").textContent, /未获得 webRequest 权限/);
});

test("reader and extension details actions use extension URLs", async () => {
  const harness = await setup();
  const openReader = harness.elements.get("open-reader");
  const details = harness.elements.get("extension-details");

  openReader.listeners.click();

  assert.deepEqual(plain(harness.tabCalls), [{
    url: "chrome-extension://test-extension-id/web/index.html",
  }]);
  assert.equal(details.href, "chrome://extensions/?id=test-extension-id");
});
