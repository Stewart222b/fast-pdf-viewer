import { truncateBubblePreview } from "./selection-text.js";

export function renderBubbleSource(el, text, mode, { full = false } = {}) {
  el.classList.toggle("bubble-passage", mode === "passage");
  el.classList.toggle("bubble-term", mode === "term");
  const preview = full ? text : truncateBubblePreview(text);
  if (mode === "passage") {
    renderPassageParagraphs(el, preview);
  } else {
    el.textContent = preview;
  }
}

export function renderBubbleTranslation(el, text, mode, { streaming = false } = {}) {
  el.classList.remove("error");
  el.classList.toggle("bubble-passage", mode === "passage" && !streaming);
  el.classList.toggle("bubble-term", mode === "term" || streaming);
  if (streaming) {
    el.replaceChildren();
    if (text) el.append(document.createTextNode(text));
    const caret = document.createElement("span");
    caret.className = "translate-caret";
    caret.setAttribute("aria-hidden", "true");
    el.append(caret);
    return;
  }
  if (mode === "passage") {
    renderPassageParagraphs(el, text);
  } else {
    el.textContent = text;
  }
}

export function renderPassageParagraphs(el, text) {
  el.replaceChildren();
  const parts = String(text || "").split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return;
  for (const part of parts) {
    const p = document.createElement("p");
    p.textContent = part.replace(/\n+/g, " ");
    el.append(p);
  }
}

export function readBubblePlainText(el) {
  if (!el) return "";
  return (el.innerText || el.textContent || "").replace(/\u00A0/g, " ").trim();
}
