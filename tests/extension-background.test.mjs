import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function listenerChrome({
  native = false,
  hangContains = true,
  containsResult = true,
  autoOpen = false,
  hangSettings = false,
} = {}) {
  const headerListeners = [];
  const messageListeners = [];
  const installedListeners = [];
  const changedListeners = [];
  const updatedListeners = [];
  const actionListeners = [];
  const scriptCalls = [];
  const menuCreates = [];
  const updateCalls = [];
  const createCalls = [];
  const sessionStore = new Map();
  const tabsById = new Map();
  let containsCalls = 0;
  let resolveContains;
  const containsPromise = new Promise(resolve => {
    resolveContains = resolve;
  });
  let resolveSettings;
  const settingsPromise = new Promise(resolve => {
    resolveSettings = resolve;
  });

  const chrome = {
    runtime: {
      getURL: path => `chrome-extension://id/${path}`,
      onInstalled: {
        addListener(listener) {
          installedListeners.push(listener);
        },
      },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        },
      },
      openOptionsPage: async () => {},
    },
    storage: {
      local: {
        get: async () => {
          if (hangSettings) {
            await settingsPromise;
            return {};
          }
          return { autoOpenPdf: autoOpen };
        },
        set: async () => {},
      },
      session: {
        async get(key) {
          return { [key]: sessionStore.get(key) };
        },
        async set(value) {
          for (const [key, stored] of Object.entries(value)) sessionStore.set(key, stored);
        },
        async remove(key) {
          sessionStore.delete(key);
        },
      },
      onChanged: {
        addListener(listener) {
          changedListeners.push(listener);
        },
      },
    },
    contextMenus: {
      removeAll(callback) {
        callback?.();
      },
      create(details) {
        menuCreates.push(details);
      },
      onClicked: { addListener() {} },
    },
    action: {
      onClicked: {
        addListener(listener) {
          actionListeners.push(listener);
        },
      },
    },
    permissions: {
      contains() {
        containsCalls += 1;
        return hangContains ? containsPromise : Promise.resolve(containsResult);
      },
      request: async () => true,
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    tabs: {
      get: async id => tabsById.get(id) ?? {},
      update(id, changes) {
        updateCalls.push({ id, changes });
        return Promise.resolve({});
      },
      create(changes) {
        createCalls.push(changes);
        return Promise.resolve({});
      },
      onRemoved: { addListener() {} },
      onUpdated: {
        addListener(listener) {
          updatedListeners.push(listener);
        },
      },
    },
    scripting: {
      executeScript: async details => {
        scriptCalls.push(details);
        return [];
      },
    },
    webRequest: {
      onHeadersReceived: {
        addListener(listener, filter, extraInfoSpec) {
          headerListeners.push({ listener, filter, extraInfoSpec });
        },
        removeListener(listener) {
          const index = headerListeners.findIndex(entry => entry.listener === listener);
          if (index >= 0) headerListeners.splice(index, 1);
        },
      },
    },
  };

  if (native) {
    chrome.mimeHandler = {
      getStreamInfo: async () => ({}),
      getMimeHandlerOptions: async () => ({}),
      setMimeHandlerOptions: async () => {},
    };
  }

  return {
    chrome,
    headerListeners,
    messageListeners,
    installedListeners,
    changedListeners,
    updatedListeners,
    actionListeners,
    scriptCalls,
    menuCreates,
    updateCalls,
    createCalls,
    sessionStore,
    tabsById,
    containsCalls: () => containsCalls,
    resolveContains,
    resolveSettings,
  };
}

async function loadBackground(chrome, { fetch } = {}) {
  const context = vm.createContext({
    chrome,
    console,
    URL,
    Map,
    Number,
    Boolean,
    String,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch,
  });
  const background = new vm.SourceTextModule(
    await readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
    { context, identifier: "background.js" },
  );
  await background.link(async specifier => {
    if (specifier !== "./routing.js") {
      throw new Error(`unexpected import ${specifier}`);
    }
    const routing = new vm.SourceTextModule(
      await readFile(new URL("../extension/routing.js", import.meta.url), "utf8"),
      { context, identifier: "routing.js" },
    );
    await routing.link(() => {
      throw new Error("routing.js should not import other modules");
    });
    return routing;
  });
  await background.evaluate();
}

test("legacy PDF routing registers onHeadersReceived during module evaluation", async () => {
  const harness = listenerChrome({ hangContains: true, hangSettings: true });
  await loadBackground(harness.chrome);
  assert.equal(
    harness.headerListeners.length,
    1,
    "MV3 must attach webRequest before awaiting permissions.contains()",
  );
  const registered = JSON.parse(JSON.stringify(harness.headerListeners[0]));
  assert.deepEqual(registered.filter, {
    urls: ["http://*/*", "https://*/*"],
    types: ["main_frame"],
  });
  assert.deepEqual(registered.extraInfoSpec, ["responseHeaders"]);
  assert.equal(typeof harness.headerListeners[0].listener, "function");
});

test("native MIME browsers skip the legacy webRequest listener", async () => {
  const harness = listenerChrome({ native: true, hangContains: true });
  await loadBackground(harness.chrome);
  assert.equal(harness.headerListeners.length, 0);
});

test("MIME tab titles are written onto the outer page with scripting", async () => {
  const harness = listenerChrome({ native: true });
  await loadBackground(harness.chrome);
  const [onMessage] = harness.messageListeners;
  const reply = await new Promise(resolve => {
    const keep = onMessage(
      { type: "set-tab-title", title: "1706.03762", tabId: 42 },
      {},
      resolve,
    );
    assert.equal(keep, true);
  });
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), { ok: true });
  const call = JSON.parse(JSON.stringify(harness.scriptCalls[0]));
  assert.equal(call.target.tabId, 42);
  assert.deepEqual(call.args, ["1706.03762"]);
});

test("tab title is re-enforced while the tab stays on the same document", async () => {
  const harness = listenerChrome({ native: true });
  await loadBackground(harness.chrome);
  const [onMessage] = harness.messageListeners;
  await new Promise(resolve => {
    onMessage({ type: "set-tab-title", title: "1706.03762", tabId: 42 }, {}, resolve);
  });
  assert.equal(harness.scriptCalls.length, 1);

  harness.updatedListeners[0](42, { title: "https://example.com/paper.pdf" });
  await flush();
  assert.equal(harness.scriptCalls.length, 2);
  assert.deepEqual(plain(harness.scriptCalls[1].args), ["1706.03762"]);
});

test("tab title enforcement stops once the tab navigates away", async () => {
  const harness = listenerChrome({ native: true });
  await loadBackground(harness.chrome);
  const [onMessage] = harness.messageListeners;
  await new Promise(resolve => {
    onMessage({ type: "set-tab-title", title: "1706.03762", tabId: 42 }, {}, resolve);
  });
  assert.equal(harness.scriptCalls.length, 1);

  harness.updatedListeners[0](42, { pendingUrl: "https://example.com/next" });
  harness.updatedListeners[0](42, { url: "https://example.com/next" });
  harness.updatedListeners[0](42, { title: "Example" });
  await flush();
  assert.equal(harness.scriptCalls.length, 1);
});

test("manual original-PDF bypass survives redirecting servers", async () => {
  const harness = listenerChrome({ autoOpen: true });
  await loadBackground(harness.chrome);
  const [onMessage] = harness.messageListeners;
  const originalUrl = "https://cdn.example.com/shortlink";
  const finalUrl = "https://cdn.example.com/files/paper.pdf";
  const sender = {
    tab: { id: 7 },
    url: `chrome-extension://id/web/index.html?file=${encodeURIComponent(originalUrl)}`,
  };
  const reply = await new Promise(resolve => {
    const keep = onMessage({ type: "open-original", url: originalUrl }, sender, resolve);
    assert.equal(keep, true);
  });
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), { ok: true });
  // The fallback navigates the tab to the original URL.
  assert.deepEqual(plain(harness.updateCalls), [{ id: 7, changes: { url: originalUrl } }]);

  harness.tabsById.set(7, { url: finalUrl });
  harness.headerListeners[0].listener({
    tabId: 7,
    url: finalUrl,
    type: "main_frame",
    method: "GET",
    responseHeaders: [{ name: "content-type", value: "application/pdf" }],
  });
  await flush();
  // The stored tab-scoped bypass is consumed even though the final response
  // URL differs and onHeadersReceived provided no redirect-chain metadata.
  assert.equal(harness.updateCalls.length, 1);
  assert.equal(harness.sessionStore.has("pdfOriginalBypass:7"), false);
});

test("PDF navigation without a bypass still routes into the viewer", async () => {
  const harness = listenerChrome({ autoOpen: true });
  await loadBackground(harness.chrome);
  const pdfUrl = "https://example.com/paper.pdf";
  harness.tabsById.set(3, { url: pdfUrl });
  harness.headerListeners[0].listener({
    tabId: 3,
    url: pdfUrl,
    redirectChain: [pdfUrl],
    type: "main_frame",
    method: "GET",
    responseHeaders: [{ name: "content-type", value: "application/pdf" }],
  });
  await flush();
  const expected = `chrome-extension://id/web/index.html?file=${encodeURIComponent(pdfUrl)}`;
  assert.deepEqual(plain(harness.updateCalls), [{ id: 3, changes: { url: expected } }]);
});

test("legacy PDF navigation without redirectChain still routes when no bypass is stored", async () => {
  const harness = listenerChrome({ autoOpen: true });
  await loadBackground(harness.chrome);
  const pdfUrl = "https://example.com/paper.pdf";
  harness.tabsById.set(4, { url: pdfUrl });
  harness.headerListeners[0].listener({
    tabId: 4,
    url: pdfUrl,
    type: "main_frame",
    method: "GET",
    responseHeaders: [{ name: "content-type", value: "application/pdf" }],
  });
  await flush();
  const expected = `chrome-extension://id/web/index.html?file=${encodeURIComponent(pdfUrl)}`;
  assert.deepEqual(plain(harness.updateCalls), [{ id: 4, changes: { url: expected } }]);
});

test("the link context menu only targets PDF links", async () => {
  const harness = listenerChrome();
  await loadBackground(harness.chrome);
  const [onInstalled] = harness.installedListeners;
  await onInstalled({ reason: "update" });
  assert.equal(harness.menuCreates.length, 1);
  const patterns = plain(harness.menuCreates[0].targetUrlPatterns);
  assert.equal(patterns.length, 16);
  assert.ok(patterns.includes("*://*/*.pdf"));
  assert.ok(patterns.includes("*://*/*.PDF"));
  assert.ok(patterns.includes("*://*/*.pdf?*"));
  assert.ok(patterns.includes("*://*/*.PDF?*"));
  assert.equal(harness.menuCreates[0].title, "Open PDF with Fast PDF Viewer – AI Translation");
});

test("action click requests site access before probing suffixless URLs", async () => {
  const harness = listenerChrome();
  const order = [];
  await loadBackground(harness.chrome, {
    fetch: async (url, options) => {
      order.push("fetch");
      return { ok: true, headers: { get: () => "application/pdf" } };
    },
  });
  harness.chrome.permissions.request = async () => {
    order.push("permission");
    return true;
  };
  harness.actionListeners[0]({ id: 9, url: "https://example.com/paper?id=1" });
  await flush();
  assert.deepEqual(order, ["permission", "fetch"]);
});

test("action click does not hijack a tab that navigated during the MIME probe", async () => {
  const harness = listenerChrome();
  const originalUrl = "https://example.com/paper?id=1";
  harness.tabsById.set(9, { url: originalUrl });
  await loadBackground(harness.chrome, {
    fetch: async () => {
      harness.tabsById.set(9, { url: "https://example.com/other" });
      return { ok: true, headers: { get: () => "application/pdf" } };
    },
  });
  harness.actionListeners[0]({ id: 9, url: originalUrl });
  await flush();
  assert.deepEqual(plain(harness.updateCalls), []);
  assert.deepEqual(plain(harness.createCalls), []);
});

test("action click opens the current PDF even without a .pdf suffix", async () => {
  const harness = listenerChrome();
  const fetchCalls = [];
  await loadBackground(harness.chrome, {
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, headers: { get: () => "application/pdf" } };
    },
  });
  harness.tabsById.set(9, { url: "https://example.com/paper?id=1" });
  harness.actionListeners[0]({ id: 9, url: "https://example.com/paper?id=1" });
  await flush();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://example.com/paper?id=1");
  assert.equal(fetchCalls[0].options.method, "HEAD");
  const expected = `chrome-extension://id/web/index.html?file=${encodeURIComponent("https://example.com/paper?id=1")}`;
  assert.deepEqual(plain(harness.updateCalls), [{ id: 9, changes: { url: expected } }]);
});

test("action click falls back to a range GET when HEAD is rejected", async () => {
  const harness = listenerChrome();
  const fetchCalls = [];
  await loadBackground(harness.chrome, {
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, method: options.method });
      if (options.method === "HEAD") return { ok: false, headers: { get: () => "" } };
      return { ok: true, headers: { get: () => "application/pdf; charset=binary" } };
    },
  });
  harness.tabsById.set(5, { url: "https://example.com/dl?doc=2" });
  harness.actionListeners[0]({ id: 5, url: "https://example.com/dl?doc=2" });
  await flush();
  assert.deepEqual(plain(fetchCalls.map(call => call.method)), ["HEAD", "GET"]);
  const expected = `chrome-extension://id/web/index.html?file=${encodeURIComponent("https://example.com/dl?doc=2")}`;
  assert.deepEqual(plain(harness.updateCalls), [{ id: 5, changes: { url: expected } }]);
});

test("action click opens the empty reader when the current page is not a PDF", async () => {
  const harness = listenerChrome();
  await loadBackground(harness.chrome, {
    fetch: async () => ({ ok: true, headers: { get: () => "text/html" } }),
  });
  harness.actionListeners[0]({ id: 11, url: "https://example.com/article" });
  await flush();
  assert.deepEqual(plain(harness.updateCalls), []);
  assert.deepEqual(plain(harness.createCalls), [{ url: "chrome-extension://id/web/index.html" }]);
});

test("action click opens .pdf URLs directly without probing", async () => {
  const harness = listenerChrome();
  let probed = false;
  await loadBackground(harness.chrome, {
    fetch: async () => {
      probed = true;
      return { ok: true, headers: { get: () => "text/html" } };
    },
  });
  harness.tabsById.set(2, { url: "https://example.com/paper.pdf" });
  harness.actionListeners[0]({ id: 2, url: "https://example.com/paper.pdf" });
  await flush();
  assert.equal(probed, false);
  const expected = `chrome-extension://id/web/index.html?file=${encodeURIComponent("https://example.com/paper.pdf")}`;
  assert.deepEqual(plain(harness.updateCalls), [{ id: 2, changes: { url: expected } }]);
});

test("toggling auto-open off unregisters the legacy listener", async () => {
  const harness = listenerChrome({
    hangContains: false,
    containsResult: true,
    autoOpen: true,
  });
  await loadBackground(harness.chrome);
  await flush();
  assert.equal(harness.headerListeners.length, 1);

  const [onChanged] = harness.changedListeners;
  onChanged({ autoOpenPdf: { newValue: false } }, "local");
  await flush();
  assert.equal(harness.headerListeners.length, 0);

  onChanged({ autoOpenPdf: { newValue: true } }, "local");
  await flush();
  assert.equal(harness.headerListeners.length, 1);
});
