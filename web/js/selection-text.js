/** @typedef {'term' | 'passage'} TranslationMode */

import { MAX_TRANSLATE_CHARS } from "./translate-provider.js";

const SENTENCE_END = /[.!?…][)"'»」】]?\s*$/;
const HYPHEN_BREAK = /-\s*$/;
const BULLET_START = /^(?:[•●◦\-–—*]|\d+[.)])\s+/;
const PARA_START = /^(?:If|When|The|This|These|For|In|On|At|A|An|However|Note)\b/;
const SPAN_GAP_PX = 2;

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
  const fragments = collectRangeCharacterFragments(range);
  if (!fragments.length) return null;

  const lineGroups = groupFragmentsByLine(fragments);
  lineGroups.sort((a, b) => a.top - b.top);
  const lines = lineGroups
    .map((group) => joinFragmentsWithSpanGaps(group.fragments))
    .filter((line) => line.trim());
  return lines.length ? lines : null;
}

/** @param {{ char: string, left: number, right: number, top: number, bottom: number }[]} fragments */
export function joinFragmentsWithSpanGaps(fragments) {
  const sorted = [...fragments].sort((a, b) => a.left - b.left || a.top - b.top);
  let out = "";
  let prevRight = null;
  for (const piece of sorted) {
    if (piece.char === "\n") continue;
    if (
      prevRight != null &&
      piece.left - prevRight > SPAN_GAP_PX &&
      out &&
      !out.endsWith(" ") &&
      !/^\s/.test(piece.char)
    ) {
      out += " ";
    }
    out += piece.char;
    prevRight = piece.right;
  }
  return out.replace(/\s+/g, " ").trim();
}

function groupFragmentsByLine(fragments, slop = 3) {
  const lines = [];
  for (const fragment of fragments) {
    const midY = (fragment.top + fragment.bottom) / 2;
    let line = lines.find((row) => Math.abs(midY - row.midY) <= slop);
    if (!line) {
      line = { midY, top: fragment.top, fragments: [] };
      lines.push(line);
    }
    line.fragments.push(fragment);
    line.midY = (line.midY + midY) / 2;
    line.top = Math.min(line.top, fragment.top);
  }
  return lines;
}

function collectRangeCharacterFragments(range) {
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

  const fragments = [];
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
      fragments.push({
        char: text[i],
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      });
    }
  }
  return fragments;
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
  if (raw.length > MAX_TRANSLATE_CHARS) {
    return {
      text: "",
      mode: "passage",
      raw,
      tooLong: true,
      charCount: raw.length,
    };
  }
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
