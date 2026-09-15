const EXTENSION_PROTOCOL = "chrome-extension:";

let defaultState = null;

function wrapFetch(options = {}) {
  const custom = options.fetch ?? options.fetchImpl;
  if (custom && custom !== globalThis.fetch) return custom;
  return (...args) => globalThis.fetch(...args);
}

function dependencies(options = {}) {
  return {
    chrome: options.chrome ?? options.chromeApi ?? globalThis.chrome,
    fetch: wrapFetch(options),
    location: options.location ?? globalThis.location,
  };
}

function isExtensionContext(chrome, location) {
  return Boolean(
    chrome?.runtime?.id && location?.protocol === EXTENSION_PROTOCOL,
  );
}

function parseRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PDF 地址无效：请输入完整的 HTTP(S) 地址。");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error("PDF 地址无效：仅支持不含账号信息的 HTTP(S) 地址。");
  }
  return url;
}

function fileName(url) {
  const lastPart = url.pathname.split("/").filter(Boolean).at(-1);
  if (!lastPart) return "document.pdf";
  try {
    return decodeURIComponent(lastPart);
  } catch {
    return lastPart;
  }
}

function originPattern(url) {
  return `${url.protocol}//${url.hostname}/*`;
}

function requestAccess(url, chrome, location) {
  if (!isExtensionContext(chrome, location)) return true;
  const parsed = parseRemoteUrl(url);
  if (typeof chrome.permissions?.request !== "function") {
    throw new Error("无法请求网站访问权限：扩展权限 API 不可用。");
  }

  // Keep this call in the same user-gesture stack. Do not make this function
  // async or await anything before permissions.request().
  return chrome.permissions.request({ origins: [originPattern(parsed)] });
}

function queryFile(location) {
  const search = location?.search ?? "";
  if (!search || search === "?") return null;
  const params = new URLSearchParams(search);
  if (!params.has("file")) return null;
  if (!params.get("file")) {
    throw new Error("缺少要打开的 PDF 地址（file 参数）。");
  }
  return parseRemoteUrl(params.get("file"));
}

function createState(options) {
  return {
    ...dependencies(options),
    activeMime: false,
    originalUrl: null,
    mimeTabId: null,
    startupPromise: null,
  };
}

async function setBrowserTabTitle(state, title) {
  const trimmed = String(title || "").trim();
  if (!trimmed || typeof state.chrome?.runtime?.sendMessage !== "function") return;
  try {
    await state.chrome.runtime.sendMessage({
      type: "set-tab-title",
      title: trimmed,
      tabId: state.mimeTabId,
    });
  } catch {
    // The MIME shell tab still shows the original URL if Edge rejects the update.
  }
}

async function openLegacyUrl(state) {
  const url = queryFile(state.location);
  if (!url) return null;

  state.originalUrl = url.href;
  if (typeof state.chrome?.permissions?.contains !== "function") {
    throw new Error("无法检查网站访问权限，不能打开此 PDF。");
  }
  const allowed = await state.chrome.permissions.contains({
    origins: [originPattern(url)],
  });
  if (!allowed) {
    throw new Error(`尚未获得访问 ${url.origin} 的权限，请先授权后再打开。`);
  }

  return {
    url: url.href,
    name: fileName(url),
    path: url.href,
    originalUrl: url.href,
    withCredentials: true,
  };
}

async function startup(state) {
  if (!isExtensionContext(state.chrome, state.location)) return null;

  if (typeof state.chrome.mimeHandler?.getStreamInfo === "function") {
    let info;
    try {
      info = await state.chrome.mimeHandler.getStreamInfo();
    } catch {
      return openLegacyUrl(state);
    }

    state.activeMime = true;
    state.originalUrl = info.originalUrl;
    state.mimeTabId = info.tabId ?? null;
    const response = await state.fetch(info.streamUrl);
    if (response.ok === false) {
      throw new Error(`读取 PDF MIME 流失败（HTTP ${response.status}）。`);
    }
    const buffer = await response.arrayBuffer();
    const originalUrl = info.originalUrl;
    let name = "document.pdf";
    try {
      name = fileName(new URL(originalUrl));
    } catch {
      // Chrome owns originalUrl; retain a useful display name if it is unusual.
    }
    await setBrowserTabTitle(state, name);
    return {
      data: new Uint8Array(buffer),
      name,
      path: originalUrl,
      originalUrl,
      mimeStream: true,
    };
  }

  return openLegacyUrl(state);
}

async function fallback(state) {
  if (
    state.activeMime &&
    typeof state.chrome?.mimeHandler?.abortAndFallbackToNativeHandler ===
      "function"
  ) {
    return state.chrome.mimeHandler.abortAndFallbackToNativeHandler();
  }
  if (!state.originalUrl) {
    throw new Error("没有可交给浏览器打开的原始 PDF 地址。");
  }
  if (typeof state.chrome?.runtime?.sendMessage !== "function") {
    throw new Error("无法通知扩展后台打开原始 PDF。");
  }
  const response = await state.chrome.runtime.sendMessage({
    type: "open-original",
    url: state.originalUrl,
  });
  if (response?.ok === false) {
    const detail = response.error ? `：${response.error}` : "";
    throw new Error(`浏览器未能打开原始 PDF${detail}，请重试。`);
  }
  return response;
}

export function createExtensionPlatform(options = {}) {
  const state = createState(options);
  defaultState = state;
  return {
    id: "extension",
    label: "扩展版",
    startupOpen() {
      state.startupPromise ||= startup(state);
      return state.startupPromise;
    },
    async pickFile() {
      return null;
    },
    requestHostAccess(url) {
      return requestAccess(url, state.chrome, state.location);
    },
    fallbackToBrowser() {
      return fallback(state);
    },
    setTabTitle(title) {
      return setBrowserTabTitle(state, title);
    },
  };
}

export function requestHostAccess(url) {
  const { chrome, location } = dependencies();
  return requestAccess(url, chrome, location);
}

export function fallbackToBrowser() {
  if (!defaultState) defaultState = createState();
  return fallback(defaultState);
}
