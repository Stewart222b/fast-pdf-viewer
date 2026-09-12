// Keep normalized search positions mapped to the original concatenated PDF text.
export function buildTextIndex(textContent) {
  let text = "", raw = 0, previous = null;
  /** normToRaw[i] = raw UTF-16 start; normToRawEnd[i] = raw UTF-16 end for normalized char i */
  const normToRaw = [];
  const normToRawEnd = [];
  const appendNormalized = (value, rawStart, rawEnd) => {
    if (!value) return;
    if (value === " " && text.endsWith(" ")) return;
    for (let i = 0; i < value.length; i += 1) {
      normToRaw.push(rawStart);
      normToRawEnd.push(rawEnd);
    }
    text += value;
  };
  for (const item of textContent.items) {
    if (typeof item.str !== "string") continue;
    if (previous && item.str) {
      const cjkBoundary = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(previous.str) &&
        /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(item.str);
      const a = previous.transform, b = item.transform;
      const height = Math.abs(previous.height || a?.[3] || 10);
      const horizontal = a && b && Math.abs(a[1]) < 0.01 && Math.abs(b[1]) < 0.01 &&
        previous.dir !== "rtl" && item.dir !== "rtl";
      const gap = horizontal && Math.abs(a[5] - b[5]) < height * 0.5 &&
        b[4] - (a[4] + previous.width) > height * 0.2;
      if ((!cjkBoundary && previous.hasEOL) || gap) appendNormalized(" ", raw, raw);
    }
    for (const char of item.str) {
      const normalized = char.normalize("NFKC").replace(/\s+/gu, " ");
      const rawEnd = raw + char.length;
      appendNormalized(normalized, raw, rawEnd);
      raw = rawEnd;
    }
    // Empty EOL items must carry their line break to the next text item.
    if (item.str) previous = item;
    else if (item.hasEOL && previous) previous = { ...previous, hasEOL: true };
  }
  return { text, normToRaw, normToRawEnd, rawLength: raw };
}

function queryPattern(query) {
  const needle = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : null;
}

function rawRange(page, start, end) {
  const { normToRaw, normToRawEnd, rawLength, text } = page;
  if (!normToRaw?.length || !text?.length) return { offset: start, length: end - start };
  const offset = normToRaw[start] ?? 0;
  const rawEnd = end <= 0 ? offset
    : end < text.length ? (normToRawEnd[end - 1] ?? rawLength)
      : (normToRawEnd.at(-1) ?? rawLength);
  return { offset, length: Math.max(0, rawEnd - offset) };
}

export function searchDocument(pageTexts, query) {
  const pattern = queryPattern(query);
  if (!pattern) return [];
  const hits = [];
  for (const page of pageTexts) {
    if (!page) continue;
    for (const match of page.text.matchAll(pattern)) {
      const index = match.index, length = match[0].length;
      const start = Math.max(0, index - 28), end = Math.min(page.text.length, index + length + 42);
      hits.push({
        pageNumber: page.pageNumber,
        ...rawRange(page, index, index + length),
        snippet: `${start > 0 ? "…" : ""}${page.text.slice(start, end)}${end < page.text.length ? "…" : ""}`,
      });
    }
  }
  return hits;
}

export function highlightSnippet(snippet, query) {
  const pattern = queryPattern(query);
  if (!pattern) return escapeHtml(snippet);
  let result = "", from = 0;
  for (const match of snippet.matchAll(pattern)) {
    result += escapeHtml(snippet.slice(from, match.index)) + `<mark>${escapeHtml(match[0])}</mark>`;
    from = match.index + match[0].length;
  }
  return result + escapeHtml(snippet.slice(from));
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function matchRects(textContent, viewport, offset, length) {
  const items = textContent.items.filter((item) => typeof item.str === "string");
  let cursor = 0;
  const rects = [];
  const end = offset + length;
  for (const item of items) {
    const next = cursor + item.str.length;
    const overlapStart = Math.max(offset, cursor);
    const overlapEnd = Math.min(end, next);
    if (overlapEnd > overlapStart && item.transform) {
      const [a, b, , , tx, ty] = item.transform;
      const width = item.width ?? Math.hypot(a, b) * item.str.length;
      const height = item.height ?? Math.abs(item.transform[3] || a);
      const localStart = overlapStart - cursor;
      const localEnd = overlapEnd - cursor;
      const ratioStart = item.str.length ? localStart / item.str.length : 0;
      const ratioEnd = item.str.length ? localEnd / item.str.length : 1;
      const x = tx + width * ratioStart;
      const w = width * (ratioEnd - ratioStart);
      const [x1, y1] = viewport.convertToViewportPoint(x, ty);
      const [x2, y2] = viewport.convertToViewportPoint(x + w, ty + height);
      rects.push({
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
    }
    cursor = next;
  }
  return rects;
}
