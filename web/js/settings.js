const KEY = "fast-pdf-viewer-settings";
let extensionSettings = null;

function extensionStorage() {
  return globalThis.location?.protocol === "chrome-extension:" && globalThis.chrome?.runtime?.id
    ? globalThis.chrome.storage.local : null;
}

function browserUiLanguage() {
  return /^en(?:-|$)/i.test(globalThis.navigator?.language || "") ? "en" : "zh-CN";
}

export async function initSettings() {
  const storage = extensionStorage();
  if (!storage) return;
  const result = await storage.get(KEY);
  extensionSettings = normalizeSettings(result[KEY]);
  globalThis.chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) extensionSettings = normalizeSettings(changes[KEY].newValue);
  });
}

const defaults = {
  apiKey: "",
  apiBaseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-4o-mini",
  targetLang: "zh-CN",
  uiLanguage: "zh-CN",
  uiLanguageSelected: false,
  autoTranslateOnSelect: false,
};

function normalizeSettings(stored = {}) {
  const values = stored && typeof stored === "object" ? stored : {};
  const merged = { ...defaults, ...values };
  if (values.uiLanguageSelected === true) {
    merged.uiLanguageSelected = true;
  } else if (values.uiLanguageSelected === undefined && Object.hasOwn(values, "uiLanguage")) {
    // Keep an explicit choice saved by an older version.
    merged.uiLanguageSelected = true;
  } else {
    merged.uiLanguageSelected = false;
    merged.uiLanguage = browserUiLanguage();
  }
  if (values.autoTranslateOnSelect === undefined) merged.autoTranslateOnSelect = false;
  return merged;
}

export function loadSettings() {
  if (extensionStorage()) return normalizeSettings(extensionSettings);
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch {
    return normalizeSettings();
  }
}

export async function saveSettings(next) {
  const merged = normalizeSettings({ ...loadSettings(), ...next });
  const storage = extensionStorage();
  if (storage) {
    await storage.set({ [KEY]: merged });
    extensionSettings = merged;
  } else localStorage.setItem(KEY, JSON.stringify(merged));
  return merged;
}
