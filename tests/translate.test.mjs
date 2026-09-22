import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TRANSLATE_CHARS,
  buildTranslationMessages,
  chatCompletionsUrl,
  fetchModelList,
  latin1HeaderValue,
  modelMatchesQuery,
  modelsUrl,
  normalizeApiBase,
  formatBubbleModelLabel,
  translateWithProvider,
  parseSseTranslationChunk,
} from '../web/js/translate-provider.js';

test('normalizeApiBase trims trailing slashes', () => {
  assert.equal(normalizeApiBase('https://api.example.com/v1/'), 'https://api.example.com/v1');
});

test('formatBubbleModelLabel reflects API endpoint not model vendor prefix', () => {
  assert.equal(
    formatBubbleModelLabel({
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      model: 'google/gemini-2.0-flash',
    }),
    'OpenRouter · google/gemini-2.0-flash',
  );
  assert.equal(
    formatBubbleModelLabel({
      apiBaseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    }),
    'OpenAI · gpt-4o-mini',
  );
  assert.equal(
    formatBubbleModelLabel({
      apiBaseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3',
    }),
    'llama3',
  );
});

test('formatBubbleModelLabel recognizes common international and Chinese API providers', () => {
  const cases = [
    ['https://api.deepseek.com/v1', 'DeepSeek'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'Gemini'],
    ['https://api.x.ai/v1', 'xAI'],
    ['https://api.us.mistral.ai/v1', 'Mistral'],
    ['https://api.groq.com/openai/v1', 'Groq'],
    ['https://api.together.ai/v1', 'Together AI'],
    ['https://api.fireworks.ai/inference/v1', 'Fireworks AI'],
    ['https://api.siliconflow.cn/v1', 'SiliconFlow'],
    ['https://open.bigmodel.cn/api/paas/v4', '智谱 AI'],
    ['https://api.z.ai/api/paas/v4', 'Z.ai'],
    ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', '阿里云百炼'],
    ['https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', '阿里云百炼'],
    ['https://api.hunyuan.cloud.tencent.com/v1', '腾讯混元'],
    ['https://tokenhub.tencentmaas.com/v1', '腾讯混元 TokenHub'],
    ['https://api.moonshot.ai/v1', 'Moonshot AI / Kimi'],
    ['https://qianfan.baidubce.com/v2', '百度千帆'],
    ['https://api.minimax.io/v1', 'MiniMax'],
    ['https://api.perplexity.ai/v1', 'Perplexity'],
    ['https://ark.cn-beijing.volces.com/api/v3', '火山引擎方舟'],
    ['https://integrate.api.nvidia.com/v1', 'NVIDIA NIM'],
    ['https://api.cerebras.ai/v1', 'Cerebras'],
  ];
  for (const [apiBaseUrl, provider] of cases) {
    assert.equal(
      formatBubbleModelLabel({ apiBaseUrl, model: 'example-model' }),
      `${provider} · example-model`,
      apiBaseUrl,
    );
  }
});

test('formatBubbleModelLabel does not mistake proxy or management hosts for providers', () => {
  for (const apiBaseUrl of [
    'https://api.deepseek.com.evil.example/v1',
    'https://my-openrouter-proxy.example/v1',
    'https://management-api.x.ai/v1',
    'https://custom.aliyuncs.com/v1',
  ]) {
    assert.equal(formatBubbleModelLabel({ apiBaseUrl, model: 'custom-model' }), 'custom-model');
  }
});

test('modelsUrl appends /models for OpenAI-compatible bases', () => {
  assert.equal(modelsUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/models');
  assert.equal(
    modelsUrl('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/models',
  );
});

test('modelMatchesQuery filters by split tokens', () => {
  const model = { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' };
  assert.equal(modelMatchesQuery(model, 'gpt 4o'), true);
  assert.equal(modelMatchesQuery(model, 'GPT5'), false);
  assert.equal(modelMatchesQuery(model, 'gpt mini'), true);
});

test('fetchModelList uses bearer auth without echoing the key', async () => {
  const originalFetch = globalThis.fetch;
  let seenAuth = '';
  globalThis.fetch = async (url, init) => {
    seenAuth = init.headers.Authorization;
    return {
      ok: true,
      json: async () => ({ data: [{ id: 'vendor/model-a', name: 'Model A' }] }),
    };
  };
  const models = await fetchModelList({
    apiKey: 'secret-key',
    apiBaseUrl: 'https://openrouter.ai/api/v1',
  });
  globalThis.fetch = originalFetch;
  assert.equal(seenAuth, 'Bearer secret-key');
  assert.deepEqual(models, [{ id: 'vendor/model-a', name: 'Model A' }]);
});

test('chatCompletionsUrl appends path when missing', () => {
  assert.equal(
    chatCompletionsUrl('https://openrouter.ai/api/v1'),
    'https://openrouter.ai/api/v1/chat/completions',
  );
  assert.equal(
    chatCompletionsUrl('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions',
  );
});

test('buildTranslationMessages uses target language label', () => {
  const messages = buildTranslationMessages('hello', 'zh-CN');
  assert.match(messages[0].content, /简体中文/);
  assert.equal(messages[1].content, 'hello');
});

test('translateWithProvider rejects empty key and long text', async () => {
  await assert.rejects(
    () => translateWithProvider('hi', { apiKey: '' }),
    /API Key/,
  );
  await assert.rejects(
    () => translateWithProvider('x'.repeat(MAX_TRANSLATE_CHARS + 1), { apiKey: 'k' }),
    /过长/,
  );
});

test('parseSseTranslationChunk extracts delta content', () => {
  const chunk =
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"好"}}]}\n';
  assert.deepEqual(parseSseTranslationChunk(chunk), ['你', '好']);
});

test('translateWithProvider uses Latin-1 fetch headers for OpenRouter', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(JSON.parse(init.body).stream, true);
    for (const value of Object.values(init.headers)) {
      assert.match(String(value), /^[\x00-\xff]*$/, `header must be Latin-1: ${value}`);
    }
    assert.equal(init.headers['X-Title'], 'Fast PDF Viewer - AI Translation');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return {
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: stream,
    };
  };
  await translateWithProvider('hello', {
    apiKey: 'secret',
    apiBaseUrl: 'https://openrouter.ai/api/v1',
  });
  globalThis.fetch = original;
});

test('latin1HeaderValue keeps ASCII and falls back for Unicode', () => {
  assert.equal(latin1HeaderValue('abc'), 'abc');
  assert.equal(latin1HeaderValue('测试', 'Fast PDF Viewer - AI Translation'), 'Fast PDF Viewer - AI Translation');
});

test('translateWithProvider streams deltas via onDelta', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'openai/gpt-4o-mini');
    assert.equal(body.stream, true);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return {
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: stream,
    };
  };
  const partials = [];
  const out = await translateWithProvider(
    'hello',
    {
      apiKey: 'secret',
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
      targetLang: 'zh-CN',
    },
    { onDelta: (text) => partials.push(text) },
  );
  assert.equal(out, '你好');
  assert.deepEqual(partials, ['你', '你好']);
  globalThis.fetch = original;
});

test('translateWithProvider parses JSON responses even when onDelta is provided', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'json result' } }] }),
    { headers: { 'content-type': 'application/json' } },
  );
  const partials = [];
  const out = await translateWithProvider('hello', { apiKey: 'k' }, {
    onDelta: (value) => partials.push(value),
  });
  globalThis.fetch = original;
  assert.equal(out, 'json result');
  assert.deepEqual(partials, ['json result']);
});

test('translateWithProvider preserves JSON errors and rejects incomplete finish reasons', async () => {
  const original = globalThis.fetch;
  const responseFor = (data) => new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
  });
  globalThis.fetch = async () => responseFor({ error: { message: 'json provider failed' } });
  await assert.rejects(
    () => translateWithProvider('hello', { apiKey: 'k' }),
    /json provider failed/,
  );
  for (const reason of ['length', 'content_filter', 'error']) {
    globalThis.fetch = async () => responseFor({
      choices: [{ message: { content: 'partial' }, finish_reason: reason }],
    });
    await assert.rejects(
      () => translateWithProvider('hello', { apiKey: 'k' }),
      /did not complete|翻译未完成/,
      reason,
    );
  }
  globalThis.fetch = original;
});

test('translateWithProvider requires a successful SSE terminator', async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  const stream = (payload) => new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: stream('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
  });
  await assert.rejects(
    () => translateWithProvider('hello', { apiKey: 'k' }),
    /did not complete|翻译未完成/,
  );
  globalThis.fetch = original;
});

test('translateWithProvider rejects stream errors after partial output', async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"error":{"message":"provider failed"}}\n\n'));
        controller.close();
      },
    }),
  });
  await assert.rejects(() => translateWithProvider('hello', { apiKey: 'k' }), /provider failed/);
  globalThis.fetch = original;
});

test('translateWithProvider rejects incomplete SSE finish reasons', async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  for (const reason of ['length', 'content_filter', 'error']) {
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"${reason}"}]}\n\n`));
          controller.close();
        },
      }),
    });
    await assert.rejects(
      () => translateWithProvider('hello', { apiKey: 'k' }),
      /did not complete|翻译未完成/,
      reason,
    );
  }
  globalThis.fetch = original;
});

test('translateWithProvider handles multiline SSE JSON across byte chunks and stop', async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  let cancelled = false;
  const payload = 'data: {\ndata: "choices":[{"delta":{"content":"ok"}}]\ndata: }\n\n'
    + 'data: {"choices":[{"finish_reason":"stop"}]}\n\n';
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: new ReadableStream({
      start(controller) {
        const bytes = encoder.encode(payload);
        controller.enqueue(bytes.slice(0, 9));
        controller.enqueue(bytes.slice(9, 23));
        controller.enqueue(bytes.slice(23));
      },
      cancel() { cancelled = true; },
    }),
  });
  assert.equal(await translateWithProvider('hello', { apiKey: 'k' }), 'ok');
  assert.equal(cancelled, true);
  globalThis.fetch = original;
});

test('translateWithProvider maps abort to cancel message', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => translateWithProvider('hi', { apiKey: 'k' }, { signal: controller.signal }),
    /取消/,
  );
  globalThis.fetch = original;
});
