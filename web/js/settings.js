const KEY = "fast-pdf-viewer-settings";

const defaults = {
  apiKey: "",
  apiBaseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-4o-mini",
  targetLang: "zh-CN",
  autoTranslateOnSelect: true,
};

export function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || "{}");
    const merged = { ...defaults, ...stored };
    if (stored.autoTranslateOnSelect === undefined) merged.autoTranslateOnSelect = true;
    return merged;
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(next) {
  const merged = { ...loadSettings(), ...next };
  localStorage.setItem(KEY, JSON.stringify(merged));
  return merged;
}
