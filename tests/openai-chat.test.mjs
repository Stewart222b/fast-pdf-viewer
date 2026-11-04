import assert from "node:assert/strict";
import test from "node:test";
import {
  chatReasoningFields,
  completeChatTurn,
  extractStreamDelta,
  extractStreamParts,
  normalizeReasoningEffort,
  parseSseTranslationChunk,
} from "../web/js/openai-chat.js";
import { translateWithProvider } from "../web/js/translate-provider.js";

test("normalizeReasoningEffort falls back to default", () => {
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort("MAX"), "default");
  assert.equal(normalizeReasoningEffort(""), "default");
});

test("chatReasoningFields maps OpenRouter display and effort separately", () => {
  const base = { apiBaseUrl: "https://openrouter.ai/api/v1" };
  assert.deepEqual(chatReasoningFields(base), { reasoning: { exclude: true } });
  assert.deepEqual(chatReasoningFields({ ...base, showThinking: true }), {});
  assert.deepEqual(
    chatReasoningFields({ ...base, reasoningEffort: "high", showThinking: false }),
    { reasoning: { effort: "high", exclude: true } },
  );
  assert.deepEqual(
    chatReasoningFields({ ...base, reasoningEffort: "low", showThinking: true }),
    { reasoning: { effort: "low" } },
  );
});

test("chatReasoningFields uses reasoning_effort on OpenAI", () => {
  assert.deepEqual(chatReasoningFields({
    apiBaseUrl: "https://api.openai.com/v1",
    reasoningEffort: "medium",
    showThinking: true,
  }), { reasoning_effort: "medium" });
  assert.deepEqual(chatReasoningFields({
    apiBaseUrl: "https://api.openai.com/v1",
  }), {});
});

test("extractStreamParts keeps reasoning out of content", () => {
  const parsed = {
    choices: [{
      delta: {
        reasoning_content: "step 1",
        content: "答案",
      },
    }],
  };
  assert.equal(extractStreamDelta(parsed), "答案");
  assert.deepEqual(extractStreamParts(parsed), { content: "答案", reasoning: "step 1" });
  assert.deepEqual(extractStreamParts({
    choices: [{ message: { reasoning: "hidden", content: "visible" } }],
  }), { content: "visible", reasoning: "hidden" });
  assert.deepEqual(extractStreamParts({
    choices: [{
      delta: {
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "hello" },
        ],
      },
    }],
  }), { content: "hello", reasoning: "" });
});

test("parseSseTranslationChunk ignores reasoning-only frames", () => {
  const chunk =
    'data: {"choices":[{"delta":{"reasoning":"think"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"好"}}]}\n';
  assert.deepEqual(parseSseTranslationChunk(chunk), ["你", "好"]);
});

test("translation disables OpenRouter reasoning independently of Ask settings", async () => {
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    const encoder = new TextEncoder();
    return {
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    };
  };
  try {
    await translateWithProvider("hello", {
      apiKey: "secret",
      apiBaseUrl: "https://openrouter.ai/api/v1",
    });
    assert.deepEqual(body.reasoning, { enabled: false, exclude: true });
    await translateWithProvider("hello", {
      apiKey: "secret",
      apiBaseUrl: "https://openrouter.ai/api/v1",
      reasoningEffort: "high",
      showThinking: true,
    });
    assert.deepEqual(body.reasoning, { enabled: false, exclude: true });
  } finally {
    globalThis.fetch = original;
  }
});

test("translateWithProvider does not mix reasoning into the translation", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    return {
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"first think"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好","reasoning":" more"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    };
  };
  const extras = [];
  try {
    const out = await translateWithProvider("hello", { apiKey: "k" }, {
      onDelta: (_text, extra) => extras.push(extra?.reasoning || ""),
    });
    assert.equal(out, "你好");
    assert.ok(extras.every(value => value === ""));
  } finally {
    globalThis.fetch = original;
  }
});

test("DeepSeek native/proxy translation disables thinking without changing Ask effort", () => {
  for (const apiBaseUrl of ['https://api.deepseek.com/v1', 'http://proxy.example:8080/v1']) {
    const settings = { apiBaseUrl, model: 'deepseek-flash', reasoningEffort: 'high', showThinking: true };
    assert.deepEqual(chatReasoningFields(settings, { disableReasoning: true }), { thinking: { type: 'disabled' } });
    assert.deepEqual(chatReasoningFields(settings), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    assert.equal(settings.reasoningEffort, 'high');
  }
});

test("translation and Ask send separate reasoning policies with the same saved settings", async () => {
  const original = globalThis.fetch;
  const requests = [];
  const settings = Object.freeze({ apiKey: 'key', apiBaseUrl: 'http://proxy.example/v1', model: 'deepseek-flash', reasoningEffort: 'high', showThinking: true });
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: 'result', reasoning_content: 'not for translation' }, finish_reason: 'stop' }] }) };
  };
  try {
    let translationExtras;
    await translateWithProvider('hello', settings, { onDelta: (_text, extras) => { translationExtras = extras; } });
    const ask = await completeChatTurn(settings, { messages: [{ role: 'user', content: 'Ask about the document' }] });
    assert.deepEqual(requests[0].thinking, { type: 'disabled' });
    assert.equal(requests[0].reasoning_effort, undefined);
    assert.deepEqual(requests[1].thinking, { type: 'enabled' });
    assert.equal(requests[1].reasoning_effort, 'high');
    assert.equal(translationExtras, undefined);
    assert.equal(ask.reasoning, 'not for translation');
    assert.equal(settings.reasoningEffort, 'high');
  } finally { globalThis.fetch = original; }
});

test("OpenAI translation uses none only for supported models and no parameter for non-reasoning models", () => {
  const settings = { apiBaseUrl: 'https://api.openai.com/v1', reasoningEffort: 'high', showThinking: true };
  assert.deepEqual(chatReasoningFields({ ...settings, model: 'gpt-4o-mini' }, { disableReasoning: true }), {});
  assert.deepEqual(chatReasoningFields({ ...settings, model: 'gpt-5.1' }, { disableReasoning: true }), { reasoning_effort: 'none' });
  assert.deepEqual(chatReasoningFields({ ...settings, model: 'o3' }, { disableReasoning: true }), { reasoning_effort: 'low' });
});
