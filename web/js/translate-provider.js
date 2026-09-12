const LANG_NAME = {
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  en: "English",
  ja: "日本語",
};

export const MAX_TRANSLATE_CHARS = 4000;
export const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openai/gpt-4o-mini";

export function normalizeApiBase(url) {
  const trimmed = String(url || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_API_BASE;
}

export function chatCompletionsUrl(apiBase) {
  const base = normalizeApiBase(apiBase);
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

/** Fetch header values must be ISO-8859-1 (ByteString); Unicode throws in Edge and other browsers. */
export function latin1HeaderValue(value, fallback = "") {
  const text = String(value ?? "");
  return /^[\x00-\xff]*$/.test(text) ? text : fallback;
}

export function buildTranslationMessages(text, targetLang) {
  const language = LANG_NAME[targetLang] || targetLang;
  return [
    {
      role: "system",
      content: `You are a precise translator. Translate the user's text into ${language}. Preserve numbers, names, and line breaks. Return only the translation.`,
    },
    { role: "user", content: text },
  ];
}

/**
 * OpenAI-compatible chat completions (OpenRouter, OpenAI, local proxies, etc.).
 */
export async function translateWithProvider(text, settings, { signal, timeoutMs = 60_000 } = {}) {
  if (!settings?.apiKey) {
    throw new Error("还没有填写 API Key，请先打开设置。");
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("没有可翻译的文本。");
  if (trimmed.length > MAX_TRANSLATE_CHARS) {
    throw new Error(`选中文本过长（${trimmed.length} 字），请缩短到 ${MAX_TRANSLATE_CHARS} 字以内。`);
  }

  const url = chatCompletionsUrl(settings.apiBaseUrl);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const apiKey = latin1HeaderValue(settings.apiKey);
    if (!apiKey) throw new Error("还没有填写 API Key，请先打开设置。");
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    const base = normalizeApiBase(settings.apiBaseUrl);
    if (base.includes("openrouter.ai")) {
      const origin = latin1HeaderValue(globalThis.location?.origin);
      if (origin) headers["HTTP-Referer"] = origin;
      headers["X-Title"] = latin1HeaderValue("速览 Fast PDF Viewer", "Fast PDF Viewer");
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.model || DEFAULT_MODEL,
        temperature: 0.1,
        messages: buildTranslationMessages(trimmed, settings.targetLang),
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || `翻译请求失败 (${response.status})`;
      throw new Error(message);
    }
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("模型没有返回译文。");
    return content;
  } catch (error) {
    if (error?.name === "AbortError") {
      if (signal?.aborted) throw new Error("已取消翻译。");
      throw new Error("翻译超时，请稍后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
