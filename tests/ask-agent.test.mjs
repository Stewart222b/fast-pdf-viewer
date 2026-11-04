import test from "node:test";
import assert from "node:assert/strict";
import { askDocument, MAX_AGENT_ROUNDS } from "../web/js/ask-document.js";
import { completeChatTurn } from "../web/js/openai-chat.js";

const settings = { apiKey: "test-key", apiBaseUrl: "https://example.com/v1", targetLang: "zh-CN" };
const pages = [{ pageNumber: 1, text: "x".repeat(25_000) }, { pageNumber: 200, text: "ARC means Anti-Reflective Coating. Inspect the coating." }];
const jsonResponse = message => ({ ok: true, headers: { get: () => "application/json" },
  json: async () => ({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }) });
const call = (name, args, id = "call-1") => ({ role: "assistant", content: null,
  reasoning_content: "Checking the source", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

test("Ask language is independent of translation language and uses UI language only as a fallback", async () => {
  const original = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    prompts.push(body.messages[0].content);
    assert.match(body.messages[1].content, /Please answer in Japanese/);
    return jsonResponse({ content: '回答' });
  };
  try {
    for (const targetLang of ['zh-CN', 'en', 'ja']) {
      await askDocument({ settings: { ...settings, targetLang, uiLanguage: 'en' },
        question: 'Please answer in Japanese: what does ARC mean?', pageTexts: [{ pageNumber: 1, text: 'ARC means Anti-Reflective Coating.' }] });
    }
    assert.equal(new Set(prompts).size, 1, 'translation preferences cannot override Ask language');
    assert.match(prompts[0], /explicitly requests a response language/);
    assert.match(prompts[0], /Only when.*ambiguous.*interface language English/);
    assert.doesNotMatch(prompts[0], /Reply in 简体中文/);
  } finally { globalThis.fetch = original; }
});

test("short PDF sends every page, even beyond the old eight-page cap", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools, undefined);
    assert.match(body.messages[1].content, /last-page-proof/);
    assert.match(body.messages[0].content, /complete indexed document/);
    return jsonResponse({ content: 'Found it.\n---\np20: "last-page-proof"' });
  };
  try {
    const result = await askDocument({ settings, question: "总结一下", pageTexts: Array.from({ length: 20 }, (_, i) => ({ pageNumber: i + 1, text: i === 19 ? "last-page-proof" : "page body" })) });
    assert.equal(result.mode, "full");
    assert.equal(result.readPages.length, 20);
    assert.equal(result.citations[0].pageNumber, 20);
  } finally { globalThis.fetch = original; }
});

test("agent searches, reads far pages and preserves tool IDs and reasoning across rounds", async () => {
  const original = globalThis.fetch;
  const requests = [], progress = [], reasoning = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requests.length === 1) return jsonResponse(call("search_document", { query: "ARC" }));
    if (requests.length === 2) {
      assert.equal(body.messages.at(-1).tool_call_id, "call-1");
      assert.match(body.messages.at(-1).content, /Anti-Reflective/);
      assert.equal(body.messages.at(-2).reasoning_content, "Checking the source");
      return jsonResponse(call("read_pages", { startPage: 200, endPage: 200 }, "call-2"));
    }
    assert.equal(body.messages.at(-1).tool_call_id, "call-2");
    return jsonResponse({ content: 'ARC is here.\n---\np200: "ARC means Anti-Reflective Coating."\np999: "invented"' });
  };
  try {
    const result = await askDocument({ settings, question: "涂层出问题了怎么办", pageTexts: pages, pageCount: 200,
      onProgress: e => progress.push(e), onDelta: (_preview, _raw, extras) => reasoning.push(extras.reasoning) });
    assert.equal(requests.length, 3);
    assert.equal(result.toolCallsUsed, 2);
    assert.equal(progress.some(e => e.type === "search" && e.total === 1), true);
    assert.equal(progress.some(e => e.type === "read" && e.start === 200), true);
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].pageNumber, 200);
    assert.match(result.reasoning, /Checking the source\n\nChecking the source/);
  } finally { globalThis.fetch = original; }
});

test("tool-unsupported endpoint continues using a bounded text tool protocol", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(init.body);
    if (requests === 1) return { ok: false, status: 400, json: async () => ({ error: { message: "tools unsupported" } }) };
    assert.equal(body.tools, undefined);
    if (requests === 2) return jsonResponse({ content: JSON.stringify({ tool: "search_document", arguments: { query: "ARC" } }) });
    assert.match(body.messages.at(-1).content, /Anti-Reflective/);
    return jsonResponse({ content: "ARC is on p200." });
  };
  try {
    const result = await askDocument({ settings, question: "ARC", pageTexts: pages });
    assert.equal(requests, 3);
    assert.equal(result.searches[0].query, "ARC");
  } finally { globalThis.fetch = original; }
});

test("reading rounds stop at the budget and force an evidence-limited final answer", async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (_url, init) => {
    count++;
    const body = JSON.parse(init.body);
    return body.tools ? jsonResponse(call("search_document", { query: "missing" }, `call-${count}`))
      : jsonResponse({ content: "My searches have not found evidence; coverage is incomplete." });
  };
  try {
    const result = await askDocument({ settings, question: "missing", pageTexts: pages });
    assert.equal(count, MAX_AGENT_ROUNDS + 1);
    assert.equal(result.budgetReached, true);
  } finally { globalThis.fetch = original; }
});

test("cancelling after a tool result prevents the next API request", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let count = 0;
  globalThis.fetch = async () => { count++; return jsonResponse(call("search_document", { query: "ARC" })); };
  try {
    await assert.rejects(askDocument({ settings, question: "ARC", pageTexts: pages, signal: controller.signal,
      onProgress: event => { if (event.type === "search") controller.abort(); } }), { name: "AbortError" });
    assert.equal(count, 1);
  } finally { globalThis.fetch = original; }
});

test("SSE assembles fragmented tool calls and reasoning without leaking them into answer text", async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => "text/event-stream" }, body: new ReadableStream({ start(controller) {
    for (const delta of [
      { reasoning_content: "Find ARC" },
      { tool_calls: [{ index: 0, id: "call_1", function: { name: "search_document", arguments: '{"query":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"ARC"}' } }] },
    ]) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'));
    controller.close();
  } }) });
  try {
    const result = await completeChatTurn(settings, { messages: [{ role: "user", content: "ARC" }] });
    assert.equal(result.content, "");
    assert.equal(result.message.reasoning_content, "Find ARC");
    assert.equal(result.toolCalls[0].function.arguments, '{"query":"ARC"}');
    assert.equal(result.toolCalls[0].id, "call_1");
  } finally { globalThis.fetch = original; }
});
