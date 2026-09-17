import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { mock } from "node:test";

import {
  OPEN_ORIGINAL_MESSAGE,
  authorizedOpenOriginal,
  buildViewerUrl,
  bypassStorageKey,
  isHttpRedirectStatus,
  isLegacyPdfNavigation,
  isPdfUrl,
  isPdfContentType,
  normalizeHttpUrl,
  permissionOriginFor,
} from "../extension/routing.js";

const getURL = path => `chrome-extension://extension-id/${path}`;

test("normalizes only credential-free HTTP(S) URLs", () => {
  assert.equal(normalizeHttpUrl("https://example.com/a file.pdf#p=2"), "https://example.com/a%20file.pdf#p=2");
  assert.equal(normalizeHttpUrl("http://localhost:8080/report"), "http://localhost:8080/report");
  for (const value of ["javascript:alert(1)", "data:application/pdf,x", "file:///tmp/a.pdf", "https://u:p@example.com/a.pdf", "not a url", null]) {
    assert.equal(normalizeHttpUrl(value), null);
  }
});

test("builds encoded viewer URLs and exact optional origin patterns", () => {
  const original = "https://example.com:8443/reports/a b.pdf?download=1&x=two#page=4";
  const mockedGetURL = mock.fn(getURL);
  const viewer = new URL(buildViewerUrl(mockedGetURL, original));
  assert.equal(viewer.href.startsWith(getURL("web/index.html?file=")), true);
  assert.equal(viewer.searchParams.get("file"), "https://example.com:8443/reports/a%20b.pdf?download=1&x=two#page=4");
  assert.deepEqual(mockedGetURL.mock.calls.map(call => call.arguments), [["web/index.html"]]);
  assert.equal(permissionOriginFor(original), "https://example.com/*");
  assert.equal(permissionOriginFor("http://[::1]:8080/a.pdf"), "http://[::1]/*");
  assert.equal(buildViewerUrl(getURL, "blob:https://example.com/id"), null);
});

test("identifies PDF-looking web URLs for toolbar action routing", () => {
  assert.equal(isPdfUrl("https://example.com/reports/Q3.PDF?download=1"), true);
  assert.equal(isPdfUrl("http://localhost:8080/a.pdf#page=2"), true);
  assert.equal(isPdfUrl("https://example.com/download?id=pdf"), false);
  assert.equal(isPdfUrl("file:///tmp/a.pdf"), false);
});

test("recognizes PDF response media types case-insensitively", () => {
  assert.equal(isPdfContentType([{ name: "Content-Type", value: "application/pdf" }]), true);
  assert.equal(isPdfContentType([{ name: "content-type", value: " Application/PDF ; charset=binary" }]), true);
  assert.equal(isPdfContentType([{ name: "Content-Type", value: "application/octet-stream" }]), false);
  assert.equal(isPdfContentType([]), false);
});

test("recognizes HTTP redirect status codes", () => {
  assert.equal(isHttpRedirectStatus(301), true);
  assert.equal(isHttpRedirectStatus(302), true);
  assert.equal(isHttpRedirectStatus(307), true);
  assert.equal(isHttpRedirectStatus(200), false);
  assert.equal(isHttpRedirectStatus(404), false);
  assert.equal(isHttpRedirectStatus(undefined), false);
});

test("legacy routing accepts only main-frame HTTP(S) GET PDF responses", () => {
  const base = {
    type: "main_frame",
    method: "GET",
    tabId: 7,
    url: "https://example.com/download?id=42",
    responseHeaders: [{ name: "Content-Type", value: "application/pdf; charset=binary" }],
  };
  assert.equal(isLegacyPdfNavigation(base), true);
  assert.equal(isLegacyPdfNavigation({ ...base, method: "POST" }), false);
  assert.equal(isLegacyPdfNavigation({ ...base, type: "sub_frame" }), false);
  assert.equal(isLegacyPdfNavigation({ ...base, tabId: -1 }), false);
  assert.equal(isLegacyPdfNavigation({ ...base, url: "file:///tmp/a.pdf" }), false);
  assert.equal(isLegacyPdfNavigation({ ...base, responseHeaders: [] }), false);
});

test("open-original is bound to the same URL in an extension viewer sender", () => {
  const original = "https://example.com/a.pdf?download=1#page=2";
  const sender = { tab: { id: 12 }, url: buildViewerUrl(getURL, original) };
  assert.deepEqual(
    authorizedOpenOriginal({ type: OPEN_ORIGINAL_MESSAGE, url: original }, sender, getURL),
    { tabId: 12, url: original },
  );

  assert.equal(authorizedOpenOriginal({ type: OPEN_ORIGINAL_MESSAGE, url: "https://evil.test/a.pdf" }, sender, getURL), null);
  assert.equal(authorizedOpenOriginal({ type: OPEN_ORIGINAL_MESSAGE, url: original }, { ...sender, tab: {} }, getURL), null);
  assert.equal(authorizedOpenOriginal({ type: OPEN_ORIGINAL_MESSAGE, url: original }, { ...sender, url: "https://example.com/" }, getURL), null);
  assert.equal(authorizedOpenOriginal({ type: "fetch-url", url: original }, sender, getURL), null);
});

test("bypass session keys are tab-scoped", () => {
  assert.equal(bypassStorageKey(3), "pdfOriginalBypass:3");
  assert.notEqual(bypassStorageKey(3), bypassStorageKey(4));
});

test("manifest declares extension contracts and broad http(s) host access", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.name, "__MSG_extensionName__");
  assert.equal(manifest.description, "__MSG_extensionDescription__");
  assert.equal(manifest.minimum_chrome_version, "125");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.options_page, "options.html");
  assert.equal(manifest.permissions.includes("activeTab"), true);
  assert.equal(manifest.permissions.includes("tabs"), true);
  assert.equal(manifest.permissions.includes("scripting"), true);
  assert.equal(manifest.permissions.includes("webRequest"), false);
  assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);
  assert.deepEqual(manifest.optional_permissions, ["webRequest"]);
  assert.equal("optional_host_permissions" in manifest, false);
  assert.equal(manifest.mime_types_handler["application/pdf"].handler_url, "web/index.html");
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  );
});
