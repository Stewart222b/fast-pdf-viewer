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
