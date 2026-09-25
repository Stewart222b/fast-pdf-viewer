import { t } from "./i18n.js";

const LANG_NAME = {
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  en: "English",
  ja: "日本語",
};

export const MAX_TRANSLATE_CHARS = 4000;
export const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openai/gpt-4o-mini";

const API_PROVIDER_HOSTS = new Map([
  ["api.openai.com", "OpenAI"],
  ["api.anthropic.com", "Anthropic"],
  ["openrouter.ai", "OpenRouter"],
  ["api.deepseek.com", "DeepSeek"],
  ["generativelanguage.googleapis.com", "Gemini"],
  ["api.x.ai", "xAI"],
  ["us.api.x.ai", "xAI"],
  ["mtls.api.x.ai", "xAI"],
  ["api.mistral.ai", "Mistral"],
  ["api.eu.mistral.ai", "Mistral"],
  ["api.us.mistral.ai", "Mistral"],
  ["api.groq.com", "Groq"],
  ["api.together.ai", "Together AI"],
  ["api.together.xyz", "Together AI"],
  ["api.fireworks.ai", "Fireworks AI"],
  ["api.siliconflow.cn", "SiliconFlow"],
  ["api.siliconflow.com", "SiliconFlow"],
  ["open.bigmodel.cn", "智谱 AI"],
  ["api.z.ai", "Z.ai"],
  ["dashscope.aliyuncs.com", "阿里云百炼"],
  ["dashscope-intl.aliyuncs.com", "阿里云百炼"],
  ["dashscope-us.aliyuncs.com", "阿里云百炼"],
  ["cn-hongkong.dashscope.aliyuncs.com", "阿里云百炼"],
  ["api.hunyuan.cloud.tencent.com", "腾讯混元"],
  ["tokenhub.tencentmaas.com", "腾讯混元 TokenHub"],
  ["api.moonshot.cn", "Moonshot AI / Kimi"],
  ["api.moonshot.ai", "Moonshot AI / Kimi"],
  ["qianfan.baidubce.com", "百度千帆"],
  ["api.minimax.io", "MiniMax"],
  ["api.perplexity.ai", "Perplexity"],
  ["ark.cn-beijing.volces.com", "火山引擎方舟"],
  ["integrate.api.nvidia.com", "NVIDIA NIM"],
  ["api.cerebras.ai", "Cerebras"],
]);

const API_PROVIDER_HOST_SUFFIXES = [
  ["maas.aliyuncs.com", "阿里云百炼"],
];

/**
 * Translate-bubble footer: reflect the configured API endpoint, not the model id prefix.
 * @param {{ apiBaseUrl?: string, model?: string } | null | undefined} settings
 */
export function formatBubbleModelLabel(settings) {
  const model = String(settings?.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  let host = "";
  try {
    const url = new URL(normalizeApiBase(settings?.apiBaseUrl));
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname.toLowerCase();
  } catch {
    // A custom or malformed URL has no reliable provider label.
  }
  const provider = API_PROVIDER_HOSTS.get(host) || API_PROVIDER_HOST_SUFFIXES.find(
    ([suffix]) => host.endsWith(`.${suffix}`),
  )?.[1] || (/^ark\.[a-z0-9-]+\.volces\.com$/.test(host) ? "火山引擎方舟" : "");
  return provider ? `${provider} · ${model}` : model;
}

export function normalizeApiBase(url) {
  const trimmed = String(url || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_API_BASE;
}

export function chatCompletionsUrl(apiBase) {
  const base = normalizeApiBase(apiBase);
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

export function modelsUrl(apiBase) {
  const base = normalizeApiBase(apiBase);
  if (base.endsWith("/models")) return base;
  if (base.endsWith("/chat/completions")) return base.replace(/\/chat\/completions$/, "/models");
  return `${base}/models`;
}

export function modelSearchTokens(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

export function modelMatchesQuery(model, query) {
  const tokens = modelSearchTokens(query);
  if (!tokens.length) return true;
  const haystack = `${model.id} ${model.name || ""}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export async function fetchModelList(settings, { signal } = {}) {
  const apiKey = latin1HeaderValue(settings?.apiKey);
  const apiBase = settings?.apiBaseUrl?.trim();
  if (!apiKey || !apiBase) return [];
  const headers = { Authorization: `Bearer ${apiKey}` };
  const base = normalizeApiBase(apiBase);
  if (base.includes("openrouter.ai")) {
    const origin = latin1HeaderValue(globalThis.location?.origin);
    if (origin) headers["HTTP-Referer"] = origin;
    headers["X-Title"] = latin1HeaderValue("Fast PDF Viewer – AI Translation", "Fast PDF Viewer - AI Translation");
  }
  const response = await fetch(modelsUrl(apiBase), { headers, signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || t("modelListRequestFailed", { status: response.status });
    throw new Error(message);
  }
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const models = rows
    .map((row) => ({
      id: String(row?.id || row?.name || "").trim(),
      name: String(row?.name || row?.id || "").trim(),
    }))
    .filter((row) => row.id);
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** Fetch header values must be ISO-8859-1 (ByteString); Unicode throws in Edge and other browsers. */
export function latin1HeaderValue(value, fallback = "") {
  const text = String(value ?? "");
  return /^[\x00-\xff]*$/.test(text) ? text : fallback;
}

/** @param {'term' | 'passage'} mode */
export function buildTranslationMessages(text, targetLang, mode = "passage") {
  const language = LANG_NAME[targetLang] || targetLang;
  if (mode === "term") {
    return [
      {
        role: "system",
        content: [
          `You are a concise bilingual dictionary for ${language}.`,
          "The user selected a short word or term from a PDF.",
          "Reply in " + language + " only, compact dictionary-card style (no markdown fences):",
          "1) Headword line (original term if helpful)",
          "2) 词性 / part of speech",
          "3) 1–3 brief definitions",
          "4) 1–2 short example sentences",
          "Keep the whole answer short enough for a small popup.",
        ].join(" "),
      },
      { role: "user", content: text },
    ];
  }
  return [
    {
      role: "system",
      content: [
        `Translate the user's passage into ${language}.`,
        "The text is from a PDF: soft line wraps are already removed; blank lines mark real paragraphs.",
        "Translate as coherent paragraphs matching those boundaries.",
        "Do not split into one sentence per line or preserve PDF wrap breaks.",
        "Return only the translation.",
      ].join(" "),
    },
    { role: "user", content: text },
  ];
}

export function extractStreamDelta(parsed) {
  const choice = parsed?.choices?.[0];
  if (!choice) return "";
  if (typeof choice.delta?.content === "string") return choice.delta.content;
  if (typeof choice.message?.content === "string") return choice.message.content;
  return "";
}

/**
 * @param {string} chunk - May contain multiple SSE lines.
 * @returns {string[]} content deltas
 */
export function parseSseTranslationChunk(chunk) {
  const deltas = [];
  const state = createSseState((piece) => deltas.push(piece));
  for (const line of String(chunk).split(/\r?\n/)) {
    processSseLine(line, state);
  }
  finishSseFrame(state);
  return deltas;
}

function createSseState(onDelta) {
  return { dataLines: [], completed: false, translated: "", onDelta };
}

function processSseLine(line, state) {
  if (line.trim() === "") {
    finishSseFrame(state);
    return;
  }
  if (line.startsWith(":") || !line.startsWith("data:")) return;
  let payload = line.slice(5);
  if (payload.startsWith(" ")) payload = payload.slice(1);
  state.dataLines.push(payload);
}

function finishSseFrame(state) {
  if (!state.dataLines.length) return;
  const payload = state.dataLines.join("\n").trim();
  state.dataLines = [];
  if (!payload) return;
  if (payload === "[DONE]") {
    state.completed = true;
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // A malformed frame is not a successful completion, but later frames may recover.
    return;
  }
  if (parsed?.error) {
    throw new Error(parsed.error.message || parsed.error.type || t("translationFailed", { status: "stream" }));
  }
  const reason = parsed?.choices?.[0]?.finish_reason;
  if (reason) {
    if (reason !== "stop") throw new Error(t("modelIncompleteTranslation", { reason }));
    state.completed = true;
  }
  const piece = extractStreamDelta(parsed);
  if (piece) {
    state.translated += piece;
    state.onDelta?.(piece, state.translated);
  }
}

function extractJsonTranslation(data, onDelta) {
  if (data?.error) {
    throw new Error(data.error.message || data.error.type || t("translationFailed", { status: "response" }));
  }
  const reason = data?.choices?.[0]?.finish_reason;
  if (reason !== undefined && reason !== null && reason !== "stop") {
    throw new Error(t("modelIncompleteTranslation", { reason }));
  }
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(t("modelNoTranslation"));
  onDelta?.(content);
  return content;
}

async function readStreamingTranslation(response, { onDelta, signal } = {}) {
  if (!response.body) {
    const data = await response.json().catch(() => ({}));
    return extractJsonTranslation(data, onDelta);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const state = createSseState((piece, complete) => onDelta?.(complete));
  try {
    while (!state.completed) {
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        processSseLine(line, state);
        if (state.completed) break;
      }
    }
    if (!state.completed) {
      buffer += decoder.decode();
      if (buffer) processSseLine(buffer, state);
      finishSseFrame(state);
    }
    if (state.completed) await reader.cancel().catch(() => {});
    const trimmed = state.translated.trim();
    if (!state.completed) throw new Error(t("modelIncompleteTranslation", { reason: "EOF" }));
    if (!trimmed) throw new Error(t("modelNoTranslation"));
    return trimmed;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * OpenAI-compatible chat completions (OpenRouter, OpenAI, local proxies, etc.).
 */
export async function translateWithProvider(
  text,
  settings,
  { signal, timeoutMs = 60_000, onDelta, mode = "passage" } = {},
) {
  if (!settings?.apiKey) {
    throw new Error(t("apiKeyRequired"));
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error(t("noText"));
  if (trimmed.length > MAX_TRANSLATE_CHARS) {
    throw new Error(t("textTooLong", { count: trimmed.length, max: MAX_TRANSLATE_CHARS }));
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
    if (!apiKey) throw new Error(t("apiKeyRequired"));
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    const base = normalizeApiBase(settings.apiBaseUrl);
    if (base.includes("openrouter.ai")) {
      const origin = latin1HeaderValue(globalThis.location?.origin);
      if (origin) headers["HTTP-Referer"] = origin;
      headers["X-Title"] = latin1HeaderValue("Fast PDF Viewer – AI Translation", "Fast PDF Viewer - AI Translation");
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.model || DEFAULT_MODEL,
        temperature: 0.1,
        stream: true,
        messages: buildTranslationMessages(trimmed, settings.targetLang, mode),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error?.message || t("translationFailed", { status: response.status });
      throw new Error(message);
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("text/event-stream")) {
      return await readStreamingTranslation(response, { onDelta, signal: controller.signal });
    }
    const data = await response.json().catch(() => ({}));
    return extractJsonTranslation(data, onDelta);
  } catch (error) {
    if (error?.name === "AbortError") {
      if (signal?.aborted) throw new Error(t("translationCancelled"));
      throw new Error(t("translationTimeout"));
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
