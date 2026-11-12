import test from "node:test";
import assert from "node:assert/strict";
import { createAskMemory, clearAskMemory, compactAskMemory, rememberAskTurn, estimateTokens, snapshotAskMemory, restoreAskMemory } from "../web/js/ask-memory.js";
import { modelContextWindow, rememberModelContexts } from "../web/js/model-context.js";

const settings = { apiKey: "k", apiBaseUrl: "https://memory.invalid/v1", model: "test" };
const response = content => ({ ok: true, headers: { get: () => "application/json" }, json: async () => ({
  choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 },
}) });

test("history retains more than four full turns and preserves long answers", async () => {
  const memory = createAskMemory();
  for (let i = 0; i < 8; i++) rememberAskTurn(memory, `Q${i}`, "answer ".repeat(350));
  assert.equal(memory.turns.length, 8);
  assert.ok(memory.turns[0].answer.length > 2000);
  const usage = await compactAskMemory(memory, settings);
  assert.equal(usage.requests, 0);
  assert.equal(memory.turns.length, 8);
});

test("restoring a turn checkpoint removes newer summaries and invalidates pending memory writes", () => {
  const memory = createAskMemory();
  memory.fingerprint = "document|1";
  rememberAskTurn(memory, "earlier", "original answer");
  const checkpoint = snapshotAskMemory(memory);
  rememberAskTurn(memory, "later", "discarded answer");
  memory.summary = "Later summary must not survive a retry";
  const revision = memory.revision;
  restoreAskMemory(memory, checkpoint);
  assert.ok(memory.revision > revision);
  assert.equal(memory.summary, "");
  assert.equal(memory.totalTurns, 1);
  assert.deepEqual(memory.turns.map(turn => turn.question), ["earlier"]);
  rememberAskTurn(memory, "replacement", "replacement answer");
  assert.equal(checkpoint.turns.length, 1);
});

test("context metadata is scoped to endpoint and model with a conservative fallback", () => {
  rememberModelContexts(settings, [{ id: "large", context_length: 131072 }]);
  assert.equal(modelContextWindow({ ...settings, model: "large" }), 131072);
  assert.equal(modelContextWindow({ ...settings, apiBaseUrl: "https://other.invalid", model: "large" }), 32768);
});

test("compression summarizes old turns, retains recent turns and accumulates usage", async () => {
  const original = globalThis.fetch;
  const memory = createAskMemory();
  for (let i = 0; i < 10; i++) rememberAskTurn(memory, `Q${i}`, "evidence ".repeat(400));
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return response("User is investigating Alpha. Verified definition on p12. Still needs the limits.");
  };
  try {
    const usage = await compactAskMemory(memory, settings);
    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[1].content, /Q0/);
    assert.doesNotMatch(requests[0].messages[1].content, /Q9/);
    assert.equal(requests[0].max_tokens, 800);
    assert.match(memory.summary, /p12/);
    assert.equal(memory.turns[0].question, "Q5");
    assert.equal(memory.turns.at(-1).question, "Q9");
    assert.equal(memory.totalTurns, 10);
    assert.equal(usage.requests, 1);
    assert.ok(estimateTokens(JSON.stringify(memory.turns)) < 32768 * 0.35);
  } finally { globalThis.fetch = original; }
});

test("aborted compression never applies a late summary", async () => {
  const original = globalThis.fetch;
  const memory = createAskMemory();
  for (let i = 0; i < 10; i++) rememberAskTurn(memory, `Q${i}`, "evidence ".repeat(400));
  const controller = new AbortController();
  globalThis.fetch = async () => { controller.abort(); return response("late summary"); };
  try {
    await assert.rejects(compactAskMemory(memory, settings, { signal: controller.signal }));
    assert.equal(memory.summary, "");
    assert.equal(memory.turns.length, 10);
    const revision = memory.revision;
    clearAskMemory(memory);
    assert.ok(memory.revision > revision);
    assert.equal(memory.totalTurns, 0);
  } finally { globalThis.fetch = original; }
});

test("an oversized single answer is compressed in bounded chunks without discarding its tail", async () => {
  const original = globalThis.fetch;
  const memory = createAskMemory();
  rememberAskTurn(memory, "Inspect all sections", "earlier evidence ".repeat(4000) + " TAIL EVIDENCE");
  const inputs = [];
  globalThis.fetch = async (_url, init) => {
    inputs.push(JSON.parse(init.body).messages[1].content);
    return response("Earlier evidence and user goal summarized, pages to verify on demand.");
  };
  try {
    await compactAskMemory(memory, settings);
    assert.ok(inputs.length > 1);
    assert.ok(inputs.every(input => estimateTokens(input) < 32768 * 0.65));
    assert.ok(memory.turns.at(-1)?.answer.includes("TAIL EVIDENCE") || inputs.some(input => input.includes("TAIL EVIDENCE")));
    assert.equal(memory.totalTurns, 1);
  } finally { globalThis.fetch = original; }
});
