"use strict";

const AUTO_OPEN_KEY = "autoOpenPdf";
const READER_SETTINGS_KEY = "fast-pdf-viewer-settings";
const DEFAULT_SETTINGS = { [AUTO_OPEN_KEY]: false, [READER_SETTINGS_KEY]: { uiLanguage: "zh-CN" } };
const MESSAGES = {
  "zh-CN": {
    pageTitle: "Fast PDF Viewer – AI Translation 设置", brandHome: "Fast PDF Viewer – AI Translation 设置首页",
    extensionSettings: "扩展设置", intro: "让 PDF 链接更快进入 Fast PDF Viewer – AI Translation，也可以随时回到阅读器。",
    pdfHandling: "PDF 处理", handlingDescription: "选择浏览器遇到 PDF 时的默认行为。", autoOpen: "自动打开 PDF",
    autoOpenDescription: "检测到 PDF 链接时，自动交给 Fast PDF Viewer – AI Translation 阅读。", permissions: "权限说明",
    permissionDescription: "扩展在安装时已获得 http:// 和 https:// 站点的访问权限，用于打开在线 PDF、向承载 PDF 的标签页写入标题和检测 PDF 请求；扩展不读取网页正文。支持原生 PDF 接管的浏览器使用浏览器自带能力；较旧浏览器启用自动打开时，会在确认后额外申请可选的 webRequest 权限。",
    quickActions: "快捷操作", openReader: "打开阅读器", extensionDetails: "查看扩展详情",
    footerNote: "PDF 文件仍保留在本机；你可以在浏览器的扩展管理页调整更多权限。", privacy: "阅读隐私说明",
    requestingPermission: "当前浏览器不支持原生 PDF 接管，正在请求可选的 webRequest 权限…",
    permissionDenied: "未获得 webRequest 权限，设置保持关闭。", enabled: "已开启自动打开 PDF。", disabled: "已关闭自动打开 PDF。",
    saveFailed: "无法保存设置，请稍后重试。", loadFailed: "无法读取设置，请重新打开此页面。",
  },
  en: {
    pageTitle: "Fast PDF Viewer – AI Translation Settings", brandHome: "Fast PDF Viewer – AI Translation settings home",
    extensionSettings: "Extension settings", intro: "Open PDF links quickly in Fast PDF Viewer – AI Translation and return to the reader at any time.",
    pdfHandling: "PDF handling", handlingDescription: "Choose what the browser does when it encounters a PDF.", autoOpen: "Open PDFs automatically",
    autoOpenDescription: "Open detected PDF links automatically in Fast PDF Viewer – AI Translation.", permissions: "Permissions",
    permissionDescription: "The extension has access to http:// and https:// sites so it can open online PDFs, update the title of tabs that host PDFs, and detect PDF requests. It does not read webpage content. Browsers with native PDF handling use the built-in capability. Older browsers ask for the optional webRequest permission when this setting is enabled.",
    quickActions: "Quick actions", openReader: "Open reader", extensionDetails: "View extension details",
    footerNote: "PDF files remain on your device. You can adjust additional permissions from the browser's extension management page.", privacy: "Read the privacy notice",
    requestingPermission: "This browser does not support native PDF handling. Requesting the optional webRequest permission…",
    permissionDenied: "The webRequest permission was not granted. The setting remains off.", enabled: "Automatic PDF opening is enabled.", disabled: "Automatic PDF opening is disabled.",
    saveFailed: "Could not save the setting. Try again later.", loadFailed: "Could not read settings. Reopen this page.",
  },
};
let uiLanguage = "zh-CN";

function tr(key) {
  return MESSAGES[uiLanguage]?.[key] || MESSAGES["zh-CN"][key] || key;
}

function applyTranslations() {
  if (document.documentElement) document.documentElement.lang = uiLanguage;
  for (const element of document.querySelectorAll?.("[data-i18n]") || []) element.textContent = tr(element.dataset.i18n);
  for (const element of document.querySelectorAll?.("[data-i18n-aria]") || []) element.setAttribute("aria-label", tr(element.dataset.i18nAria));
  if (typeof globalThis.Event === "function") globalThis.dispatchEvent?.(new Event("fast-pdf-viewer-language-change"));
}
const HOST_ACCESS = {
  permissions: ["webRequest"],
  origins: ["http://*/*", "https://*/*"],
};

const autoOpenInput = document.getElementById("auto-open-pdf");
const openReaderButton = document.getElementById("open-reader");
const extensionDetailsLink = document.getElementById("extension-details");
const settingsStatus = document.getElementById("settings-status");

function setStatus(message, kind = "") {
  settingsStatus.textContent = message;
  settingsStatus.dataset.kind = kind;
}

async function setMimeHandlerEnabled(enabled) {
  const mimeHandler = chrome.mimeHandler;
  if (!mimeHandler || typeof mimeHandler.setMimeHandlerOptions !== "function") {
    return;
  }

  await mimeHandler.setMimeHandlerOptions("application/pdf", { enabled });
}

function hasNativeMimeHandler() {
  return typeof chrome.mimeHandler?.setMimeHandlerOptions === "function";
}

async function saveAutoOpenSetting(enabled) {
  await chrome.storage.local.set({ [AUTO_OPEN_KEY]: enabled });
}

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  uiLanguage = settings[READER_SETTINGS_KEY]?.uiLanguage === "en" ? "en" : "zh-CN";
  applyTranslations();
  autoOpenInput.checked = settings[AUTO_OPEN_KEY] === true;
}

async function handleAutoOpenChange() {
  const enabled = autoOpenInput.checked;
  autoOpenInput.disabled = true;

  try {
    if (enabled) {
      if (hasNativeMimeHandler()) {
        await setMimeHandlerEnabled(true);
      } else {
        setStatus(tr("requestingPermission"));

        // Keep this request in the checkbox change handler: the browser requires a user gesture.
        const granted = await chrome.permissions.request(HOST_ACCESS);
        if (!granted) {
          autoOpenInput.checked = false;
          await saveAutoOpenSetting(false);
          setStatus(tr("permissionDenied"), "warning");
          return;
        }
      }

      await saveAutoOpenSetting(true);
      setStatus(tr("enabled"), "success");
    } else {
      await saveAutoOpenSetting(false);
      await setMimeHandlerEnabled(false);
      setStatus(tr("disabled"), "success");
    }
  } catch (error) {
    if (enabled) {
      autoOpenInput.checked = false;
      await Promise.allSettled([
        saveAutoOpenSetting(false),
        setMimeHandlerEnabled(false),
      ]);
      console.error("Failed to enable automatic PDF handling", error);
    } else {
      console.error("Failed to disable automatic PDF handling", error);
    }
    setStatus(tr("saveFailed"), "error");
  } finally {
    autoOpenInput.disabled = false;
  }
}

function openReader() {
  chrome.tabs.create({ url: chrome.runtime.getURL("web/index.html") });
}

function configureExtensionDetailsLink() {
  extensionDetailsLink.href = `chrome://extensions/?id=${chrome.runtime.id}`;
}

async function initialize() {
  configureExtensionDetailsLink();
  openReaderButton.addEventListener("click", openReader);
  autoOpenInput.addEventListener("change", handleAutoOpenChange);

  try {
    await loadSettings();
  } catch (error) {
    autoOpenInput.disabled = true;
    setStatus(tr("loadFailed"), "error");
    console.error("Failed to load extension settings", error);
  }
}

initialize();
