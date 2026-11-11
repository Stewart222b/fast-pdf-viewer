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

function splitTableCells(line) {
  let value = String(line).trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map(cell => cell.trim());
}

function isTableSeparatorLine(line) {
  if (!line || !line.includes("-")) return false;
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isTableStart(lines, index) {
  const row = lines[index];
  const separator = lines[index + 1];
  return Boolean(row?.includes("|") && isTableSeparatorLine(separator));
}

function tableAlign(cell) {
  const compact = cell.replace(/\s+/g, "");
  const left = compact.startsWith(":");
  const right = compact.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "";
}

function appendTable(parent, lines, index, options) {
  const header = splitTableCells(lines[index]);
  const aligns = splitTableCells(lines[index + 1]).map(tableAlign);
  index += 2;
  const rows = [];
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || !line.includes("|") || isTableSeparatorLine(line) || listItem(line)) break;
    rows.push(splitTableCells(line));
    index += 1;
  }

  const wrap = document.createElement("div");
  wrap.className = "md-table";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  header.forEach((cell, column) => {
    const th = document.createElement("th");
    if (aligns[column]) th.style.textAlign = aligns[column];
    appendInlineMarkdown(th, cell, options);
    headRow.append(th);
  });
  head.append(headRow);
  table.append(head);
  if (rows.length) {
    const body = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (let column = 0; column < header.length; column += 1) {
        const td = document.createElement("td");
        if (aligns[column]) td.style.textAlign = aligns[column];
        appendInlineMarkdown(td, row[column] || "", options);
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);
  }
  wrap.append(table);
  parent.append(wrap);
  return index;
}

function appendInlineMarkdown(parent, text, { renderReference } = {}) {
  const pattern = /\[[^\]\n]+\]\(pdf:\d+\)|\[\[p\d+\]\]|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|`[^`\n]+`/g;
  let offset = 0;
  for (const match of String(text).matchAll(pattern)) {
    const token = match[0];
    const start = match.index;
    if (start > offset) parent.append(document.createTextNode(text.slice(offset, start)));
    const reference = token.match(/^\[([^\]]+)\]\(pdf:(\d+)\)$/) || token.match(/^\[\[(p)(\d+)\]\]$/);
    if (reference) {
      parent.append(renderReference?.({ pageNumber: Number(reference[2]), label: reference[1] === "p" ? `p${reference[2]}` : reference[1] }) || document.createTextNode(token));
      offset = start + token.length;
      continue;
    }
    const isBold = token.startsWith("**");
    const isCode = token.startsWith("`");
    const element = document.createElement(isBold ? "strong" : isCode ? "code" : "em");
    const inner = token.slice(isBold ? 2 : 1, isBold ? -2 : -1);
    if (isCode) element.textContent = inner;
    else appendInlineMarkdown(element, inner, { renderReference });
    parent.append(element);
    offset = start + token.length;
  }
  if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)));
}

/** Render a safe Markdown subset using text nodes; model output is never parsed as HTML. */
export function renderMarkdown(el, text, options = {}) {
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
      appendInlineMarkdown(node, heading[2], options);
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
      appendInlineMarkdown(paragraph, quoteLines.join(" "), options);
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
        appendInlineMarkdown(listNode, item.text, options);
        list.append(listNode);
        index += 1;
      }
      el.append(list);
      continue;
    }

    if (isTableStart(lines, index)) {
      index = appendTable(el, lines, index, options);
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index]) && !isTableStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" "), options);
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
