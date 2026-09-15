"use strict";

const AUTO_OPEN_KEY = "autoOpenPdf";
const DEFAULT_SETTINGS = { [AUTO_OPEN_KEY]: false };
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
        setStatus("当前浏览器不支持原生 PDF 接管，正在请求主机访问权限…");

        // Keep this request in the checkbox change handler: the browser requires a user gesture.
        const granted = await chrome.permissions.request(HOST_ACCESS);
        if (!granted) {
          autoOpenInput.checked = false;
          await saveAutoOpenSetting(false);
          setStatus("未获得主机访问权限，设置保持关闭。", "warning");
          return;
        }
      }

      await saveAutoOpenSetting(true);
      setStatus("已开启自动打开 PDF。", "success");
    } else {
      await saveAutoOpenSetting(false);
      await setMimeHandlerEnabled(false);
      setStatus("已关闭自动打开 PDF。", "success");
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
    setStatus("无法保存设置，请稍后重试。", "error");
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
    setStatus("无法读取设置，请重新打开此页面。", "error");
    console.error("Failed to load extension settings", error);
  }
}

initialize();
