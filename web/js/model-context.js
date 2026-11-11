import { DEFAULT_MODEL, normalizeApiBase } from "./openai-chat.js";

const windows = new Map();
const key = (settings, model) => `${normalizeApiBase(settings?.apiBaseUrl)}|${model || settings?.model || DEFAULT_MODEL}`;

export function rememberModelContexts(settings, rows) {
  for (const row of rows) {
    if (!row || typeof row !== "object" || !(row.id || row.name)) continue;
    const size = Number(row.context_length ?? row.context_window ?? row.max_context_length);
    if (Number.isFinite(size) && size >= 4096) windows.set(key(settings, row.id || row.name), size);
  }
}

export function modelContextWindow(settings) {
  return windows.get(key(settings)) || 32_768;
}
