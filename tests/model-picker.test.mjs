import assert from 'node:assert/strict';
import test from 'node:test';
import { wireModelPicker } from '../web/js/model-picker.js';

function element() {
  const el = {
    hidden: true,
    value: 'openai/gpt-4o-mini',
    textContent: '',
    children: [],
    classList: {
      states: {},
      toggle(name, active) { this.states[name] = Boolean(active); },
      contains(name) { return Boolean(this.states[name]); },
    },
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
    append(...kids) { for (const kid of kids) this.children.push(kid); },
    dispatchEvent() {},
    blur() {},
  };
  return el;
}

function setupPicker({
  focused = false,
  model = 'openai/gpt-4o-mini',
  apiKey = 'sk-or-v1-test',
  apiBaseUrl = 'https://openrouter.ai/api/v1',
} = {}) {
  const input = element();
  input.value = model;
  const menu = element();
  const status = element();
  const created = [];
  const previous = globalThis.document;
  const previousFetch = globalThis.fetch;
  globalThis.document = {
    activeElement: focused ? input : { id: 'setting-key' },
    createElement(tag) {
      const node = element();
      node.tagName = tag;
      created.push(node);
      return node;
    },
  };
  const picker = wireModelPicker({
    input,
    menu,
    status,
    getCredentials: () => ({
      apiKey,
      apiBaseUrl,
      model: input.value,
    }),
  });
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { data: [{ id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini' }] };
    },
  });
  return {
    input,
    menu,
    status,
    picker,
    restore() {
      globalThis.document = previous;
      globalThis.fetch = previousFetch;
    },
  };
}

test('refresh does not open the model list while focus is on API Key', async () => {
  const env = setupPicker({ focused: false });
  try {
    await env.picker.refresh();
    assert.equal(env.menu.hidden, true);
  } finally {
    env.restore();
  }
});

test('focusing the model field opens the loaded list', async () => {
  const env = setupPicker({ focused: false });
  try {
    await env.picker.refresh();
    assert.equal(env.menu.hidden, true);
    globalThis.document.activeElement = env.input;
    env.input.listeners.focus();
    assert.equal(env.menu.hidden, false);
  } finally {
    env.restore();
  }
});

test('model status confirms when the selected model appears in the loaded list', async () => {
  const env = setupPicker();
  try {
    await env.picker.refresh();
    assert.equal(env.status.classList.contains('success'), true);
    assert.equal(env.status.classList.contains('error'), false);
    assert.match(env.status.textContent, /✓/);
    assert.match(env.status.textContent, /gpt-4o-mini/);
  } finally {
    env.restore();
  }
});

test('model absent from the list stays a warning and can be rechecked while typing', async () => {
  const env = setupPicker();
  try {
    await env.picker.refresh();
    env.input.value = 'custom/model-id';
    env.input.listeners.input();
    assert.equal(env.status.classList.contains('warning'), true);
    assert.equal(env.status.classList.contains('error'), false);
    assert.match(env.status.textContent, /自定义模型 ID 仍可使用/);

    env.input.value = 'openai/gpt-4o-mini';
    env.input.listeners.input();
    assert.equal(env.status.classList.contains('success'), true);
  } finally {
    env.restore();
  }
});

test('model-list request failure gets a red-cross error status', async () => {
  const env = setupPicker();
  try {
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    await env.picker.refresh();
    assert.equal(env.status.classList.contains('error'), true);
    assert.match(env.status.textContent, /✕/);
    assert.match(env.status.textContent, /network unavailable/);
  } finally {
    env.restore();
  }
});

test('empty model-list response is unconfirmed, not an API error', async () => {
  const env = setupPicker();
  try {
    globalThis.fetch = async () => ({ ok: true, async json() { return { data: [] }; } });
    await env.picker.refresh();
    assert.equal(env.status.classList.contains('warning'), true);
    assert.equal(env.status.classList.contains('error'), false);
    assert.match(env.status.textContent, /暂时无法确认/);
  } finally {
    env.restore();
  }
});

test('missing API Key or Base URL gets a red cross with the missing field named', async () => {
  for (const [credentials, missingLabel] of [
    [{ apiKey: '', apiBaseUrl: 'https://example.com/v1' }, 'API Key'],
    [{ apiKey: 'sk-test', apiBaseUrl: '' }, 'Base URL'],
  ]) {
    const env = setupPicker(credentials);
    try {
      await env.picker.refresh();
      assert.equal(env.status.classList.contains('error'), true);
      assert.match(env.status.textContent, /✕/);
      assert.match(env.status.textContent, new RegExp(missingLabel));
    } finally {
      env.restore();
    }
  }
});
