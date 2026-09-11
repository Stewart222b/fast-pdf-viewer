const KEY = "fast-pdf-viewer-settings";

const defaults = {
  apiKey: "",
  apiBaseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-4o-mini",
  targetLang: "zh-CN",
};

export function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(next) {
  const merged = { ...loadSettings(), ...next };
  localStorage.setItem(KEY, JSON.stringify(merged));
  return merged;
}
