import assert from "node:assert/strict";
import test from "node:test";
import { buildTextIndex } from "../web/js/search.js";
import {
  MAX_ASK_QUESTION_CHARS,
  MAX_EXCERPT_CHARS,
  askDocument,
  askQuestionTokens,
  buildAskMessages,
  parseAskResponse,
  resolveCitations,
  retrieveExcerpts,
} from "../web/js/ask-document.js";

function page(pageNumber, text) {
  const items = [{ str: text, transform: [10, 0, 0, 10, 0, 100], height: 10, width: text.length * 10, hasEOL: false }];
  return { pageNumber, ...buildTextIndex({ items }) };
}

test("askQuestionTokens keeps english terms and chinese bigrams", () => {
  const tokens = askQuestionTokens("冷却水规格 cooling water specification where?");
  assert.ok(tokens.includes("cooling"));
  assert.ok(tokens.includes("water"));
  assert.ok(tokens.includes("specification"));
  assert.ok(tokens.some((token) => token.includes("冷却") || token.includes("规格")));
  assert.equal(tokens.includes("where"), false);
});

test("retrieveExcerpts ranks matching pages and respects char budget", () => {
  const pages = [
    page(1, "Preface and introduction only."),
    page(2, "Cooling water specification requires 5 L/min at 25 C."),
    page(3, "Unrelated maintenance checklist."),
    page(4, "More cooling water notes and flow rate tables."),
  ];
  const pack = retrieveExcerpts(pages, "cooling water specification", ["Cooling", "Maintenance"]);
  assert.equal(pack.canAsk, true);
  assert.equal(pack.hasPageMatches, true);
  assert.ok(pack.excerpts.length >= 1);
  assert.equal(pack.excerpts[0].pageNumber, 2);
  assert.deepEqual(pack.outlineTitles, ["Cooling", "Maintenance"]);
  assert.ok(pack.excerpts.every((excerpt) => excerpt.text.length <= MAX_EXCERPT_CHARS));
});

test("retrieveExcerpts truncates oversized page text under the shared budget", () => {
  const huge = `cooling water ${"x".repeat(MAX_EXCERPT_CHARS)}`;
  const pack = retrieveExcerpts([page(1, huge)], "cooling water");
  assert.equal(pack.excerpts.length, 1);
  assert.equal(pack.truncated, true);
  assert.ok(pack.excerpts[0].text.endsWith("…"));
  assert.ok(pack.excerpts[0].text.length < MAX_EXCERPT_CHARS);
});

test("retrieveExcerpts refuses API work when nothing matches and outline is empty", () => {
  const pack = retrieveExcerpts([page(1, "alpha beta gamma")], "completely unrelated query", []);
  assert.equal(pack.hasPageMatches, false);
  assert.equal(pack.canAsk, false);
});

test("retrieveExcerpts can still ask with outline titles alone", () => {
  const pack = retrieveExcerpts([page(1, "alpha beta gamma")], "completely unrelated query", ["Safety"]);
  assert.equal(pack.hasPageMatches, false);
  assert.equal(pack.canAsk, true);
  assert.deepEqual(pack.outlineTitles, ["Safety"]);
});

test("buildAskMessages grounds the model on excerpts and target language", () => {
  const messages = buildAskMessages(
    "Where is cooling water?",
    {
      outlineTitles: ["Utilities"],
      excerpts: [{ pageNumber: 12, text: "Cooling water inlet is on the rear panel." }],
    },
    "zh-CN",
  );
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /简体中文/);
  assert.match(messages[1].content, /Page 12/);
  assert.match(messages[1].content, /Cooling water inlet/);
  assert.match(messages[1].content, /Where is cooling water\?/);
});

test("parseAskResponse splits answer body from citation lines", () => {
  const parsed = parseAskResponse([
    "冷却水入口在机柜后部。",
    "",
    "---",
    'p12: "Cooling water inlet is on the rear panel."',
    'p4: "Flow rate 5 L/min"',
  ].join("\n"));
  assert.equal(parsed.answer, "冷却水入口在机柜后部。");
  assert.equal(parsed.citations.length, 2);
  assert.equal(parsed.citations[0].pageNumber, 12);
  assert.match(parsed.citations[0].quote, /Cooling water inlet/);
});

test("parseAskResponse falls back to page mentions when citation block is missing", () => {
  const parsed = parseAskResponse("相关说明见第 47 页，也可参考 p.12。");
  assert.equal(parsed.answer.includes("第 47 页"), true);
  assert.deepEqual(
    parsed.citations.map((item) => item.pageNumber),
    [47, 12],
  );
});

test("resolveCitations maps quotes to search hits and falls back to page jumps", () => {
  const pages = [
    page(12, "Cooling water inlet is on the rear panel."),
    page(4, "Unrelated text."),
  ];
  const { citations, hits } = resolveCitations(pages, [
    { pageNumber: 12, quote: "Cooling water inlet is on the rear panel." },
    { pageNumber: 9, quote: "this quote does not exist anywhere" },
  ]);
  assert.equal(citations[0].kind, "quote");
  assert.equal(citations[0].pageNumber, 12);
  assert.ok(citations[0].length > 0);
  assert.equal(citations[1].kind, "page");
  assert.equal(citations[1].pageNumber, 9);
  assert.equal(citations[1].length, 0);
  assert.equal(hits.length, 2);
});

test("askDocument rejects empty or oversized questions before calling the API", async () => {
  await assert.rejects(
    () => askDocument({ question: "   ", settings: { apiKey: "k" }, pageTexts: [] }),
    /问题|question/i,
  );
  await assert.rejects(
    () => askDocument({
      question: "x".repeat(MAX_ASK_QUESTION_CHARS + 1),
      settings: { apiKey: "k" },
      pageTexts: [page(1, "cooling water")],
    }),
    /500|过长|long/i,
  );
});

test("askDocument skips the network when no excerpts are available", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}");
  };
  try {
    await assert.rejects(
      () => askDocument({
        question: "totally unrelated question",
        settings: { apiKey: "k", apiBaseUrl: "https://example.com/v1" },
        pageTexts: [page(1, "alpha beta gamma")],
        outlineTitles: [],
      }),
      (error) => error?.code === "ask-no-excerpts",
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("askDocument streams through completeChat and resolves citations", async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  const frames = [
    'data: {"choices":[{"delta":{"content":"答案在后部。\\n\\n---\\n"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"p12: \\"Cooling water inlet is on the rear panel.\\""},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: {
      getReader() {
        return {
          async read() {
            if (!frames.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(frames.shift()) };
          },
          cancel() { return Promise.resolve(); },
          releaseLock() {},
        };
      },
    },
  });
  const previews = [];
  try {
    const result = await askDocument({
      question: "cooling water inlet",
      settings: { apiKey: "k", apiBaseUrl: "https://example.com/v1", targetLang: "zh-CN" },
      pageTexts: [page(12, "Cooling water inlet is on the rear panel.")],
      outlineTitles: ["Utilities"],
      onDelta: (preview) => previews.push(preview),
    });
    assert.match(result.answer, /答案在后部/);
    assert.equal(result.citations[0].kind, "quote");
    assert.equal(result.citations[0].pageNumber, 12);
    assert.ok(previews.length >= 1);
  } finally {
    globalThis.fetch = original;
  }
});
