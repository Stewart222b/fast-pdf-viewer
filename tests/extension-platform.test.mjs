import assert from "node:assert/strict";
import test from "node:test";
import { setLocale } from "../web/js/i18n.js";
import { createExtensionPlatform, formatExtensionError } from "../web/js/platform/extension.js";

function extensionLocation(search = "") {
  return { protocol: "chrome-extension:", search };
}

function chromeApi(overrides = {}) {
  return {
    runtime: { id: "extension-id", sendMessage: async () => undefined },
    permissions: {
      contains: async () => true,
      request: () => Promise.resolve(true),
    },
    tabs: { update: async () => undefined },
    ...overrides,
  };
}

test("ordinary extension page without a stream or query opens nothing", async () => {
  let startupFetches = 0;
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      mimeHandler: {
        getStreamInfo: async () => {
          throw new Error("No stream is associated with this page");
        },
      },
    }),
    location: extensionLocation(),
    fetch: async () => {
      startupFetches += 1;
      throw new Error("must not fetch");
    },
  });

  assert.equal(platform.id, "extension");
  assert.equal(platform.label, "扩展版");
  assert.equal(await platform.pickFile(), null);
  assert.equal(await platform.startupOpen(), null);
  assert.equal(startupFetches, 0);
});

test("MIME stream fetch works with an unbound global fetch reference", async () => {
  let fetchCalls = 0;
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      mimeHandler: {
        getStreamInfo: async () => ({
          streamUrl: "blob:chrome-extension://extension-id/once",
          originalUrl: "https://arxiv.org/pdf/1706.03762",
        }),
      },
    }),
    location: extensionLocation(),
    fetch: globalThis.fetch,
    fetchImpl: globalThis.fetch,
  });

  const prior = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    assert.equal(url, "blob:chrome-extension://extension-id/once");
    return {
      ok: true,
      async arrayBuffer() {
        return Uint8Array.from([37, 80, 68, 70]).buffer;
      },
    };
  };
  try {
    const opened = await platform.startupOpen();
    assert.equal(fetchCalls, 1);
    assert.equal(opened.name, "1706.03762");
    assert.deepEqual(opened.data, Uint8Array.from([37, 80, 68, 70]));
  } finally {
    globalThis.fetch = prior;
  }
});

test("MIME stream is fetched and consumed exactly once", async () => {
  let streamInfoCalls = 0;
  let fetchCalls = 0;
  let arrayBufferCalls = 0;
  let tabTitle;
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      mimeHandler: {
        getStreamInfo: async () => {
          streamInfoCalls += 1;
          return {
            streamUrl: "blob:chrome-extension://extension-id/once",
            originalUrl: "https://example.com/reports/annual.pdf",
            tabId: 42,
          };
        },
      },
      runtime: {
        id: "extension-id",
        sendMessage: async message => {
          assert.equal(message.type, "set-tab-title");
          assert.equal(message.tabId, 42);
          tabTitle = message.title;
        },
      },
    }),
    location: extensionLocation(),
    fetch: async (url) => {
      fetchCalls += 1;
      assert.equal(url, "blob:chrome-extension://extension-id/once");
      return {
        async arrayBuffer() {
          arrayBufferCalls += 1;
          return Uint8Array.from([37, 80, 68, 70]).buffer;
        },
      };
    },
  });

  const first = await platform.startupOpen();
  const second = await platform.startupOpen();
  assert.deepEqual(first, {
    data: Uint8Array.from([37, 80, 68, 70]),
    name: "annual.pdf",
    path: "https://example.com/reports/annual.pdf",
    originalUrl: "https://example.com/reports/annual.pdf",
    mimeStream: true,
  });
  assert.strictEqual(second, first);
  assert.equal(streamInfoCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(arrayBufferCalls, 1);
  assert.equal(tabTitle, "annual.pdf");
});

test("legacy startup rejects unsafe and credentialed URLs", async () => {
  for (const file of [
    "file:///tmp/private.pdf",
    "https://user:secret@example.com/private.pdf",
    "javascript:alert(1)",
  ]) {
    const platform = createExtensionPlatform({
      chrome: chromeApi(),
      location: extensionLocation(`?file=${encodeURIComponent(file)}`),
    });
    await assert.rejects(platform.startupOpen(), (error) => {
      assert.equal(error.code, "extensionInvalidPdfUrlCredentials");
      return true;
    });
  }
});

test("legacy startup ignores unrelated query parameters", async () => {
  const platform = createExtensionPlatform({
    chrome: chromeApi(),
    location: extensionLocation("?source=toolbar"),
  });

  assert.equal(await platform.startupOpen(), null);
});

test("legacy startup requires origin permission", async () => {
  let checked;
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      permissions: {
        contains: async (permission) => {
          checked = permission;
          return false;
        },
      },
    }),
    location: extensionLocation(
      `?file=${encodeURIComponent("https://pdf.example/a.pdf")}`,
    ),
  });

  await assert.rejects(platform.startupOpen(), (error) => {
    assert.equal(error.code, "extensionOriginNotGranted");
    return true;
  });
  assert.deepEqual(checked, { origins: ["https://pdf.example/*"] });
});

test("failed MIME fetch propagates and never replays the original URL", async () => {
  const fetched = [];
  const failure = new Error("stream expired");
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      mimeHandler: {
        getStreamInfo: async () => ({
          streamUrl: "blob:chrome-extension://extension-id/once",
          originalUrl: "https://example.com/single-use.pdf",
        }),
      },
    }),
    location: extensionLocation(),
    fetch: async (url) => {
      fetched.push(url);
      throw failure;
    },
  });

  await assert.rejects(platform.startupOpen(), (error) => error === failure);
  await assert.rejects(platform.startupOpen(), (error) => error === failure);
  assert.deepEqual(fetched, ["blob:chrome-extension://extension-id/once"]);
});

test("clearBrowserFallback drops MIME and legacy original URL state", async () => {
  const platform = createExtensionPlatform({
    chrome: chromeApi(),
    location: extensionLocation(`?file=${encodeURIComponent("https://example.com/a.pdf")}`),
  });
  await platform.startupOpen();
  assert.equal(platform.canFallbackToBrowser(), true);

  platform.clearBrowserFallback();
  assert.equal(platform.canFallbackToBrowser(), false);
});

test("legacy startup returns credentialed PDF.js URL metadata", async () => {
  const url = "https://example.com/files/a%20book.pdf?download=1";
  const platform = createExtensionPlatform({
    chrome: chromeApi(),
    location: extensionLocation(`?file=${encodeURIComponent(url)}`),
  });

  assert.deepEqual(await platform.startupOpen(), {
    url,
    name: "a book.pdf",
    path: url,
    originalUrl: url,
    withCredentials: true,
  });
});

test("requestHostAccess calls permissions.request synchronously", async () => {
  let called = false;
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      permissions: {
        contains: async () => false,
        request(permission) {
          called = true;
          assert.deepEqual(permission, {
            origins: ["https://example.com/*"],
          });
          return Promise.resolve(true);
        },
      },
    }),
    location: extensionLocation(),
  });

  const result = platform.requestHostAccess("https://example.com/doc.pdf");
  assert.equal(called, true);
  assert.equal(await result, true);
});

test("host permission match patterns omit ports and preserve IPv6 brackets", async () => {
  const requested = [];
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      permissions: {
        request(permission) {
          requested.push(permission);
          return Promise.resolve(true);
        },
      },
    }),
    location: extensionLocation(),
  });

  await platform.requestHostAccess("http://localhost:8080/api");
  await platform.requestHostAccess("https://[::1]:9443/api");
  assert.deepEqual(requested, [
    { origins: ["http://localhost/*"] },
    { origins: ["https://[::1]/*"] },
  ]);
});

test("requestHostAccess is a no-op outside an extension context", () => {
  const platform = createExtensionPlatform({
    chrome: undefined,
    location: { protocol: "https:", search: "" },
  });

  assert.equal(platform.requestHostAccess(), true);
  assert.equal(platform.requestHostAccess("not a URL"), true);
});

test("fallback uses Chrome's native handler for an active MIME stream", async () => {
  let aborted = 0;
  let messages = 0;
  const failure = new Error("stream failed");
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      runtime: {
        id: "extension-id",
        sendMessage: async () => {
          messages += 1;
        },
      },
      mimeHandler: {
        getStreamInfo: async () => ({
          streamUrl: "blob:chrome-extension://extension-id/once",
          originalUrl: "https://example.com/failure.pdf",
        }),
        abortAndFallbackToNativeHandler: async () => {
          aborted += 1;
        },
      },
    }),
    location: extensionLocation(),
    fetch: async () => {
      throw failure;
    },
  });

  await assert.rejects(platform.startupOpen(), (error) => error === failure);
  await platform.fallbackToBrowser();
  assert.equal(aborted, 1);
  assert.equal(messages, 0);
});

test("legacy permission failure retains URL for background fallback", async () => {
  const messages = [];
  const url = "https://pdf.example/denied.pdf";
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      runtime: {
        id: "extension-id",
        sendMessage: async (message) => {
          messages.push(message);
        },
      },
      permissions: { contains: async () => false },
    }),
    location: extensionLocation(`?file=${encodeURIComponent(url)}`),
  });

  await assert.rejects(platform.startupOpen(), (error) => {
    assert.equal(error.code, "extensionOriginNotGranted");
    return true;
  });
  await platform.fallbackToBrowser();
  assert.deepEqual(messages, [{ type: "open-original", url }]);
});

test("legacy fallback rejects a failed background response", async () => {
  const url = "https://pdf.example/failure.pdf";
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      runtime: {
        id: "extension-id",
        sendMessage: async () => ({ ok: false, error: "unauthorized" }),
      },
    }),
    location: extensionLocation(`?file=${encodeURIComponent(url)}`),
  });

  await platform.startupOpen();
  await assert.rejects(platform.fallbackToBrowser(), (error) => {
    assert.equal(error.code, "extensionOpenOriginalFailedReason");
    assert.equal(error.params.reason, "unauthorized");
    return true;
  });
});

test("extension errors localize with the active interface language", () => {
  const error = { code: "extensionOriginNotGranted", params: { origin: "https://pdf.example" } };
  setLocale("en");
  assert.match(formatExtensionError(error, (key, values) => {
    if (key === "extensionOriginNotGranted") {
      return `Access to ${values.origin} has not been granted.`;
    }
    return key;
  }), /Access to https:\/\/pdf\.example/);
  setLocale("zh-CN");
});

test("canFallbackToBrowser is false on a fresh platform", () => {
  const platform = createExtensionPlatform({
    chrome: chromeApi(),
    location: extensionLocation(),
  });

  assert.equal(platform.canFallbackToBrowser(), false);
});

test("canFallbackToBrowser is true after legacy startup even when permission is denied", async () => {
  const url = "https://pdf.example/denied.pdf";
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      permissions: { contains: async () => false },
    }),
    location: extensionLocation(`?file=${encodeURIComponent(url)}`),
  });

  assert.equal(platform.canFallbackToBrowser(), false);
  await assert.rejects(platform.startupOpen(), (error) => {
    assert.equal(error.code, "extensionOriginNotGranted");
    return true;
  });
  assert.equal(platform.canFallbackToBrowser(), true);
});

test("canFallbackToBrowser is true after MIME startup", async () => {
  let streamInfoCalls = 0;
  const platform = createExtensionPlatform({
    chrome: chromeApi({
      mimeHandler: {
        getStreamInfo: async () => {
          streamInfoCalls += 1;
          return {
            streamUrl: "blob:chrome-extension://extension-id/once",
            originalUrl: "https://example.com/reports/annual.pdf",
            tabId: 7,
          };
        },
      },
    }),
    location: extensionLocation(),
    fetch: async () => ({
      ok: true,
      async arrayBuffer() {
        return Uint8Array.from([37, 80, 68, 70]).buffer;
      },
    }),
  });

  assert.equal(platform.canFallbackToBrowser(), false);
  await platform.startupOpen();
  assert.equal(streamInfoCalls, 1);
  assert.equal(platform.canFallbackToBrowser(), true);
});
