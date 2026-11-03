import assert from "node:assert/strict";
import test from "node:test";
import { buildTextIndex } from "../web/js/search.js";
import {
  MAX_ASK_QUESTION_CHARS,
  MAX_ASK_PAGES,
  MAX_EXCERPT_CHARS,
  askDocument,
  askQuestionTokens,
  classifyAskIntent,
  parseChapterRef,
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

test("classifyAskIntent splits survey, locate, and greeting/anchor questions", () => {
  assert.equal(classifyAskIntent("总结一下这份文档"), "survey");
  assert.equal(classifyAskIntent("这份 PDF 讲什么"), "survey");
  assert.equal(classifyAskIntent("第五章讲的什么"), "survey");
  assert.equal(classifyAskIntent("What is this PDF about?"), "survey");
  assert.equal(classifyAskIntent("What does chapter 5 cover?"), "survey");
  assert.equal(classifyAskIntent("冷却水规格在哪"), "locate");
  assert.equal(classifyAskIntent("什么是冷却水规格"), "locate");
  assert.equal(classifyAskIntent("你好"), "anchor");
  assert.equal(classifyAskIntent("hello"), "anchor");
});

test("parseChapterRef reads Arabic and Chinese chapter numbers", () => {
  assert.deepEqual(parseChapterRef("第五章讲的什么"), { chapter: 5 });
  assert.deepEqual(parseChapterRef("第 5 章讲什么"), { chapter: 5 });
  assert.deepEqual(parseChapterRef("What does chapter 5 cover?"), { chapter: 5 });
  assert.deepEqual(parseChapterRef("ch. 12 cooling water"), { chapter: 12 });
  assert.equal(parseChapterRef("冷却水规格在哪"), null);
});

test("retrieveExcerpts ranks matching pages and respects char budget", () => {
  const pages = [
    page(1, "Preface and introduction only."),
    page(2, "Cooling water specification requires 5 L/min at 25 C."),
    page(3, "Unrelated maintenance checklist."),
    page(4, "More cooling water notes and flow rate tables."),
  ];
  const pack = retrieveExcerpts(pages, "cooling water specification", ["Cooling", "Maintenance"]);
  assert.equal(pack.intent, "locate");
  assert.equal(pack.canAsk, true);
  assert.equal(pack.hasPageMatches, true);
  assert.ok(pack.excerpts.length >= 1);
  assert.equal(pack.excerpts[0].pageNumber, 2);
  assert.equal(pack.excerpts[0].reason, "match");
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

test("retrieveExcerpts still packs sampled pages when keywords miss", () => {
  const pages = [
    page(1, "alpha beta gamma"),
    page(2, "delta epsilon"),
    page(3, "zeta eta theta"),
  ];
  const pack = retrieveExcerpts(pages, "completely unrelated query", []);
  assert.equal(pack.intent, "locate");
  assert.equal(pack.hasPageMatches, false);
  assert.equal(pack.canAsk, true);
  assert.ok(pack.excerpts.length >= 1);
  assert.equal(pack.excerpts[0].pageNumber, 1);
  assert.ok(pack.excerpts.every((excerpt) => excerpt.reason !== "match"));
});

test("retrieveExcerpts can still ask with outline titles when pages are empty", () => {
  const pack = retrieveExcerpts([], "completely unrelated query", ["Safety"]);
  assert.equal(pack.hasPageMatches, false);
  assert.equal(pack.canAsk, true);
  assert.deepEqual(pack.outlineTitles, ["Safety"]);
});

test("retrieveExcerpts surveys first, last, and interior pages", () => {
  const pages = Array.from({ length: 20 }, (_, i) => page(i + 1, `Section ${i + 1} body text`));
  const pack = retrieveExcerpts(pages, "总结一下这份文档");
  assert.equal(pack.intent, "survey");
  assert.equal(pack.canAsk, true);
  assert.ok(pack.excerpts.length <= MAX_ASK_PAGES);
  assert.equal(pack.excerpts[0].pageNumber, 1);
  assert.equal(pack.excerpts.at(-1).pageNumber, 20);
  assert.ok(pack.excerpts.some((excerpt) => excerpt.pageNumber > 1 && excerpt.pageNumber < 20));
});

test("retrieveExcerpts uses the current page as an anchor for greetings", () => {
  const pages = [
    page(1, "Cover page"),
    page(2, "Middle chapter"),
    page(3, "Current reading page about pumps"),
    page(4, "Appendix"),
  ];
  const pack = retrieveExcerpts(pages, "你好", [], { currentPage: 3 });
  assert.equal(pack.intent, "anchor");
  assert.equal(pack.canAsk, true);
  assert.ok(pack.excerpts.some((excerpt) => excerpt.pageNumber === 3));
});

function chapterManualPages() {
  const pages = [];
  for (let n = 1; n <= 40; n += 1) {
    if (n < 10) {
      pages.push(page(n, `SP7 NGS User Manual Chapter 1. Overview page ${n} intro body.`));
    } else if (n < 30) {
      const section = n < 18
        ? "Inspection Collections Pane in SP7 system"
        : n < 24
          ? "NGS Recipe Elements"
          : "SURFmonitor Recipe Elements";
      pages.push(page(
        n,
        `SP7 NGS v8.30 User Manual Chapter 5. Inspection ${section} P/N 9031027-000. Chapter 5 explains ${section} procedures, limits, and operator steps on page ${n}.`,
      ));
    } else {
      pages.push(page(n, `SP7 NGS User Manual Chapter 6. Process page ${n} appendix body.`));
    }
  }
  return pages;
}

const chapterOutline = [
  { title: "Chapter 1. Overview", pageNumber: 1, depth: 0 },
  { title: "Chapter 5. Inspection", pageNumber: 10, depth: 0 },
  { title: "Inspection Collections Pane", pageNumber: 10, depth: 1 },
  { title: "NGS Recipe Elements", pageNumber: 18, depth: 1 },
  { title: "SURFmonitor Recipe Elements", pageNumber: 24, depth: 1 },
  { title: "Chapter 6. Process", pageNumber: 30, depth: 0 },
];

test("retrieveExcerpts surveys chapter 5 from the outline instead of whole-document headers", () => {
  const pack = retrieveExcerpts(chapterManualPages(), "第五章讲的什么", chapterOutline);
  const nums = pack.excerpts.map((excerpt) => excerpt.pageNumber);
  assert.equal(pack.intent, "survey");
  assert.equal(pack.scope?.chapter, 5);
  assert.equal(pack.excerpts[0].pageNumber, 10);
  assert.ok(nums.every((n) => n >= 10 && n < 30));
  assert.ok(nums.some((n) => n > 10 && n < 30));
  assert.ok(pack.excerpts.some((excerpt) => /procedures, limits, and operator steps/.test(excerpt.text)));
  assert.ok(pack.outlineTitles.some((title) => /Inspection Collections Pane/.test(title)));
});

test("retrieveExcerpts infers a chapter range from running headers when outline has no pages", () => {
  const pack = retrieveExcerpts(chapterManualPages(), "What does chapter 5 cover?");
  const nums = pack.excerpts.map((excerpt) => excerpt.pageNumber);
  assert.equal(pack.intent, "survey");
  assert.ok(nums[0] >= 10 && nums[0] < 30);
  assert.ok(nums.every((n) => n >= 10 && n < 30));
});

test("retrieveExcerpts bounds a single chapter title by the next chapter heading", () => {
  const pages = [
    page(1, "Chapter 5. Calibration introduction."),
    page(2, "Safety checks before calibration. See Chapter 5. Confirm the pressure before starting."),
    page(3, "ZXQ-91 calibration requires 7 bar pressure."),
    page(4, "Finishing the calibration procedure."),
    page(5, "Chapter 6. Maintenance."),
  ];
  const pack = retrieveExcerpts(pages, "第五章 ZXQ-91 校准方法");
  assert.deepEqual(pack.scope, { chapter: 5, start: 1, end: 4 });
  assert.equal(pack.hasPageMatches, true);
  assert.ok(pack.excerpts.some((excerpt) => excerpt.pageNumber === 3));

  const unbounded = retrieveExcerpts(pages.slice(0, 4), "第五章 ZXQ-91 校准方法");
  assert.equal(unbounded.scope, null);
  assert.ok(unbounded.excerpts.some((excerpt) => excerpt.pageNumber === 3));
});

test("retrieveExcerpts uses the next chapter boundary after incomplete running headers", () => {
  const pages = [
    page(1, "Chapter 5. Calibration."),
    page(2, "Chapter 5. Calibration continues."),
    page(3, "ZXQ-91 calibration requires 7 bar pressure."),
    page(4, "Finish the calibration procedure."),
    page(5, "Chapter 6. Maintenance."),
  ];
  const pack = retrieveExcerpts(pages, "第五章 ZXQ-91 校准方法");
  assert.deepEqual(pack.scope, { chapter: 5, start: 1, end: 4 });
  assert.ok(pack.excerpts.some((excerpt) => excerpt.pageNumber === 3));
});

test("retrieveExcerpts does not treat a leading chapter cross-reference as a heading", () => {
  const pages = [
    page(1, "See Chapter 5. Calibration procedure details."),
    page(2, "Introductory notes."),
    page(3, "ZXQ-91 calibration requires 7 bar pressure."),
    page(4, "Chapter 6. Maintenance."),
  ];
  const pack = retrieveExcerpts(pages, "第五章 ZXQ-91 校准方法");
  assert.equal(pack.scope, null);
  assert.ok(pack.excerpts.some((excerpt) => excerpt.pageNumber === 3));
});

test("retrieveExcerpts shares the survey budget across the sampled page range", () => {
  const pages = Array.from({ length: 100 }, (_, index) =>
    page(index + 1, `Section ${index + 1}. ${"Detailed operating instructions. ".repeat(95)}`));
  const pack = retrieveExcerpts(pages, "总结一下这份文档");
  const pageNumbers = pack.excerpts.map((excerpt) => excerpt.pageNumber);
  assert.ok(pack.excerpts.length >= 7);
  assert.equal(pageNumbers[0], 1);
  assert.equal(pageNumbers.at(-1), 100);
  assert.ok(pageNumbers.some((number) => number > 1 && number < 100));
  assert.ok(pack.excerpts.reduce((total, excerpt) =>
    total + `--- Page ${excerpt.pageNumber} ---\n`.length + excerpt.text.length, 0) <= MAX_EXCERPT_CHARS);
});

test("retrieveExcerpts locates keywords inside the named chapter", () => {
  const pack = retrieveExcerpts(
    chapterManualPages(),
    "第五章 Recipe Elements",
    chapterOutline,
  );
  assert.equal(pack.scope?.chapter, 5);
  assert.equal(pack.hasPageMatches, true);
  assert.ok(pack.excerpts.some((excerpt) => excerpt.pageNumber >= 18 && excerpt.pageNumber < 30));
  assert.ok(pack.excerpts.every((excerpt) => excerpt.pageNumber >= 10 && excerpt.pageNumber < 30));
});

test("retrieveExcerpts includes neighbor pages around a keyword hit", () => {
  const pages = [
    page(1, "Preface only."),
    page(2, "Cooling water specification requires 5 L/min."),
    page(3, "Continued installation notes."),
    page(4, "Appendix."),
  ];
  const pack = retrieveExcerpts(pages, "cooling water specification");
  const nums = pack.excerpts.map((excerpt) => excerpt.pageNumber);
  assert.ok(nums.includes(2));
  assert.ok(nums.includes(1) && nums.includes(3));
  assert.ok(pack.excerpts.some((excerpt) => excerpt.reason === "neighbor"));
});

test("retrieveExcerpts packs a window around a hit instead of the whole long page", () => {
  const body = `${"aaa ".repeat(400)}cooling water specification sits here ${"zzz ".repeat(400)}`;
  const pack = retrieveExcerpts([page(1, body)], "cooling water specification");
  assert.equal(pack.excerpts.length, 1);
  assert.match(pack.excerpts[0].text, /cooling water specification/);
  assert.ok(pack.excerpts[0].text.length < body.length / 2);
  assert.equal(pack.truncated, true);
});

test("buildAskMessages grounds the model on excerpts and target language", () => {
  const messages = buildAskMessages(
    "Where is cooling water?",
    {
      intent: "locate",
      outlineTitles: ["Utilities"],
      excerpts: [{ pageNumber: 12, text: "Cooling water inlet is on the rear panel." }],
    },
    "zh-CN",
  );
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /简体中文/);
  assert.match(messages[0].content, /keyword search/);
  assert.match(
    buildAskMessages("总结一下", { intent: "survey", outlineTitles: [], excerpts: [{ pageNumber: 1, text: "Hello" }] }, "zh-CN")[0].content,
    /sample across the whole document/,
  );
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

test("askDocument skips the network when there is no searchable text", async () => {
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
        pageTexts: [],
        outlineTitles: [],
      }),
      (error) => error?.code === "ask-no-excerpts",
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("askDocument still calls the API for greetings when pages exist", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return {
      ok: true,
      headers: { get: () => "application/json" },
      async json() {
        return { choices: [{ message: { content: "你好。可以问这份 PDF 里的内容。" } }] };
      },
    };
  };
  try {
    const result = await askDocument({
      question: "你好",
      currentPage: 3,
      settings: { apiKey: "k", apiBaseUrl: "https://example.com/v1", targetLang: "zh-CN" },
      pageTexts: [page(1, "Cover"), page(3, "Current reading page about pumps")],
      outlineTitles: [],
    });
    assert.equal(called, true);
    assert.equal(result.intent, "anchor");
    assert.equal(result.hasPageMatches, false);
    assert.match(result.answer, /你好/);
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
    assert.equal(result.intent, "locate");
    assert.equal(result.hasPageMatches, true);
    assert.equal(result.citations[0].kind, "quote");
    assert.equal(result.citations[0].pageNumber, 12);
    assert.ok(previews.length >= 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("askDocument keeps reasoning off the answer and returns it separately", async () => {
  const original = globalThis.fetch;
  let body;
  const encoder = new TextEncoder();
  const frames = [
    'data: {"choices":[{"delta":{"reasoning":"plan the cite"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"答案在后部。\\n\\n---\\n"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"p12: \\"Cooling water inlet is on the rear panel.\\""},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return {
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
    };
  };
  const extras = [];
  try {
    const result = await askDocument({
      question: "cooling water inlet",
      settings: { apiKey: "k", apiBaseUrl: "https://example.com/v1", targetLang: "zh-CN" },
      pageTexts: [page(12, "Cooling water inlet is on the rear panel.")],
      outlineTitles: ["Utilities"],
      onDelta: (_preview, _raw, extra) => extras.push(extra?.reasoning || ""),
    });
    assert.deepEqual(body.reasoning, { exclude: true });
    assert.match(result.answer, /答案在后部/);
    assert.doesNotMatch(result.answer, /plan the cite/);
    assert.doesNotMatch(result.raw, /plan the cite/);
    assert.equal(result.reasoning, "plan the cite");
    assert.equal(extras.at(-1), "plan the cite");
  } finally {
    globalThis.fetch = original;
  }
});
