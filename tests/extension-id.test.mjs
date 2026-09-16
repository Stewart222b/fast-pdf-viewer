import assert from "node:assert/strict";
import test from "node:test";
import { extensionIdFromLoadUnpacked, matchInstalledExtension, pickUnpackedExtensionTarget } from "./browser-extension.mjs";

test("picks the unpacked background worker instead of another chrome-extension target", () => {
  const picked = pickUnpackedExtensionTarget([
    { type: "page", url: "chrome://extensions/" },
    { type: "service_worker", url: "chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/_generated_background_page.html" },
    { type: "service_worker", url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js" },
  ]);
  assert.deepEqual(picked, {
    id: "abcdefghijklmnopabcdefghijklmnop",
    source: "service_worker",
    url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js",
  });
});

test("ignores service workers that are not this extension's background.js", () => {
  assert.equal(pickUnpackedExtensionTarget([
    { type: "service_worker", url: "chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/pdf_viewer.js" },
  ]), null);
});

test("matches the extension product name on chrome://extensions", () => {
  assert.deepEqual(
    matchInstalledExtension([
      { id: "nkeimhogjdpnpccoofpliimaahmaaome", name: "Chrome PDF Viewer" },
      { id: "abcdefghijklmnopabcdefghijklmnop", name: "Fast PDF Viewer – AI Translation" },
    ]),
    { id: "abcdefghijklmnopabcdefghijklmnop", name: "Fast PDF Viewer – AI Translation" },
  );
});

test("accepts the extension id returned by Extensions.loadUnpacked", () => {
  assert.equal(
    extensionIdFromLoadUnpacked({ id: "abcdefghijklmnopabcdefghijklmnop" }),
    "abcdefghijklmnopabcdefghijklmnop",
  );
  assert.equal(extensionIdFromLoadUnpacked({ id: "not-an-id" }), null);
  assert.equal(extensionIdFromLoadUnpacked({}), null);
});
