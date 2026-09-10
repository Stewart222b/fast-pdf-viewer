export function searchDocument(pageTexts, query) {
  const needle = query.trim();
  if (!needle) return [];
  const lower = needle.toLowerCase();
  const hits = [];
  for (const page of pageTexts) {
    const hay = page.text;
    const hayLower = hay.toLowerCase();
    let from = 0;
    while (from < hayLower.length) {
      const index = hayLower.indexOf(lower, from);
      if (index === -1) break;
      const start = Math.max(0, index - 28);
      const end = Math.min(hay.length, index + needle.length + 42);
      hits.push({
        pageNumber: page.pageNumber,
        offset: index,
        length: needle.length,
        snippet: `${start > 0 ? "…" : ""}${hay.slice(start, end)}${end < hay.length ? "…" : ""}`,
      });
      from = index + Math.max(needle.length, 1);
    }
  }
  return hits;
}

export function highlightSnippet(snippet, query) {
  const needle = query.trim();
  if (!needle) return escapeHtml(snippet);
  const source = escapeHtml(snippet);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(new RegExp(escaped, "ig"), (m) => `<mark>${m}</mark>`);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
