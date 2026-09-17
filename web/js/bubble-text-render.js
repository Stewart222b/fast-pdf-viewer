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
  renderMarkdown(el, text);
}

function listItem(line) {
  const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
  if (ordered) return { ordered: true, text: ordered[1] };
  const unordered = line.match(/^\s*[-*+•]\s+(.*)$/);
  return unordered ? { ordered: false, text: unordered[1] } : null;
}

function startsBlock(line) {
  return /^ {0,3}(?:#{1,6}\s+|>|```)/.test(line) ||
    /^ {0,3}(?:-{3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line) ||
    Boolean(listItem(line));
}

function appendInlineMarkdown(parent, text) {
  const pattern = /\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|`[^`\n]+`/g;
  let offset = 0;
  for (const match of String(text).matchAll(pattern)) {
    const token = match[0];
    const start = match.index;
    if (start > offset) parent.append(document.createTextNode(text.slice(offset, start)));
    const isBold = token.startsWith("**");
    const isCode = token.startsWith("`");
    const element = document.createElement(isBold ? "strong" : isCode ? "code" : "em");
    element.textContent = token.slice(isBold ? 2 : 1, isBold ? -2 : -1);
    parent.append(element);
    offset = start + token.length;
  }
  if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)));
}

/** Render a safe Markdown subset using text nodes; model output is never parsed as HTML. */
export function renderMarkdown(el, text) {
  el.replaceChildren();
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^ {0,3}```/.test(line)) {
      index += 1;
      const codeLines = [];
      while (index < lines.length && !/^ {0,3}```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      el.append(pre);
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const node = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(node, heading[2]);
      el.append(node);
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      el.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^ {0,3}>\s?/, "").trim());
        index += 1;
      }
      const quote = document.createElement("blockquote");
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, quoteLines.join(" "));
      quote.append(paragraph);
      el.append(quote);
      continue;
    }

    const firstItem = listItem(line);
    if (firstItem) {
      const list = document.createElement(firstItem.ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = listItem(lines[index]);
        if (!item || item.ordered !== firstItem.ordered) break;
        const listNode = document.createElement("li");
        appendInlineMarkdown(listNode, item.text);
        list.append(listNode);
        index += 1;
      }
      el.append(list);
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" "));
    el.append(paragraph);
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
