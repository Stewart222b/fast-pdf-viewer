import { translateWithProvider } from "./translate-provider.js";

export { MAX_TRANSLATE_CHARS } from "./translate-provider.js";

export async function translateText(text, settings, options = {}) {
  return translateWithProvider(text, settings, options);
}
