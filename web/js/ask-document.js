import { t } from "./i18n.js";
import { completeChat } from "./openai-chat.js";
import { searchDocument } from "./search.js";

export const MAX_ASK_QUESTION_CHARS = 500;
export const MAX_EXCERPT_CHARS = 12_000;
export const MAX_ASK_PAGES = 8;
export const ASK_TIMEOUT_MS = 90_000;

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
    if (!value || value.length < 2 || STOPWORDS.has(value) || seen.has(value)) return;
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

function pageBody(page) {
  return String(page?.text || "");
}

function scorePage(page, tokens, phraseHitsByPage) {
  const text = pageBody(page).toLowerCase();
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

/**
 * @param {Array<{pageNumber: number, text?: string}>} pageTexts
 * @param {string} question
 * @param {string[]} [outlineTitles]
 */
export function retrieveExcerpts(pageTexts, question, outlineTitles = []) {
  const pages = Array.isArray(pageTexts) ? pageTexts.filter(Boolean) : [];
  const tokens = askQuestionTokens(question);
  const phrase = String(question || "").replace(/\u00AD/gu, "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const phraseHitsByPage = new Map();
  if (phrase.length >= 2) {
    for (const hit of searchDocument(pages, phrase)) {
      phraseHitsByPage.set(hit.pageNumber, (phraseHitsByPage.get(hit.pageNumber) || 0) + 1);
    }
  }

  const ranked = pages
    .map((page) => ({ page, score: scorePage(page, tokens, phraseHitsByPage) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.page.pageNumber - b.page.pageNumber)
    .slice(0, MAX_ASK_PAGES);

  const outline = [...new Set(
    (Array.isArray(outlineTitles) ? outlineTitles : [])
      .map((title) => String(title || "").replace(/\s+/g, " ").trim())
      .filter(Boolean),
  )].slice(0, 80);

  const excerpts = [];
  let used = 0;
  let truncated = false;
  for (const { page, score } of ranked) {
    const body = pageBody(page).replace(/\s+/g, " ").trim();
    if (!body) continue;
    const header = `--- Page ${page.pageNumber} ---\n`;
    const budget = MAX_EXCERPT_CHARS - used - header.length;
    if (budget <= 80) {
      truncated = true;
      break;
    }
    const text = body.length > budget ? `${body.slice(0, Math.max(0, budget - 1))}…` : body;
    if (body.length > budget) truncated = true;
    excerpts.push({
      pageNumber: page.pageNumber,
      text,
      score,
    });
    used += header.length + text.length;
  }

  return {
    excerpts,
    outlineTitles: outline,
    tokens,
    truncated,
    hasPageMatches: excerpts.length > 0,
    canAsk: excerpts.length > 0 || outline.length > 0,
  };
}

/**
 * @param {string} question
 * @param {{ excerpts: Array<{pageNumber: number, text: string}>, outlineTitles: string[] }} pack
 * @param {string} targetLang
 */
export function buildAskMessages(question, pack, targetLang) {
  const language = LANG_NAME[targetLang] || targetLang || "简体中文";
  const sections = [];
  if (pack.outlineTitles?.length) {
    sections.push(`Document outline titles:\n${pack.outlineTitles.map((title) => `- ${title}`).join("\n")}`);
  }
  for (const excerpt of pack.excerpts || []) {
    sections.push(`--- Page ${excerpt.pageNumber} ---\n${excerpt.text}`);
  }
  const context = sections.join("\n\n") || "(no page text available)";
  return [
    {
      role: "system",
      content: [
        `You answer questions about one PDF using only the provided excerpts.`,
        `Reply in ${language}.`,
        "If the excerpts do not contain the answer, say so clearly and do not invent details.",
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
 *   signal?: AbortSignal,
 *   onDelta?: (preview: string, raw: string) => void,
 * }} options
 */
export async function askDocument({
  pageTexts,
  outlineTitles = [],
  question,
  settings,
  signal,
  onDelta,
} = {}) {
  if (!settings?.apiKey) throw new Error(t("apiKeyRequired"));
  const trimmed = String(question || "").trim();
  if (!trimmed) throw new Error(t("askEmptyQuestion"));
  if (trimmed.length > MAX_ASK_QUESTION_CHARS) {
    throw new Error(t("askQuestionTooLong", { count: trimmed.length, max: MAX_ASK_QUESTION_CHARS }));
  }

  const pack = retrieveExcerpts(pageTexts, trimmed, outlineTitles);
  if (!pack.canAsk) {
    const error = new Error(t("askNoExcerpts"));
    error.code = "ask-no-excerpts";
    throw error;
  }

  const messages = buildAskMessages(trimmed, pack, settings.targetLang);
  const raw = await completeChat(settings, {
    messages,
    signal,
    timeoutMs: ASK_TIMEOUT_MS,
    temperature: 0.1,
    emptyMessage: t("askNoAnswer"),
    cancelledMessage: t("askCancelled"),
    timeoutMessage: t("askTimeout"),
    onDelta: (complete) => onDelta?.(streamingAnswerPreview(complete), complete),
  });

  const parsed = parseAskResponse(raw);
  const resolved = resolveCitations(pageTexts, parsed.citations);
  return {
    answer: parsed.answer,
    citations: resolved.citations,
    hits: resolved.hits,
    truncated: pack.truncated,
    excerptCount: pack.excerpts.length,
    raw,
  };
}
