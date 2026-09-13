import { classifyTranslationMode } from "./selection-text.js";
import { translateWithProvider } from "./translate-provider.js";

export { MAX_TRANSLATE_CHARS } from "./translate-provider.js";

export async function translateText(text, settings, options = {}) {
  const mode = options.mode ?? classifyTranslationMode(text);
  return translateWithProvider(text, settings, { ...options, mode });
}
