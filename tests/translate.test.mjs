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
  translateWithProvider,
} from '../web/js/translate-provider.js';

test('normalizeApiBase trims trailing slashes', () => {
  assert.equal(normalizeApiBase('https://api.example.com/v1/'), 'https://api.example.com/v1');
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

test('translateWithProvider uses Latin-1 fetch headers for OpenRouter', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    for (const value of Object.values(init.headers)) {
      assert.match(String(value), /^[\x00-\xff]*$/, `header must be Latin-1: ${value}`);
    }
    assert.equal(init.headers['X-Title'], 'Fast PDF Viewer');
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'ok' } }] };
      },
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
  assert.equal(latin1HeaderValue('速览', 'Fast PDF Viewer'), 'Fast PDF Viewer');
});

test('translateWithProvider parses success response', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'openai/gpt-4o-mini');
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: '你好' } }] };
      },
    };
  };
  const out = await translateWithProvider('hello', {
    apiKey: 'secret',
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    targetLang: 'zh-CN',
  });
  assert.equal(out, '你好');
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
