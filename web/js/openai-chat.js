import { t } from "./i18n.js";

export const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openai/gpt-4o-mini";

export function isAllowedApiBaseUrl(value) {
  try {
    const url = new URL(String(value || DEFAULT_API_BASE).trim());
    if (url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    return url.protocol === "https:" || (url.protocol === "http:" && local);
  } catch {
    return false;
  }
}

export function normalizeApiBase(url) {
  const trimmed = String(url || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  const normalized = trimmed || DEFAULT_API_BASE;
  if (!isAllowedApiBaseUrl(normalized)) throw new Error(t("modelEndpointMustUseHttps"));
  return normalized;
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

/** Fetch header values must be ISO-8859-1 (ByteString); Unicode throws in Edge and other browsers. */
export function latin1HeaderValue(value, fallback = "") {
  const text = String(value ?? "");
  return /^[\x00-\xff]*$/.test(text) ? text : fallback;
}

export function openAiRequestHeaders(settings) {
  const apiKey = latin1HeaderValue(settings?.apiKey);
  if (!apiKey) throw new Error(t("apiKeyRequired"));
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const base = normalizeApiBase(settings?.apiBaseUrl);
  if (base.includes("openrouter.ai")) {
    const origin = latin1HeaderValue(globalThis.location?.origin);
    if (origin) headers["HTTP-Referer"] = origin;
    headers["X-Title"] = latin1HeaderValue("Fast PDF Viewer – AI Translation", "Fast PDF Viewer - AI Translation");
  }
  return headers;
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

function extractJsonCompletion(data, onDelta, emptyMessage) {
  if (data?.error) {
    throw new Error(data.error.message || data.error.type || t("translationFailed", { status: "response" }));
  }
  const reason = data?.choices?.[0]?.finish_reason;
  if (reason !== undefined && reason !== null && reason !== "stop") {
    throw new Error(t("modelIncompleteTranslation", { reason }));
  }
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(emptyMessage);
  onDelta?.(content);
  return content;
}

async function readStreamingCompletion(response, { onDelta, signal, emptyMessage } = {}) {
  if (!response.body) {
    const data = await response.json().catch(() => ({}));
    return extractJsonCompletion(data, onDelta, emptyMessage);
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
    if (!trimmed) throw new Error(emptyMessage);
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
 * @param {{ apiKey?: string, apiBaseUrl?: string, model?: string }} settings
 * @param {{ messages: Array<{role: string, content: string}>, signal?: AbortSignal, timeoutMs?: number, onDelta?: (text: string) => void, temperature?: number, emptyMessage?: string, cancelledMessage?: string, timeoutMessage?: string }} options
 */
export async function completeChat(
  settings,
  {
    messages,
    signal,
    timeoutMs = 60_000,
    onDelta,
    temperature = 0.1,
    emptyMessage = t("modelNoTranslation"),
    cancelledMessage = t("translationCancelled"),
    timeoutMessage = t("translationTimeout"),
  } = {},
) {
  if (!settings?.apiKey) throw new Error(t("apiKeyRequired"));
  if (!Array.isArray(messages) || !messages.length) throw new Error(t("noText"));

  const url = chatCompletionsUrl(settings.apiBaseUrl);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = openAiRequestHeaders(settings);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.model || DEFAULT_MODEL,
        temperature,
        stream: true,
        messages,
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
      return await readStreamingCompletion(response, {
        onDelta,
        signal: controller.signal,
        emptyMessage,
      });
    }
    const data = await response.json().catch(() => ({}));
    return extractJsonCompletion(data, onDelta, emptyMessage);
  } catch (error) {
    if (error?.name === "AbortError") {
      if (signal?.aborted) throw new Error(cancelledMessage);
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
