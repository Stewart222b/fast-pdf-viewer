import { t } from "./i18n.js";

export const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openai/gpt-4o-mini";

export function isAllowedApiBaseUrl(value) {
  try {
    const url = new URL(String(value || DEFAULT_API_BASE).trim());
    if (url.username || url.password) return false;
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function normalizeApiBase(url) {
  const trimmed = String(url || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  const normalized = trimmed || DEFAULT_API_BASE;
  if (!isAllowedApiBaseUrl(normalized)) throw new Error(t("modelEndpointInvalid"));
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

export const REASONING_EFFORTS = ["default", "none", "low", "medium", "high"];

export function normalizeReasoningEffort(value) {
  const key = String(value || "default").trim().toLowerCase();
  return REASONING_EFFORTS.includes(key) ? key : "default";
}

function apiHostname(settings) {
  try {
    return new URL(normalizeApiBase(settings?.apiBaseUrl)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * OpenRouter uses `reasoning.{effort,exclude}`; OpenAI uses `reasoning_effort`.
 * Other OpenAI-compatible hosts get the OpenRouter object and typically ignore unknown fields.
 */
export function chatReasoningFields(settings = {}, { disableReasoning = false } = {}) {
  const effort = disableReasoning ? "none" : normalizeReasoningEffort(settings.reasoningEffort);
  const show = !disableReasoning && settings.showThinking === true;
  const host = apiHostname(settings);
  const model = String(settings.model || DEFAULT_MODEL).toLowerCase().replace(/^openai\//, "");
  if (host !== "openrouter.ai" && (host === "api.deepseek.com" || /^(?:deepseek\/)?deepseek[-/]/.test(model))) {
    if (effort === "none") return { thinking: { type: "disabled" } };
    if (effort === "default") return {};
    return { thinking: { type: "enabled" }, reasoning_effort: effort };
  }
  if (host === "api.openai.com") {
    if (disableReasoning) {
      // Non-reasoning models need no parameter. Always-on reasoning models
      // cannot be switched off; request low effort rather than sending invalid `none`.
      if (/^gpt-5\.[1-9]\d*(?:-|$)/.test(model) && !/(?:pro|codex)/.test(model)) return { reasoning_effort: "none" };
      if (/^(?:o[134](?:-|$)|gpt-[56](?:[.-]|$))/.test(model)) return { reasoning_effort: "low" };
      return {};
    }
    return effort === "default" ? {} : { reasoning_effort: effort };
  }
  if (disableReasoning) return { reasoning: { enabled: false, exclude: true } };
  const reasoning = {};
  if (effort !== "default") reasoning.effort = effort;
  if (!show) reasoning.exclude = true;
  return Object.keys(reasoning).length ? { reasoning } : {};
}

function stringifyModelText(value, { includeThinking = false } = {}) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => stringifyModelText(part, { includeThinking })).join("");
  }
  if (value && typeof value === "object") {
    const type = String(value.type || "").toLowerCase();
    if (!includeThinking && (type === "thinking" || type === "reasoning")) return "";
    if (typeof value.text === "string") return value.text;
    if (includeThinking && typeof value.thinking === "string") return value.thinking;
  }
  return "";
}

export function extractStreamParts(parsed) {
  const choice = parsed?.choices?.[0];
  if (!choice) return { content: "", reasoning: "" };
  const delta = choice.delta || {};
  const message = choice.message || {};
  return {
    content: stringifyModelText(delta.content ?? message.content),
    reasoning: stringifyModelText(
      delta.reasoning
      ?? delta.reasoning_content
      ?? delta.thinking
      ?? message.reasoning
      ?? message.reasoning_content
      ?? message.thinking,
      { includeThinking: true },
    ),
  };
}

export function extractStreamDelta(parsed) {
  return extractStreamParts(parsed).content;
}

/**
 * @param {string} chunk - May contain multiple SSE lines.
 * @returns {string[]} content deltas
 */
export function parseSseTranslationChunk(chunk) {
  const deltas = [];
  const state = createSseState((piece) => {
    if (piece) deltas.push(piece);
  });
  for (const line of String(chunk).split(/\r?\n/)) {
    processSseLine(line, state);
  }
  finishSseFrame(state);
  return deltas;
}

export function emptyTokenUsage() {
  return { promptTokens: 0, cachedTokens: 0, completionTokens: 0, requests: 0 };
}

export function formatCompactCount(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Number((n / 1000).toFixed(n >= 100_000 ? 0 : 1))}k`;
  return `${Number((n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1))}M`;
}

export function cacheHitPercent(promptTokens, cachedTokens) {
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const cached = Math.min(Math.max(0, Number(cachedTokens) || 0), prompt);
  return prompt ? Math.round((cached / prompt) * 100) : 0;
}

export function extractTokenUsage(payload) {
  const usage = payload?.usage || {};
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cached = Number(
    details.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cached_tokens
    ?? 0,
  ) || 0;
  return {
    promptTokens: prompt,
    cachedTokens: prompt ? Math.min(cached, prompt) : cached,
    completionTokens: completion,
    requests: prompt || cached || completion ? 1 : 0,
  };
}

export function addTokenUsage(total, piece) {
  const next = total || emptyTokenUsage();
  if (!piece) return next;
  next.promptTokens += piece.promptTokens || 0;
  next.cachedTokens += piece.cachedTokens || 0;
  next.completionTokens += piece.completionTokens || 0;
  next.requests += piece.requests || 0;
  return next;
}

function createSseState(onDelta, allowTools = false) {
  return { dataLines: [], completed: false, outputDone: false, translated: "", reasoning: "", onDelta,
    allowTools, toolCalls: [], reasoningContent: false, reasoningDetails: [], usage: emptyTokenUsage() };
}

function completionMessage(state) {
  const message = { role: "assistant", content: state.translated.trim() || null };
  if (state.toolCalls.length) message.tool_calls = state.toolCalls;
  if (state.reasoningContent) message.reasoning_content = state.reasoning;
  if (state.reasoningDetails.length) message.reasoning_details = state.reasoningDetails;
  return { content: state.translated.trim(), reasoning: state.reasoning, message,
    toolCalls: state.toolCalls, usage: state.usage };
}

export function promptCacheMessages(messages, settings) {
  const host = apiHostname(settings);
  if (host !== "openrouter.ai" || !Array.isArray(messages) || !messages.length) return messages;
  const [first, ...rest] = messages;
  if (typeof first.content !== "string") return messages;
  return [
    {
      ...first,
      content: [{ type: "text", text: first.content, cache_control: { type: "ephemeral" } }],
    },
    ...rest,
  ];
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
  if (parsed?.usage) state.usage = addTokenUsage(emptyTokenUsage(), extractTokenUsage(parsed));
  const reason = parsed?.choices?.[0]?.finish_reason;
  if (reason) {
    if (reason !== "stop" && !(state.allowTools && reason === "tool_calls")) throw new Error(t("modelIncompleteTranslation", { reason }));
    state.outputDone = true;
    // Translation returns plain text and needs no trailing usage frame.
    if (!state.allowTools) state.completed = true;
  }
  const parts = extractStreamParts(parsed);
  const delta = parsed?.choices?.[0]?.delta || {};
  if (delta.reasoning_content !== undefined) state.reasoningContent = true;
  if (Array.isArray(delta.reasoning_details)) state.reasoningDetails.push(...delta.reasoning_details);
  if (state.allowTools) {
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? 0;
      if (!Number.isInteger(index) || index < 0 || index >= 16) throw new Error("Invalid tool call index");
      const target = state.toolCalls[index] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) target.id += call.id;
      if (call.function?.name) target.function.name += call.function.name;
      if (call.function?.arguments) target.function.arguments += call.function.arguments;
    }
  }
  if (parts.reasoning) state.reasoning += parts.reasoning;
  if (parts.content) state.translated += parts.content;
  if (parts.content || parts.reasoning) {
    state.onDelta?.(parts.content, state.translated, { reasoning: state.reasoning });
  }
}

function extractJsonCompletion(data, onDelta, emptyMessage, allowTools = false) {
  if (data?.error) {
    throw new Error(data.error.message || data.error.type || t("translationFailed", { status: "response" }));
  }
  const reason = data?.choices?.[0]?.finish_reason;
  if (reason !== undefined && reason !== null && reason !== "stop" && !(allowTools && reason === "tool_calls")) {
    throw new Error(t("modelIncompleteTranslation", { reason }));
  }
  const parts = extractStreamParts(data);
  const content = parts.content.trim();
  if (!content && !(allowTools && data?.choices?.[0]?.message?.tool_calls?.length)) throw new Error(emptyMessage);
  onDelta?.(content, { reasoning: parts.reasoning });
  const usage = extractTokenUsage(data);
  if (allowTools) return { content, reasoning: parts.reasoning,
    message: { ...data.choices[0].message, role: "assistant" },
    toolCalls: data.choices[0].message.tool_calls || [], usage };
  return content;
}

async function readStreamingCompletion(response, { onDelta, signal, emptyMessage, allowTools = false } = {}) {
  if (!response.body) {
    const data = await response.json().catch(() => ({}));
    return extractJsonCompletion(data, onDelta, emptyMessage, allowTools);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const state = createSseState((_piece, complete, extras) => onDelta?.(complete, extras), allowTools);
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
    if (state.completed || state.outputDone) await reader.cancel().catch(() => {});
    const trimmed = state.translated.trim();
    if (!state.completed && !state.outputDone) throw new Error(t("modelIncompleteTranslation", { reason: "EOF" }));
    if (!trimmed && !(allowTools && state.toolCalls.length)) throw new Error(emptyMessage);
    return allowTools ? completionMessage(state) : trimmed;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * OpenAI-compatible chat completions (OpenRouter, OpenAI, local proxies, etc.).
 * @param {{ apiKey?: string, apiBaseUrl?: string, model?: string, reasoningEffort?: string, showThinking?: boolean }} settings
 * @param {{ messages: Array<{role: string, content: string}>, signal?: AbortSignal, timeoutMs?: number, onDelta?: (text: string, extras?: { reasoning?: string }) => void, temperature?: number, emptyMessage?: string, cancelledMessage?: string, timeoutMessage?: string }} options
 */
export async function completeChat(
  settings,
  {
    messages,
    signal,
    timeoutMs = 60_000,
    onDelta,
    temperature = 0.1,
    tools,
    toolChoice,
    returnMessage = false,
    maxOutputTokens,
    disableReasoning = false,
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
    const payload = {
      model: settings.model || DEFAULT_MODEL,
      temperature,
      ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
      stream: true,
      messages: promptCacheMessages(messages, settings),
      ...chatReasoningFields(settings, { disableReasoning }),
      ...(tools?.length ? { tools, tool_choice: toolChoice || "auto" } : {}),
      ...(returnMessage ? { stream_options: { include_usage: true } } : {}),
    };
    const post = (body) => fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let response = await post(payload);
    if (!response.ok && payload.stream_options && [400, 404, 422].includes(response.status)) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error?.message || "";
      if (/stream_options|include_usage|unknown( parameter| field)?|unrecognized/i.test(message)) {
        delete payload.stream_options;
        response = await post(payload);
      } else {
        const error = new Error(message || t("translationFailed", { status: response.status }));
        error.status = response.status;
        throw error;
      }
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.error?.message || t("translationFailed", { status: response.status });
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("text/event-stream")) {
      return await readStreamingCompletion(response, {
        onDelta,
        signal: controller.signal,
        emptyMessage,
        allowTools: returnMessage,
      });
    }
    const data = await response.json().catch(() => ({}));
    return extractJsonCompletion(data, onDelta, emptyMessage, returnMessage);
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

export function completeChatTurn(settings, options) {
  return completeChat(settings, { ...options, returnMessage: true });
}
