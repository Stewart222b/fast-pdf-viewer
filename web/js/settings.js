const KEY = "fast-pdf-viewer-settings";
let extensionSettings = null;

function extensionStorage() {
  return globalThis.location?.protocol === "chrome-extension:" && globalThis.chrome?.runtime?.id
    ? globalThis.chrome.storage.local : null;
}

export async function initSettings() {
  const storage = extensionStorage();
  if (!storage) return;
  const result = await storage.get(KEY);
  extensionSettings = { ...defaults, ...result[KEY] };
  globalThis.chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) extensionSettings = { ...defaults, ...changes[KEY].newValue };
  });
}

const defaults = {
  apiKey: "",
  apiBaseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-4o-mini",
  targetLang: "zh-CN",
  autoTranslateOnSelect: true,
};

export function loadSettings() {
  if (extensionStorage()) return { ...defaults, ...extensionSettings };
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || "{}");
    const merged = { ...defaults, ...stored };
    if (stored.autoTranslateOnSelect === undefined) merged.autoTranslateOnSelect = true;
    return merged;
  } catch {
    return { ...defaults };
  }
}

export async function saveSettings(next) {
  const merged = { ...loadSettings(), ...next };
  const storage = extensionStorage();
  if (storage) {
    await storage.set({ [KEY]: merged });
    extensionSettings = merged;
  } else localStorage.setItem(KEY, JSON.stringify(merged));
  return merged;
}
