import { t } from "./i18n.js";
import { completeChat } from "./openai-chat.js";
import { searchDocument } from "./search.js";

export const MAX_ASK_QUESTION_CHARS = 500;
export const MAX_EXCERPT_CHARS = 12_000;
export const MAX_ASK_PAGES = 8;
export const ASK_TIMEOUT_MS = 90_000;
/** Characters kept on each side of a keyword hit when a page is too long. */
export const MATCH_WINDOW_CHARS = 360;
/** Head of a sampled/anchor page when the whole page would blow the budget. */
export const SAMPLE_PAGE_HEAD_CHARS = 1_800;

const LANG_NAME = {
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  en: "English",
  ja: "日本語",
};

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were",
  "be", "been", "being", "with", "by", "from", "as", "at", "it", "this", "that", "these",
  "those", "what", "where", "when", "which", "who", "how", "why", "do", "does", "did",
  "can", "could", "should", "would", "will", "about", "into", "over", "under", "than",
  "then", "there", "here", "any", "all", "each", "other", "some", "such", "not", "no",
  "yes", "if", "but", "so", "too", "very", "just", "also", "please", "tell", "me", "my",
  "your", "you", "we", "our", "they", "their", "i", "he", "she",
  "的", "了", "在", "是", "和", "与", "或", "及", "等", "这", "那", "哪", "什么", "怎么",
  "如何", "为什么", "哪里", "哪个", "请问", "一下", "有没有", "多少", "是否",
]);

const GREETINGS = new Set([
  "你好", "您好", "哈喽", "嗨", "hello", "hi", "hey", "thanks", "thank", "谢谢",
]);

/**
 * @param {string} question
 * @returns {string[]}
 */
export function askQuestionTokens(question) {
  const text = String(question || "").normalize("NFKC").toLowerCase().trim();
  if (!text) return [];
  const tokens = [];
  const seen = new Set();
  const push = (token) => {
    const value = String(token || "").trim();
    if (!value || value.length < 2 || STOPWORDS.has(value) || GREETINGS.has(value) || seen.has(value)) return;
    seen.add(value);
    tokens.push(value);
  };
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._/-]{1,}|[\p{Script=Han}]{2,}/gu)) {
    const chunk = match[0];
    if (/^[\p{Script=Han}]+$/u.test(chunk) && chunk.length > 4) {
      for (let i = 0; i < chunk.length - 1; i += 1) push(chunk.slice(i, i + 2));
      if (chunk.length >= 3) {
        for (let i = 0; i < chunk.length - 2; i += 1) push(chunk.slice(i, i + 3));
      }
    } else {
      push(chunk);
    }
  }
  return tokens;
}

const CJK_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function parseCjkInt(raw) {
  const text = String(raw || "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!text) return NaN;
  if (text === "十") return 10;
  if (text.startsWith("十")) return 10 + (CJK_DIGITS[text.slice(1)] ?? 0);
  const ten = text.indexOf("十");
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : CJK_DIGITS[text.slice(0, ten)];
    const ones = text.slice(ten + 1) ? (CJK_DIGITS[text.slice(ten + 1)] ?? 0) : 0;
    if (!Number.isInteger(tens)) return NaN;
    return tens * 10 + ones;
  }
  return CJK_DIGITS[text] ?? NaN;
}

/**
 * @param {string} question
 * @returns {{ chapter: number } | null}
 */
export function parseChapterRef(question) {
  const text = String(question || "").replace(/\u00AD/gu, "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const cjk = text.match(/第\s*([0-9]+|[一二三四五六七八九十两〇零]+)\s*章/);
  if (cjk) {
    const chapter = parseCjkInt(cjk[1]);
    if (Number.isInteger(chapter) && chapter > 0) return { chapter };
  }
  const en = text.match(/\b(?:chapters?|ch\.?)\s*([0-9]+)\b/i);
  if (en) {
    const chapter = Number(en[1]);
    if (Number.isInteger(chapter) && chapter > 0) return { chapter };
  }
  return null;
}

function stripChapterRef(question) {
  return String(question || "")
    .replace(/第\s*(?:[0-9]+|[一二三四五六七八九十两〇零]+)\s*章/g, " ")
    .replace(/\b(?:chapters?|ch\.?)\s*[0-9]+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rule-based intent: survey the whole document, locate a fact, or use the
 * current page as an anchor (greetings / no content words).
 * @param {string} question
 * @returns {"survey" | "locate" | "anchor"}
 */
export function classifyAskIntent(question) {
  const text = String(question || "").replace(/\u00AD/gu, "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return "anchor";
  if (isSurveyQuestion(text)) return "survey";
  const rest = stripChapterRef(text);
  if (!askQuestionTokens(rest || text).length) return "anchor";
  return "locate";
}

function isSurveyQuestion(text) {
  const lower = text.toLowerCase();
  if (/^什么是/.test(text) || /^what is (?!this\b)/i.test(lower)) return false;
  if (/(?:总结|概括|概述|摘要)(?:一下|下)?/.test(text)) return true;
  if (/(?:主要内容|全文概括|大意|讲什么|讲的什么|讲的是什么|关于什么|是什么内容)/.test(text)) return true;
  if (/(?:这份|这篇|这个|本)\s*(?:pdf|文档|文件|说明书)\s*(?:是什么|讲什么|讲的什么|讲的是什么|关于什么)/i.test(text)) return true;
  if (/\b(?:summarize|summary|overview|tldr|tl;dr|abstract)\b/i.test(lower)) return true;
  if (/\bwhat(?:'s| is) this(?: pdf| document| file)?(?: about)?\??$/i.test(lower)) return true;
  if (/\bwhat is this (?:pdf|document|file) about\b/i.test(lower)) return true;
  if (/\bwhat does (?:this |the )?chapter\b/i.test(lower)) return true;
  if (/\bchapter\s+\d+\s+(?:about|cover|covers|contain|contains)\b/i.test(lower)) return true;
  return false;
}

function pageBody(page) {
  return String(page?.text || "");
}

function packedBody(page) {
  return pageBody(page).replace(/\s+/g, " ").trim();
}

function nonemptyPages(pageTexts) {
  return (Array.isArray(pageTexts) ? pageTexts : []).filter((page) => page && packedBody(page));
}

function pageByNumber(pages, pageNumber) {
  const n = Number(pageNumber);
  if (!Number.isInteger(n) || n < 1) return null;
  return pages.find((page) => page.pageNumber === n) || null;
}

function normalizeOutlineEntries(outline) {
  const rows = [];
  for (const item of Array.isArray(outline) ? outline : []) {
    if (typeof item === "string") {
      const title = item.replace(/\s+/g, " ").trim();
      if (title) rows.push({ title, pageNumber: 0, depth: 0 });
      continue;
    }
    const title = String(item?.title || "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    const pageNumber = Number(item.pageNumber);
    const depth = Number(item.depth);
    rows.push({
      title,
      pageNumber: Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 0,
      depth: Number.isInteger(depth) && depth >= 0 ? depth : 0,
    });
  }
  return rows;
}

function normalizeOutline(outline) {
  return [...new Set(normalizeOutlineEntries(outline).map((row) => row.title))].slice(0, 80);
}

function titleChapterNumber(title) {
  const text = String(title || "");
  const en = text.match(/^\s*(?:chapter|ch\.?)\s*([0-9]+)\b/i);
  if (en) return Number(en[1]);
  const cjk = text.match(/^\s*第\s*([0-9]+|[一二三四五六七八九十两〇零]+)\s*章/);
  if (cjk) {
    const chapter = parseCjkInt(cjk[1]);
    if (Number.isInteger(chapter) && chapter > 0) return chapter;
  }
  return 0;
}

function findOutlineChapter(entries, chapter) {
  let best = null;
  for (const row of entries) {
    if (titleChapterNumber(row.title) !== chapter) continue;
    if (!best || row.depth < best.depth) best = row;
  }
  return best;
}

function outlineRange(entries, startRow, lastPage) {
  const start = startRow?.pageNumber || 0;
  if (!start) return null;
  let end = lastPage || start;
  for (const row of entries) {
    if (row.pageNumber > start && row.depth <= startRow.depth) {
      end = row.pageNumber - 1;
      break;
    }
  }
  if (end < start) end = start;
  return { start, end };
}

function headerChapterRange(pages, chapter) {
  const lead = /\b(?:chapter|ch\.?)\s*(\d+)\s*[.:—–-]\s*\S/i;
  const hits = [];
  const chapterStarts = [];
  for (const page of pages) {
    const bodyLead = packedBody(page).slice(0, 200);
    const heading = bodyLead.match(lead);
    if (!heading) continue;
    const prefix = bodyLead.slice(0, heading.index);
    if (/[.!?;:]\s+[A-Z][a-z]/u.test(prefix) || /\b(?:see|refer to|cf\.?)\s*$/iu.test(prefix)) continue;
    const row = { pageNumber: page.pageNumber, chapter: Number(heading[1]) };
    chapterStarts.push(row);
    if (row.chapter === chapter) hits.push(row.pageNumber);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a - b);
  let bestStart = hits[0];
  let bestEnd = hits[0];
  let curStart = hits[0];
  let prev = hits[0];
  const closeRun = () => {
    if (prev - curStart >= bestEnd - bestStart) {
      bestStart = curStart;
      bestEnd = prev;
    }
  };
  for (let i = 1; i < hits.length; i += 1) {
    if (hits[i] <= prev + 2) {
      prev = hits[i];
      continue;
    }
    closeRun();
    curStart = hits[i];
    prev = hits[i];
  }
  closeRun();
  // Prefer the next chapter title when available so intermittent running
  // headers do not truncate the current chapter.
  const start = chapterStarts.find((row) => row.chapter === chapter && row.pageNumber === bestStart);
  if (!start) return null;
  const nextChapter = chapterStarts.find((row) => row.pageNumber > start.pageNumber && row.chapter > chapter);
  if (nextChapter) return { start: start.pageNumber, end: Math.max(start.pageNumber, nextChapter.pageNumber - 1) };
  // Repeated headers provide a range if no later title is present. A lone
  // mention without a closing boundary is too uncertain; use full-document search.
  if (bestEnd > bestStart) return { start: bestStart, end: bestEnd };
  return null;
}

function pagesInRange(pages, start, end) {
  return pages.filter((page) => page.pageNumber >= start && page.pageNumber <= end);
}

function sectionOutlineTitles(entries, scope) {
  if (!scope) return entries.map((row) => row.title).slice(0, 80);
  const startRow = findOutlineChapter(entries, scope.chapter);
  if (!startRow) {
    return entries
      .filter((row) => !row.pageNumber || (row.pageNumber >= scope.start && row.pageNumber <= scope.end))
      .map((row) => row.title)
      .slice(0, 80);
  }
  const titles = [];
  let started = false;
  for (const row of entries) {
    if (row === startRow) started = true;
    if (!started) continue;
    if (titles.length && row.depth <= startRow.depth) break;
    titles.push(row.title);
  }
  return titles.slice(0, 80);
}

function resolveChapterScope(pages, entries, question) {
  const ref = parseChapterRef(question);
  if (!ref) return null;
  const hit = findOutlineChapter(entries, ref.chapter);
  const lastPage = pages[pages.length - 1]?.pageNumber || 0;
  const range = (hit && outlineRange(entries, hit, lastPage)) || headerChapterRange(pages, ref.chapter);
  if (!range) return null;
  return { chapter: ref.chapter, start: range.start, end: range.end };
}

function scorePage(page, tokens, phraseHitsByPage) {
  const text = packedBody(page).toLowerCase();
  if (!text) return 0;
  let score = Number(phraseHitsByPage.get(page.pageNumber) || 0) * 40;
  for (const token of tokens) {
    let from = 0;
    let count = 0;
    while (count < 8) {
      const index = text.indexOf(token, from);
      if (index < 0) break;
      count += 1;
      from = index + token.length;
    }
    if (count) score += count * Math.min(12, 4 + token.length);
  }
  return score;
}

function matchWindows(body, tokens) {
  const lower = body.toLowerCase();
  const ranges = [];
  for (const token of tokens) {
    let from = 0;
    let count = 0;
    while (count < 6) {
      const index = lower.indexOf(token, from);
      if (index < 0) break;
      ranges.push([
        Math.max(0, index - MATCH_WINDOW_CHARS),
        Math.min(body.length, index + token.length + MATCH_WINDOW_CHARS),
      ]);
      from = index + token.length;
      count += 1;
    }
  }
  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range[0] > last[1] + 48) merged.push([...range]);
    else last[1] = Math.max(last[1], range[1]);
  }
  return merged;
}

function clipPageText(body, { tokens = [], reason = "sample", budget }) {
  const limit = Math.max(80, Number(budget) || MAX_EXCERPT_CHARS);

  if (reason === "match" && tokens.length) {
    const windows = matchWindows(body, tokens);
    if (windows.length) {
      const span = windows[windows.length - 1][1] - windows[0][0];
      const coversMost = windows.length === 1 && span >= body.length * 0.8;
      if (!coversMost) {
        const parts = windows.map(([start, end]) => {
          const prefix = start > 0 ? "…" : "";
          const suffix = end < body.length ? "…" : "";
          return `${prefix}${body.slice(start, end)}${suffix}`;
        });
        let text = parts.join(" ");
        if (text.length > limit) text = `${text.slice(0, Math.max(0, limit - 1))}…`;
        return { text, clipped: true };
      }
    }
  }

  if (body.length <= limit) return { text: body, clipped: false };
  const head = Math.min(body.length, Math.min(limit - 1, SAMPLE_PAGE_HEAD_CHARS));
  return { text: `${body.slice(0, head)}…`, clipped: true };
}

function uniquePicks(rows, limit = MAX_ASK_PAGES) {
  const map = new Map();
  for (const row of rows) {
    const page = row?.page;
    if (!page || map.has(page.pageNumber)) continue;
    map.set(page.pageNumber, row);
    if (map.size >= limit) break;
  }
  return [...map.values()];
}

function sampleCoveragePages(pages, slots) {
  const usable = nonemptyPages(pages);
  if (!usable.length || slots <= 0) return [];
  if (usable.length <= slots) {
    return usable.map((page, index) => ({
      page,
      score: index === 0 ? 4 : 1,
      reason: "sample",
    }));
  }
  const picks = [];
  const seen = new Set();
  const add = (page, score) => {
    if (!page || seen.has(page.pageNumber) || picks.length >= slots) return;
    seen.add(page.pageNumber);
    picks.push({ page, score, reason: "sample" });
  };
  add(usable[0], 5);
  add(usable[usable.length - 1], 3);
  const remaining = slots - picks.length;
  if (remaining > 0 && usable.length > 2) {
    for (let i = 1; i <= remaining; i += 1) {
      const index = Math.round((i * (usable.length - 1)) / (remaining + 1));
      add(usable[Math.min(usable.length - 1, Math.max(1, index))], 2);
    }
    for (let i = 1; i < usable.length - 1 && picks.length < slots; i += 1) {
      add(usable[i], 1);
    }
  }
  return picks;
}

function anchorPages(pages, currentPage) {
  const usable = nonemptyPages(pages);
  const nums = [currentPage, currentPage - 1, currentPage + 1, 1];
  const picks = [];
  const seen = new Set();
  for (const n of nums) {
    const page = pageByNumber(usable, n);
    if (!page || seen.has(page.pageNumber)) continue;
    seen.add(page.pageNumber);
    const score = n === currentPage ? 8 : n === 1 ? 4 : 2;
    picks.push({ page, score, reason: "anchor" });
  }
  if (!picks.length && usable[0]) picks.push({ page: usable[0], score: 1, reason: "anchor" });
  return picks;
}

function locatePages(pages, tokens, phraseHitsByPage) {
  return nonemptyPages(pages)
    .map((page) => ({
      page,
      score: scorePage(page, tokens, phraseHitsByPage),
      reason: "match",
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.page.pageNumber - b.page.pageNumber)
    .slice(0, MAX_ASK_PAGES);
}

function neighborPages(pages, picks) {
  const extras = [];
  for (const row of picks.slice(0, 3)) {
    const n = row.page.pageNumber;
    for (const adj of [n - 1, n + 1]) {
      const page = pageByNumber(pages, adj);
      if (page) extras.push({ page, score: Math.max(1, row.score * 0.2), reason: "neighbor" });
    }
  }
  return extras;
}

function phraseHits(pages, question) {
  const phrase = String(question || "").replace(/\u00AD/gu, "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const phraseHitsByPage = new Map();
  if (phrase.length < 2) return phraseHitsByPage;
  for (const hit of searchDocument(pages, phrase)) {
    phraseHitsByPage.set(hit.pageNumber, (phraseHitsByPage.get(hit.pageNumber) || 0) + 1);
  }
  return phraseHitsByPage;
}

function packExcerpts(picks, { tokens, intent }) {
  const ordered = intent === "locate"
    ? [...picks].sort((a, b) => b.score - a.score || a.page.pageNumber - b.page.pageNumber)
    : [...picks].sort((a, b) => a.page.pageNumber - b.page.pageNumber);

  const excerpts = [];
  let used = 0;
  let truncated = false;
  for (const [index, { page, score, reason }] of ordered.entries()) {
    const body = packedBody(page);
    if (!body) continue;
    const header = `--- Page ${page.pageNumber} ---\n`;
    const remaining = MAX_EXCERPT_CHARS - used - header.length;
    const budget = intent === "survey"
      ? Math.floor(remaining / (ordered.length - index))
      : remaining;
    if (budget <= 80) {
      truncated = true;
      break;
    }
    const packed = clipPageText(body, { tokens, reason, budget });
    if (packed.clipped) truncated = true;
    excerpts.push({
      pageNumber: page.pageNumber,
      text: packed.text,
      score,
      reason,
    });
    used += header.length + packed.text.length;
  }
  return { excerpts, truncated };
}

/**
 * Search the whole indexed document, then pack a small page set.
 * Intent picks the pages; the model still only sees those excerpts.
 *
 * @param {Array<{pageNumber: number, text?: string}>} pageTexts
 * @param {string} question
 * @param {string[]} [outlineTitles]
 * @param {{ currentPage?: number }} [options]
 */
export function retrieveExcerpts(pageTexts, question, outlineTitles = [], options = {}) {
  const pages = nonemptyPages(pageTexts);
  const entries = normalizeOutlineEntries(outlineTitles);
  const intent = classifyAskIntent(question);
  const currentPage = Number(options.currentPage) || 0;
  const scope = resolveChapterScope(pages, entries, question);
  const corpus = scope ? pagesInRange(pages, scope.start, scope.end) : pages;
  const usable = corpus.length ? corpus : pages;
  const locateQuestion = stripChapterRef(question) || question;
  const tokens = askQuestionTokens(intent === "locate" ? locateQuestion : question);
  const hitsByPage = phraseHits(usable, locateQuestion);

  let picks = [];
  if (intent === "survey") {
    picks = sampleCoveragePages(usable, MAX_ASK_PAGES);
  } else if (intent === "anchor") {
    picks = uniquePicks([...anchorPages(usable, currentPage), ...sampleCoveragePages(usable, 2)]);
  } else {
    const matches = locatePages(usable, tokens, hitsByPage);
    picks = matches.length
      ? uniquePicks([...matches, ...neighborPages(usable, matches)])
      : uniquePicks([
        ...anchorPages(usable, currentPage),
        ...sampleCoveragePages(usable, MAX_ASK_PAGES),
      ]);
  }

  const outline = scope ? sectionOutlineTitles(entries, scope) : normalizeOutline(entries);
  const { excerpts, truncated } = packExcerpts(picks, { tokens, intent });
  return {
    intent,
    scope,
    excerpts,
    outlineTitles: outline,
    tokens,
    truncated,
    hasPageMatches: excerpts.some((excerpt) => excerpt.reason === "match"),
    canAsk: excerpts.length > 0 || outline.length > 0,
  };
}

/**
 * @param {string} question
 * @param {{ excerpts: Array<{pageNumber: number, text: string}>, outlineTitles: string[], intent?: string }} pack
 * @param {string} targetLang
 */
export function buildAskMessages(question, pack, targetLang) {
  const language = LANG_NAME[targetLang] || targetLang || "简体中文";
  const intent = pack.intent || "locate";
  const sections = [];
  if (pack.outlineTitles?.length) {
    sections.push(`Document outline titles:\n${pack.outlineTitles.map((title) => `- ${title}`).join("\n")}`);
  }
  for (const excerpt of pack.excerpts || []) {
    sections.push(`--- Page ${excerpt.pageNumber} ---\n${excerpt.text}`);
  }
  const context = sections.join("\n\n") || "(no page text available)";
  const retrievalNote = pack.scope?.chapter
    ? `The excerpts are a sample of Chapter ${pack.scope.chapter} (pages ${pack.scope.start}-${pack.scope.end}), not the whole PDF. Treat outline titles as that chapter's section list. Prefer body text over repeated running headers.`
    : intent === "survey"
      ? "The excerpts are a sample across the whole document for an overview question."
      : intent === "anchor"
        ? "The excerpts are nearby pages used as an anchor because the question had no search terms."
        : "The excerpts are the highest-scoring pages from a full-document keyword search.";
  return [
    {
      role: "system",
      content: [
        `You answer questions about one PDF using only the provided excerpts.`,
        retrievalNote,
        `Reply in ${language}.`,
        "If the excerpts do not contain the answer, say so clearly and do not invent details.",
        "For greetings, reply briefly and offer to answer from the document.",
        "Write a concise explanation first.",
        "Then end with a citation block exactly in this form:",
        "---",
        'p12: "exact quote from the excerpts"',
        'p47: "another exact quote"',
        "Use only page numbers that appear in the excerpts. Quotes must be copied from the excerpts, not rewritten.",
        "If you cannot quote a passage, omit the citation block.",
      ].join(" "),
    },
    {
      role: "user",
      content: `Excerpts:\n${context}\n\nQuestion:\n${String(question || "").trim()}`,
    },
  ];
}

/**
 * @param {string} text
 * @returns {{ answer: string, citations: Array<{pageNumber: number, quote: string}> }}
 */
export function parseAskResponse(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return { answer: "", citations: [] };

  const marker = raw.lastIndexOf("\n---\n");
  let answer = raw;
  let citationBlock = "";
  if (marker >= 0) {
    answer = raw.slice(0, marker).trim();
    citationBlock = raw.slice(marker + 5).trim();
  }

  const citations = [];
  const seen = new Set();
  const push = (pageNumber, quote, { allowEmpty = false } = {}) => {
    const page = Number(pageNumber);
    const textQuote = String(quote || "").replace(/\s+/g, " ").trim();
    if (!Number.isInteger(page) || page < 1) return;
    if (!textQuote && !allowEmpty) return;
    const key = `${page}:${textQuote}`;
    if (seen.has(key) || (allowEmpty && !textQuote && seen.has(`page:${page}`))) return;
    if (allowEmpty && !textQuote) seen.add(`page:${page}`);
    else seen.add(key);
    citations.push({ pageNumber: page, quote: textQuote });
  };

  if (citationBlock) {
    for (const line of citationBlock.split("\n")) {
      const match = line.match(/^\s*p\.?\s*(\d+)\s*[:：]\s*["“]?(.+?)["”]?\s*$/i);
      if (match) push(match[1], match[2]);
    }
  }

  if (!citations.length) {
    for (const match of raw.matchAll(/(?:第\s*(\d+)\s*页|p\.?\s*(\d+))/giu)) {
      push(match[1] || match[2], "", { allowEmpty: true });
    }
  }

  return { answer: answer || raw, citations };
}

/**
 * @param {Array<{pageNumber: number, text?: string}>} pageTexts
 * @param {Array<{pageNumber: number, quote: string}>} citations
 */
export function resolveCitations(pageTexts, citations) {
  const pages = Array.isArray(pageTexts) ? pageTexts.filter(Boolean) : [];
  const hits = [];
  const resolved = [];
  for (const citation of citations || []) {
    const pageNumber = Number(citation.pageNumber);
    const quote = String(citation.quote || "").replace(/\s+/g, " ").trim();
    if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;

    let hit = null;
    if (quote) {
      const pageScoped = pages.filter((page) => page.pageNumber === pageNumber);
      const scopedHits = pageScoped.length ? searchDocument(pageScoped, quote) : [];
      hit = scopedHits[0] || searchDocument(pages, quote)[0] || null;
    }

    if (hit) {
      const item = {
        kind: "quote",
        pageNumber: hit.pageNumber,
        offset: hit.offset,
        length: hit.length,
        snippet: hit.snippet || quote,
        quote,
      };
      resolved.push(item);
      hits.push(item);
      continue;
    }

    const pageHit = {
      kind: "page",
      pageNumber,
      offset: 0,
      length: 0,
      snippet: quote || t("pageDescription", { page: pageNumber }),
      quote,
    };
    resolved.push(pageHit);
    hits.push(pageHit);
  }
  return { citations: resolved, hits };
}

function streamingAnswerPreview(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  const marker = raw.lastIndexOf("\n---\n");
  if (marker < 0) return raw;
  return raw.slice(0, marker);
}

/**
 * @param {{
 *   pageTexts: Array<{pageNumber: number, text?: string}>,
 *   outlineTitles?: string[],
 *   question: string,
 *   settings: object,
 *   currentPage?: number,
 *   signal?: AbortSignal,
 *   onDelta?: (preview: string, raw: string) => void,
 * }} options
 */
export async function askDocument({
  pageTexts,
  outlineTitles = [],
  question,
  settings,
  currentPage,
  signal,
  onDelta,
} = {}) {
  if (!settings?.apiKey) throw new Error(t("apiKeyRequired"));
  const trimmed = String(question || "").trim();
  if (!trimmed) throw new Error(t("askEmptyQuestion"));
  if (trimmed.length > MAX_ASK_QUESTION_CHARS) {
    throw new Error(t("askQuestionTooLong", { count: trimmed.length, max: MAX_ASK_QUESTION_CHARS }));
  }

  const pack = retrieveExcerpts(pageTexts, trimmed, outlineTitles, { currentPage });
  if (!pack.canAsk) {
    const error = new Error(t("askNoExcerpts"));
    error.code = "ask-no-excerpts";
    throw error;
  }

  const messages = buildAskMessages(trimmed, pack, settings.targetLang);
  let reasoning = "";
  const raw = await completeChat(settings, {
    messages,
    signal,
    timeoutMs: ASK_TIMEOUT_MS,
    temperature: 0.1,
    emptyMessage: t("askNoAnswer"),
    cancelledMessage: t("askCancelled"),
    timeoutMessage: t("askTimeout"),
    onDelta: (complete, extras) => {
      if (extras?.reasoning) reasoning = extras.reasoning;
      onDelta?.(streamingAnswerPreview(complete), complete, extras);
    },
  });

  const parsed = parseAskResponse(raw);
  const resolved = resolveCitations(pageTexts, parsed.citations);
  return {
    answer: parsed.answer,
    citations: resolved.citations,
    hits: resolved.hits,
    truncated: pack.truncated,
    excerptCount: pack.excerpts.length,
    intent: pack.intent,
    scope: pack.scope,
    hasPageMatches: pack.hasPageMatches,
    reasoning,
    raw,
  };
}
