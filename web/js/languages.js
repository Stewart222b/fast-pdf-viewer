// Keep native names recognizable regardless of the current interface language.
export const TRANSLATION_LANGUAGES = [
  ["zh-CN", "简体中文", "简体中文"], ["zh-TW", "繁體中文", "繁體中文"],
  ["en", "English", "English"], ["ja", "日本語", "日本語"],
  ["ko", "한국어", "Korean"], ["de", "Deutsch", "German"],
  ["fr", "Français", "French"], ["es", "Español", "Spanish"],
  ["pt-BR", "Português (Brasil)", "Brazilian Portuguese"],
  ["pt-PT", "Português (Portugal)", "European Portuguese"],
  ["it", "Italiano", "Italian"], ["ru", "Русский", "Russian"],
  ["uk", "Українська", "Ukrainian"], ["pl", "Polski", "Polish"],
  ["nl", "Nederlands", "Dutch"], ["sv", "Svenska", "Swedish"],
  ["tr", "Türkçe", "Turkish"], ["ar", "العربية", "Arabic"],
  ["hi", "हिन्दी", "Hindi"], ["id", "Bahasa Indonesia", "Indonesian"],
  ["vi", "Tiếng Việt", "Vietnamese"], ["th", "ไทย", "Thai"],
  ["ms", "Bahasa Melayu", "Malay"], ["he", "עברית", "Hebrew"],
];
export const INTERFACE_LANGUAGES = TRANSLATION_LANGUAGES.slice(0, 8);

export function matchInterfaceLocale(locale) {
  const tag = String(locale || "").replaceAll("_", "-").toLowerCase();
  if (/^zh(?:-|$)/.test(tag)) return /(?:^|-)hant(?:-|$)|(?:^|-)(tw|hk|mo)(?:-|$)/.test(tag) ? "zh-TW" : "zh-CN";
  const language = tag.split("-")[0];
  return INTERFACE_LANGUAGES.find(([code]) => code === language)?.[0] || null;
}

export function normalizeLocale(locale) {
  return matchInterfaceLocale(locale) || "zh-CN";
}

export function browserUiLanguage(navigator = globalThis.navigator) {
  for (const language of [...(navigator?.languages || []), navigator?.language]) {
    const matched = matchInterfaceLocale(language);
    if (matched) return matched;
  }
  return "zh-CN";
}

export function languageName(code) {
  return TRANSLATION_LANGUAGES.find(([value]) => value === code)?.[2] || String(code || "简体中文");
}
