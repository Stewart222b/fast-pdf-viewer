import {
  AUTO_OPEN_STORAGE_KEY,
  OPEN_ORIGINAL_MESSAGE,
  SET_TAB_TITLE_MESSAGE,
  authorizedOpenOriginal,
  buildViewerUrl,
  bypassStorageKey,
  isLegacyPdfNavigation,
  isPdfUrl,
  normalizeHttpUrl,
  permissionOriginFor,
} from "./routing.js";

const MENU_ID = "open-in-fast-pdf-viewer";
const MIME_TYPE = "application/pdf";
const HTTP_REQUEST_FILTER = {
  urls: ["http://*/*", "https://*/*"],
  types: ["main_frame"],
};
const LEGACY_PERMISSIONS = {
  permissions: ["webRequest"],
  origins: ["http://*/*", "https://*/*"],
};

let autoOpenPdf = false;
let legacyListenerRegistered = false;
const memoryBypasses = new Map();
const desiredTabTitles = new Map();

async function applyTabTitle(tabId, title) {
  const trimmed = String(title || "").trim();
  if (!Number.isInteger(tabId) || !trimmed) return;
  desiredTabTitles.set(tabId, trimmed);
  if (typeof chrome.scripting?.executeScript !== "function") return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: nextTitle => {
        document.title = nextTitle;
      },
      args: [trimmed],
    });
  } catch (error) {
    console.warn("Could not set the PDF tab title", error);
  }
}

function viewerUrl(originalUrl) {
  return buildViewerUrl(path => chrome.runtime.getURL(path), originalUrl);
}

async function readAutoOpenSetting() {
  const stored = await chrome.storage.local.get(AUTO_OPEN_STORAGE_KEY);
  autoOpenPdf = stored[AUTO_OPEN_STORAGE_KEY] === true;
  return autoOpenPdf;
}

function hasNativeMimeHandler() {
  return (
    typeof chrome.mimeHandler?.getStreamInfo === "function" &&
    typeof chrome.mimeHandler?.getMimeHandlerOptions === "function" &&
    typeof chrome.mimeHandler?.setMimeHandlerOptions === "function"
  );
}

async function setNativeMimeHandling(enabled) {
  if (!hasNativeMimeHandler()) return;
  try {
    await chrome.mimeHandler.setMimeHandlerOptions(MIME_TYPE, { enabled });
  } catch (error) {
    console.warn("Could not configure the native PDF MIME handler", error);
  }
}

async function syncAutoOpenSetting() {
  const enabled = await readAutoOpenSetting();
  await setNativeMimeHandling(enabled);
}

let settingsReady = syncAutoOpenSetting().catch(error => {
  console.warn("Could not initialize automatic PDF handling", error);
});

async function putBypass(tabId, url) {
  memoryBypasses.set(tabId, url);
  try {
    await chrome.storage.session.set({ [bypassStorageKey(tabId)]: url });
  } catch {
    // The in-memory entry still covers the normal same-service-worker path.
  }
}

async function takeMatchingBypass(tabId, url) {
  const key = bypassStorageKey(tabId);
  let bypass = memoryBypasses.get(tabId);
  if (!bypass) {
    try {
      bypass = (await chrome.storage.session.get(key))[key];
    } catch {
      bypass = null;
    }
  }
  if (bypass !== url) return false;

  memoryBypasses.delete(tabId);
  try {
    await chrome.storage.session.remove(key);
  } catch {
    // A stale session value is harmless after the tab has left this URL.
  }
  return true;
}

async function handleLegacyPdfNavigation(details) {
  await settingsReady;
  if (!autoOpenPdf || hasNativeMimeHandler() || !isLegacyPdfNavigation(details)) return;

  const originalUrl = normalizeHttpUrl(details.url);
  if (!originalUrl || (await takeMatchingBypass(details.tabId, originalUrl))) return;

  const target = viewerUrl(originalUrl);
  if (!target) return;

  try {
    const tab = await chrome.tabs.get(details.tabId);
    const stillAtOriginal = [tab.pendingUrl, tab.url]
      .map(normalizeHttpUrl)
      .includes(originalUrl);
    if (stillAtOriginal) await chrome.tabs.update(details.tabId, { url: target });
  } catch (error) {
    console.warn("Could not route a PDF navigation", error);
  }
}

function onLegacyHeadersReceived(details) {
  void handleLegacyPdfNavigation(details);
}

function registerLegacyListener() {
  const event = chrome.webRequest?.onHeadersReceived;
  if (!event || hasNativeMimeHandler() || legacyListenerRegistered) return false;
  try {
    event.addListener(onLegacyHeadersReceived, HTTP_REQUEST_FILTER, ["responseHeaders"]);
    legacyListenerRegistered = true;
    return true;
  } catch (error) {
    legacyListenerRegistered = false;
    console.warn("Could not configure legacy PDF routing", error);
    return false;
  }
}

function unregisterLegacyListener() {
  const event = chrome.webRequest?.onHeadersReceived;
  if (!event || !legacyListenerRegistered) {
    legacyListenerRegistered = false;
    return;
  }
  try {
    event.removeListener(onLegacyHeadersReceived);
  } catch (error) {
    console.warn("Could not configure legacy PDF routing", error);
  } finally {
    legacyListenerRegistered = false;
  }
}

async function reconcileLegacyListener() {
  const event = chrome.webRequest?.onHeadersReceived;
  if (!event || hasNativeMimeHandler()) {
    unregisterLegacyListener();
    return;
  }

  let granted = false;
  try {
    granted = await chrome.permissions.contains(LEGACY_PERMISSIONS);
  } catch (error) {
    console.warn("Could not inspect legacy PDF permissions", error);
  }
  if (granted) registerLegacyListener();
  else unregisterLegacyListener();
}

// MV3 delivers the waking navigation only if this listener exists at
// module evaluation. Optional webRequest is present immediately when
// previously granted; the handler still waits for autoOpenPdf.
registerLegacyListener();

chrome.runtime.onInstalled.addListener(async details => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "使用速览打开链接",
      contexts: ["link"],
      targetUrlPatterns: ["http://*/*", "https://*/*"],
    });
  });

  if (details.reason === "install") {
    try {
      await chrome.storage.local.set({ [AUTO_OPEN_STORAGE_KEY]: false });
    } catch (error) {
      console.warn("Could not store the default PDF handling preference", error);
    }
    autoOpenPdf = false;
    await setNativeMimeHandling(false);
    try {
      await chrome.runtime.openOptionsPage();
    } catch (error) {
      console.warn("Could not open the automatic PDF handling options", error);
    }
    return;
  }
  settingsReady = syncAutoOpenSetting().catch(error => {
    console.warn("Could not refresh automatic PDF handling", error);
  });
  await settingsReady;
  await reconcileLegacyListener();
});

chrome.runtime.onStartup.addListener(() => {
  settingsReady = syncAutoOpenSetting().catch(error => {
    console.warn("Could not refresh automatic PDF handling", error);
  });
  void reconcileLegacyListener();
});

chrome.action.onClicked.addListener(tab => {
  void (async () => {
    const originalUrl = normalizeHttpUrl(tab?.url);
    const target = isPdfUrl(originalUrl) ? viewerUrl(originalUrl) : null;
    const origin = target ? permissionOriginFor(originalUrl) : null;

    try {
      if (target && origin && Number.isInteger(tab?.id)) {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (granted) {
          await chrome.tabs.update(tab.id, { url: target });
          return;
        }
      }
      await chrome.tabs.create({ url: chrome.runtime.getURL("web/index.html") });
    } catch (error) {
      console.warn("Could not open 速览", error);
    }
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const originalUrl = normalizeHttpUrl(info.linkUrl);
  const origin = permissionOriginFor(originalUrl);
  const target = viewerUrl(originalUrl);
  if (!origin || !target) return;

  void (async () => {
    try {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) return;
      if (Number.isInteger(tab?.id)) await chrome.tabs.update(tab.id, { url: target });
      else await chrome.tabs.create({ url: target });
    } catch (error) {
      console.warn("Could not open the PDF link", error);
    }
  })();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !Object.hasOwn(changes, AUTO_OPEN_STORAGE_KEY)) return;
  autoOpenPdf = changes[AUTO_OPEN_STORAGE_KEY].newValue === true;
  void setNativeMimeHandling(autoOpenPdf);
});

chrome.permissions.onAdded.addListener(() => {
  void reconcileLegacyListener();
});

chrome.permissions.onRemoved.addListener(() => {
  void reconcileLegacyListener();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === SET_TAB_TITLE_MESSAGE) {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : sender?.tab?.id;
    void applyTabTitle(tabId, message.title).then(
      () => sendResponse({ ok: true }),
      error => sendResponse({ ok: false, error: String(error?.message || error) }),
    );
    return true;
  }

  if (message?.type !== OPEN_ORIGINAL_MESSAGE) return false;
  const request = authorizedOpenOriginal(message, sender, path => chrome.runtime.getURL(path));
  if (!request) {
    sendResponse({ ok: false, error: "unauthorized" });
    return false;
  }

  void (async () => {
    try {
      await putBypass(request.tabId, request.url);
      await chrome.tabs.update(request.tabId, { url: request.url });
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const wanted = desiredTabTitles.get(tabId);
  if (!wanted || !changeInfo.title || changeInfo.title === wanted) return;
  void applyTabTitle(tabId, wanted);
});

chrome.tabs.onRemoved.addListener(tabId => {
  memoryBypasses.delete(tabId);
  desiredTabTitles.delete(tabId);
  void chrome.storage.session.remove(bypassStorageKey(tabId)).catch(() => {});
});

void reconcileLegacyListener();
