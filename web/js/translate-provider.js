import { t } from "./i18n.js";
import { languageName } from "./languages.js";
import {
  DEFAULT_API_BASE,
  DEFAULT_MODEL,
  chatCompletionsUrl,
  completeChat,
  extractStreamDelta,
  isAllowedApiBaseUrl,
  latin1HeaderValue,
  modelsUrl,
  normalizeApiBase,
  openAiRequestHeaders,
  parseSseTranslationChunk,
} from "./openai-chat.js";

export {
  DEFAULT_API_BASE,
  DEFAULT_MODEL,
  chatCompletionsUrl,
  extractStreamDelta,
  isAllowedApiBaseUrl,
  latin1HeaderValue,
  modelsUrl,
  normalizeApiBase,
  parseSseTranslationChunk,
};

export const MAX_TRANSLATE_CHARS = 4000;

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
  const headers = openAiRequestHeaders(settings);
  delete headers["Content-Type"];
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

/** @param {'term' | 'passage'} mode */
export function buildTranslationMessages(text, targetLang, mode = "passage") {
  const language = languageName(targetLang);
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

/**
 * OpenAI-compatible chat completions (OpenRouter, OpenAI, local proxies, etc.).
 */
export async function translateWithProvider(
  text,
  settings,
  { signal, timeoutMs = 60_000, onDelta, mode = "passage" } = {},
) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error(t("noText"));
  if (trimmed.length > MAX_TRANSLATE_CHARS) {
    throw new Error(t("textTooLong", { count: trimmed.length, max: MAX_TRANSLATE_CHARS }));
  }

  return completeChat(settings, {
    disableReasoning: true,
    messages: buildTranslationMessages(trimmed, settings.targetLang, mode),
    signal,
    timeoutMs,
    // Drop reasoning metadata even if a proxy ignores the disable parameter.
    onDelta: (partial) => onDelta?.(partial),
    temperature: 0.1,
  });
}
