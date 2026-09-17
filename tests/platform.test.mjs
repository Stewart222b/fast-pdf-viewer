import assert from "node:assert/strict";
import test from "node:test";
import { createPlatform } from "../web/js/platform/index.js";

test("createPlatform switches to desktop after pywebviewready", () => {
  const listeners = {};
  globalThis.window = {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
  globalThis.document = { body: { dataset: {} } };
  delete globalThis.pywebview;

  const platform = createPlatform();
  assert.equal(platform.id, "web");

  globalThis.pywebview = { api: { pick: async () => null } };
  listeners.pywebviewready();
  assert.equal(platform.id, "desktop");
  assert.equal(globalThis.document.body.dataset.platform, "desktop");
});

test("platform wrapper tolerates platforms without extension-only methods", () => {
  const listeners = {};
  globalThis.window = {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
  globalThis.document = { body: { dataset: {} } };
  delete globalThis.pywebview;
  delete globalThis.chrome;

  const platform = createPlatform();
  assert.equal(platform.id, "web");
  // The web/desktop platforms never define setTabTitle/canFallbackToBrowser;
  // the wrapper must not throw and must report undefined so main.js guards
  // (typeof checks / optional chaining) keep working.
  assert.equal(platform.setTabTitle("t"), undefined);
  assert.equal(platform.canFallbackToBrowser(), undefined);
});

test("createPlatform forwards clearBrowserFallback for the extension adapter", async () => {
  const listeners = {};
  globalThis.window = {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
  globalThis.document = { body: { dataset: {} } };
  delete globalThis.pywebview;
  globalThis.chrome = {
    runtime: { id: "extension-id", sendMessage: async () => undefined },
    permissions: { contains: async () => true },
  };
  globalThis.location = {
    protocol: "chrome-extension:",
    search: `?file=${encodeURIComponent("https://example.com/a.pdf")}`,
    href: `chrome-extension://extension-id/web/index.html?file=${encodeURIComponent("https://example.com/a.pdf")}`,
  };

  const platform = createPlatform();
  assert.equal(platform.id, "extension");
  await platform.startupOpen();
  assert.equal(platform.canFallbackToBrowser(), true);
  platform.clearBrowserFallback();
  assert.equal(platform.canFallbackToBrowser(), false);
});
