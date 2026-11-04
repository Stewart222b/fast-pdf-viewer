const sessions = new WeakMap();

export function thinkingPreview(text) {
  return String(text || "").trim().split(/\n+/).filter(line => line.trim()).at(-1)?.replace(/\s+/g, " ").slice(-240) || "";
}

// Update existing nodes so streaming never resets the user's disclosure choice.
export function renderThinking({ wrap, body, preview, status }, text, { enabled, streaming = false, label } = {}) {
  const value = enabled ? String(text || "") : "";
  if (!wrap || !body) return;
  if (!value) {
    wrap.hidden = true;
    wrap.open = false;
    body.textContent = "";
    if (preview) preview.textContent = "";
    if (status) status.textContent = "";
    sessions.delete(wrap);
    return;
  }
  if (!sessions.has(wrap)) sessions.set(wrap, { started: Date.now() });
  const session = sessions.get(wrap);
  if (!streaming && !session.finished) session.finished = Date.now();
  const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 32;
  body.textContent = value;
  if (wrap.open && follow) body.scrollTop = body.scrollHeight;
  wrap.hidden = false;
  wrap.classList.toggle("is-streaming", streaming);
  if (preview) preview.textContent = thinkingPreview(value);
  if (status) status.textContent = label?.(streaming, Math.max(1, Math.round(((session.finished || Date.now()) - session.started) / 1000))) || "";
}
