import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

function listenerChrome({ native = false, hangContains = true } = {}) {
  const headerListeners = [];
  const messageListeners = [];
  const scriptCalls = [];
  let containsCalls = 0;
  let resolveContains;
  const containsPromise = new Promise(resolve => {
    resolveContains = resolve;
  });

  const chrome = {
    runtime: {
      getURL: path => `chrome-extension://id/${path}`,
      onInstalled: { addListener() {} },
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
        get: async () => ({}),
        set: async () => {},
      },
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
      onChanged: { addListener() {} },
    },
    contextMenus: {
      removeAll(callback) {
        callback?.();
      },
      create() {},
      onClicked: { addListener() {} },
    },
    action: { onClicked: { addListener() {} } },
    permissions: {
      contains() {
        containsCalls += 1;
        return hangContains ? containsPromise : Promise.resolve(true);
      },
      request: async () => true,
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    tabs: {
      get: async () => ({}),
      update: async () => {},
      create: async () => {},
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
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
        removeListener() {},
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
    scriptCalls,
    containsCalls: () => containsCalls,
    resolveContains,
  };
}

async function loadBackground(chrome) {
  const context = vm.createContext({
    chrome,
    console,
    URL,
    Map,
    Number,
    Boolean,
    String,
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
  const harness = listenerChrome({ hangContains: true });
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
