// Keep normalized search positions mapped to the original concatenated PDF text.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function buildTextIndex(textContent) {
  let text = "", raw = 0, previous = null;
  /** normToRaw[i] = raw UTF-16 start; normToRawEnd[i] = raw UTF-16 end for normalized char i */
  const normToRaw = [];
  const normToRawEnd = [];
  const dehyphenatedPositions = new Set();
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
      const discretionaryBreak = /\u00AD$/u.test(previous.str);
      const continuation = item.str.replace(/^\u00AD+/u, "");
      const lineEndHyphen = previous.hasEOL && /\p{L}[-\u2010\u2011]$/u.test(previous.str) &&
        /^\p{L}/u.test(continuation);
      const dehyphenatableBreak = lineEndHyphen && /^\p{Ll}/u.test(continuation);
      if (lineEndHyphen) {
        // Keep the source hyphen in the primary index. A separate, optional
        // index supports the common discretionary break without losing true
        // compounds such as "well-known".
        const hyphenIndex = text.length - 1;
        if (dehyphenatableBreak && /[-\u2010\u2011]$/u.test(text)) {
          dehyphenatedPositions.add(hyphenIndex);
        }
      } else if ((!cjkBoundary && previous.hasEOL && !discretionaryBreak) || gap) {
        appendNormalized(" ", raw, raw);
      }
    }
    for (const { segment, index } of GRAPHEME_SEGMENTER.segment(item.str)) {
      const normalized = segment.replace(/\u00AD/gu, "").normalize("NFKC").replace(/\s+/gu, " ");
      appendNormalized(normalized, raw + index, raw + index + segment.length);
    }
    raw += item.str.length;
    // Empty EOL items must carry their line break to the next text item.
    if (item.str) previous = item;
    else if (item.hasEOL && previous) previous = { ...previous, hasEOL: true };
  }

  // Most pages have no discretionary line-end hyphens. Only those pages pay
  // for an alternate text and mapping so search can try both spellings.
  let alternateIndex;
  if (dehyphenatedPositions.size) {
    let alternateText = "";
    const alternateNormToRaw = [];
    const alternateNormToRawEnd = [];
    for (let i = 0; i < text.length; i += 1) {
      if (dehyphenatedPositions.has(i)) continue;
      alternateText += text[i];
      alternateNormToRaw.push(normToRaw[i]);
      alternateNormToRawEnd.push(normToRawEnd[i]);
    }
    alternateIndex = {
      text: alternateText,
      normToRaw: alternateNormToRaw,
      normToRawEnd: alternateNormToRawEnd,
      rawLength: raw,
    };
  }
  return { text, normToRaw, normToRawEnd, rawLength: raw, alternateIndex };
}

function queryPattern(query) {
  const needle = query.replace(/\u00AD/gu, "").normalize("NFKC").replace(/\s+/gu, " ").trim();
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
    const pageHits = [];
    const seenRanges = new Set();
    for (const [variant, index] of [page, page.alternateIndex].filter(Boolean).entries()) {
      for (const match of index.text.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        const range = rawRange(index, start, end);
        const key = `${range.offset}:${range.length}`;
        if (variant && seenRanges.has(key)) continue;
        const snippetStart = Math.max(0, start - 28);
        const snippetEnd = Math.min(index.text.length, end + 42);
        pageHits.push({
          pageNumber: page.pageNumber,
          ...range,
          snippet: `${snippetStart > 0 ? "…" : ""}${index.text.slice(snippetStart, snippetEnd)}${snippetEnd < index.text.length ? "…" : ""}`,
        });
        seenRanges.add(key);
      }
    }
    hits.push(...pageHits.sort((a, b) => a.offset - b.offset));
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

// Raw offsets are UTF-16 positions in textContentItemsStr.join("");
// synthetic search spaces never consume raw positions.
export function buildTextMapping(textDivs, textContentItemsStr) {
  let offset = 0;
  const entries = textContentItemsStr.map((str, i) => {
    const entry = { div: textDivs[i], start: offset, end: offset + str.length };
    offset = entry.end;
    return entry;
  });
  return { textDivs, textContentItemsStr, entries };
}

export function matchRects(mapping, layer, offset, length) {
  if (!mapping || length <= 0) return [];
  const entries = mapping.entries.filter(e => e.end > offset && e.start < offset + length && e.div?.isConnected);
  if (!entries.length) return [];
  const origin = layer.getBoundingClientRect();
  const sx = layer.clientWidth ? origin.width / layer.clientWidth : 1;
  const sy = layer.clientHeight ? origin.height / layer.clientHeight : 1;
  const rects = [];
  // Measure the participating text nodes separately so PDF.js's movable
  // endOfContent sentinel (or marked-content wrappers) cannot add a page box.
  for (const entry of entries) {
    const node = entry.div?.firstChild;
    if (!node) continue;
    const range = layer.ownerDocument.createRange();
    const start = Math.max(0, offset - entry.start);
    const end = Math.min(entry.end, offset + length) - entry.start;
    try {
      if (typeof node.nodeValue === "string") {
        const max = node.nodeValue.length;
        range.setStart(node, Math.min(start, max));
        range.setEnd(node, Math.min(Math.max(end, start), max));
      } else {
        range.setStart(node, start);
        range.setEnd(node, end);
      }
    } catch {
      continue;
    }
    for (const r of range.getClientRects()) {
      if (r.width > 0 && r.height > 0) rects.push({
        left: (r.left - origin.left) / sx, top: (r.top - origin.top) / sy,
        width: r.width / sx, height: r.height / sy,
      });
    }
  }
  // Merge only overlapping/adjacent boxes on the same visual line. Rotated
  // text retains the browser's transformed bounding boxes, without PDF guesses.
  const merged = [];
  for (const rect of rects) {
    const prev = merged.find(r => Math.abs(r.top - rect.top) <= 1 &&
      Math.abs(r.height - rect.height) <= 1 &&
      rect.left <= r.left + r.width + 1 && r.left <= rect.left + rect.width + 1);
    if (prev) {
      const right = Math.max(prev.left + prev.width, rect.left + rect.width);
      prev.left = Math.min(prev.left, rect.left);
      prev.width = right - prev.left;
    } else merged.push({ ...rect });
  }
  return merged;
}
