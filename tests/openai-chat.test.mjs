import assert from "node:assert/strict";
import test from "node:test";
import {
  chatReasoningFields,
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

test("translateWithProvider sends OpenRouter reasoning exclude by default", async () => {
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
    assert.deepEqual(body.reasoning, { exclude: true });
    await translateWithProvider("hello", {
      apiKey: "secret",
      apiBaseUrl: "https://openrouter.ai/api/v1",
      reasoningEffort: "high",
      showThinking: true,
    });
    assert.deepEqual(body.reasoning, { effort: "high" });
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
    assert.equal(extras.at(-1), "first think more");
  } finally {
    globalThis.fetch = original;
  }
});
