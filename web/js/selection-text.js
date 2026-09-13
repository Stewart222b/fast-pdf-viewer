/** @typedef {'term' | 'passage'} TranslationMode */

const SENTENCE_END = /[.!?…][)"'»」】]?\s*$/;
const HYPHEN_BREAK = /-\s*$/;
const BULLET_START = /^(?:[•●◦\-–—*]|\d+[.)])\s+/;
const PARA_START = /^(?:If|When|The|This|These|For|In|On|At|A|An|However|Note)\b/;

/**
 * PDF.js text layers emit one DOM line per visual wrap; Selection#toString() joins with `\n`.
 * @param {string} raw
 * @param {Range} [range]
 */
export function normalizePdfSelectionText(raw, range = null) {
  const lines = extractLogicalLines(raw, range);
  return reflowLinesToParagraphs(lines);
}

export function extractLogicalLines(raw, range = null) {
  const fromGeometry = range ? linesFromRangeGeometry(range) : null;
  if (fromGeometry?.length) return fromGeometry;
  return String(raw || "")
    .replace(/\u00AD/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function linesFromRangeGeometry(range) {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;

  const bands = groupRectsByLine(rects);
  bands.sort((a, b) => a.top - b.top || a.left - b.left);

  const lines = [];
  for (const band of bands) {
    const line = extractRangeTextInBand(range, band);
    if (line.trim()) lines.push(line.trim());
  }
  return lines.length ? lines : null;
}

function groupRectsByLine(rects, slop = 3) {
  const bands = [];
  for (const rect of rects) {
    const last = bands[bands.length - 1];
    if (!last || Math.abs(rect.top - last.top) > slop) {
      bands.push({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      });
      continue;
    }
    last.top = Math.min(last.top, rect.top);
    last.bottom = Math.max(last.bottom, rect.bottom);
    last.left = Math.min(last.left, rect.left);
    last.right = Math.max(last.right, rect.right);
  }
  return bands;
}

function extractRangeTextInBand(range, band) {
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return range.intersectsNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );

  let out = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue || "";
    for (let i = 0; i < text.length; i += 1) {
      const sub = document.createRange();
      try {
        sub.setStart(node, i);
        sub.setEnd(node, i + 1);
      } catch {
        continue;
      }
      if (sub.compareBoundaryPoints(Range.END_TO_START, range) <= 0) continue;
      if (sub.compareBoundaryPoints(Range.START_TO_END, range) >= 0) continue;
      const r = sub.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const midY = (r.top + r.bottom) / 2;
      if (midY >= band.top - 2 && midY <= band.bottom + 2) {
        out += text[i];
      }
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

export function reflowLinesToParagraphs(lines) {
  if (!lines.length) return "";

  const paragraphs = [];
  let current = lines[0];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const prev = current;
    const gapBefore = shouldStartNewParagraph(prev, line);
    if (gapBefore) {
      paragraphs.push(prev);
      current = line;
      continue;
    }
    if (HYPHEN_BREAK.test(prev)) {
      current = prev.replace(/-\s*$/, "") + line;
    } else {
      current = `${prev} ${line}`;
    }
  }
  paragraphs.push(current);
  return paragraphs.join("\n\n");
}

function shouldStartNewParagraph(prev, next) {
  if (!prev || !next) return false;
  if (BULLET_START.test(next)) return true;
  if (!SENTENCE_END.test(prev)) return false;
  if (PARA_START.test(next)) return true;
  if (/^[A-Z]["']?/.test(next) && prev.length >= 48) return true;
  if (/^[\u4e00-\u9fff]/.test(next) && SENTENCE_END.test(prev)) return true;
  return false;
}

/**
 * @param {Selection} selection
 */
export function prepareSelectionForTranslation(selection) {
  const raw = selection?.toString() || "";
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const text = normalizePdfSelectionText(raw, range).trim();
  const mode = classifyTranslationMode(text);
  return { text, mode, raw };
}

/** @returns {TranslationMode} */
export function classifyTranslationMode(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "passage";
  if (/[\n]{2,}/.test(trimmed)) return "passage";
  if (/[.!?。！？;；:：]/.test(trimmed)) return "passage";
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length > 3) return "passage";
  if (trimmed.length > 40) return "passage";
  return "term";
}

export function truncateBubblePreview(text, max = 480) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
