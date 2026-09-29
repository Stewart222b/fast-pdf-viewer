import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedModelEndpoint, modelEndpointHost, wireModelPicker } from '../web/js/model-picker.js';

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
    attributes: {},
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    focus() {
      this.focusCalls = (this.focusCalls || 0) + 1;
      if (globalThis.document) globalThis.document.activeElement = this;
      this.listeners.focus?.();
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
    append(...kids) { for (const kid of kids) this.children.push(kid); },
    dispatchEvent() {},
    blur() { if (globalThis.document?.activeElement === this) globalThis.document.activeElement = null; },
    scrollIntoView() {},
  };
  return el;
}

function optionModelId(option) {
  return option.children.find((child) => child?.className === 'model-id')?.textContent ?? option.textContent;
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
  const credentials = { apiKey, apiBaseUrl };
  let fetchCalls = 0;
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
      ...credentials,
      model: input.value,
    }),
  });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      async json() {
        return { data: [
          { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini' },
          { id: 'openai/gpt-4.1-mini', name: 'OpenAI: GPT-4.1-mini' },
        ] };
      },
    };
  };
  return {
    input,
    menu,
    status,
    picker,
    credentials,
    get fetchCalls() { return fetchCalls; },
    set fetchCalls(value) { fetchCalls = value; },
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

test('focus and typing do not send credentials; refresh starts the request explicitly', async () => {
  const env = setupPicker({ focused: false });
  try {
    globalThis.document.activeElement = env.input;
    env.input.listeners.focus();
    env.input.listeners.input();
    assert.equal(env.fetchCalls, 0);

    await env.picker.refresh();
    assert.equal(env.fetchCalls, 1);
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

test('explicit model check focuses an empty model field and shows all choices without selecting one', async () => {
  const env = setupPicker({ focused: false, model: '' });
  try {
    await env.picker.refresh({ focusInput: true });
    assert.equal(globalThis.document.activeElement, env.input);
    assert.equal(env.input.focusCalls, 1);
    assert.equal(env.input.value, '');
    assert.equal(env.menu.hidden, false);
    assert.equal(env.menu.children.length, 2);
    assert.equal(env.menu.children.every((option) => option.attributes['aria-selected'] === 'false'), true);
    assert.equal(env.status.classList.contains('warning'), false);
    assert.equal(env.status.classList.contains('error'), false);
    assert.match(env.status.textContent, /找到 2 个模型；请选择或输入模型 ID/);
  } finally {
    env.restore();
  }
});

test('explicit model check shows all choices for a stable configured model query', async () => {
  const env = setupPicker({ focused: false, model: 'openai/gpt-4o-mini' });
  try {
    await env.picker.refresh({ focusInput: true });
    assert.equal(env.input.value, 'openai/gpt-4o-mini');
    assert.equal(env.menu.children.length, 2);
    assert.equal(env.menu.children.filter((option) => option.attributes['aria-selected'] === 'true').length, 1);
  } finally {
    env.restore();
  }
});

test('checking an obsolete model shows all choices and Enter selects the displayed option', async () => {
  const env = setupPicker({ focused: false, model: 'legacy/retired-model' });
  try {
    await env.picker.refresh({ focusInput: true });
    assert.equal(env.input.value, 'legacy/retired-model');
    assert.equal(env.menu.children.length, 2);
    assert.equal(env.menu.children.every((option) => option.attributes['aria-selected'] === 'false'), true);
    const expectedModel = optionModelId(env.menu.children[1]);

    env.input.listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
    env.input.listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
    env.input.listeners.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(env.input.value, expectedModel);
  } finally {
    env.restore();
  }
});

test('a query typed during model loading filters the returned choices', async () => {
  const env = setupPicker({ focused: false, model: 'legacy/retired-model' });
  const previousFetch = globalThis.fetch;
  let resolveResponse;
  try {
    globalThis.fetch = () => new Promise((resolve) => { resolveResponse = resolve; });
    const pending = env.picker.refresh({ focusInput: true });
    env.input.value = 'gpt-4.1';
    env.input.listeners.input();
    resolveResponse({
      ok: true,
      async json() {
        return { data: [
          { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini' },
          { id: 'openai/gpt-4.1-mini', name: 'OpenAI: GPT-4.1-mini' },
        ] };
      },
    });
    await pending;

    assert.equal(env.input.value, 'gpt-4.1');
    assert.equal(env.menu.children.length, 1);
    assert.match(optionModelId(env.menu.children[0]), /gpt-4\.1/);
  } finally {
    globalThis.fetch = previousFetch;
    env.restore();
  }
});

test('moving focus away during an explicit model check does not reopen the menu or steal focus', async () => {
  const env = setupPicker({ focused: false, model: '' });
  const previousFetch = globalThis.fetch;
  let resolveResponse;
  try {
    globalThis.fetch = () => new Promise((resolve) => { resolveResponse = resolve; });
    const pending = env.picker.refresh({ focusInput: true });
    assert.equal(globalThis.document.activeElement, env.input);

    const otherField = { id: 'setting-key' };
    globalThis.document.activeElement = otherField;
    env.input.listeners.blur();
    resolveResponse({
      ok: true,
      async json() {
        return { data: [
          { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini' },
          { id: 'openai/gpt-4.1-mini', name: 'OpenAI: GPT-4.1-mini' },
        ] };
      },
    });
    await pending;

    assert.equal(globalThis.document.activeElement, otherField);
    assert.equal(env.input.focusCalls, 1);
    assert.equal(env.menu.hidden, true);

    globalThis.document.activeElement = env.input;
    env.input.listeners.focus();
    assert.equal(env.menu.hidden, false, 'returning to the model field opens the loaded choices');
    assert.equal(env.menu.children.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    env.restore();
  }
});

test('model picker supports combobox arrow, enter, and escape keys', async () => {
  const env = setupPicker({ focused: false, model: '' });
  try {
    await env.picker.refresh();
    globalThis.document.activeElement = env.input;
    env.input.listeners.focus();
    assert.equal(env.menu.hidden, false);
    assert.equal(env.input.attributes['aria-expanded'], 'true');

    let prevented = false;
    env.input.listeners.keydown({ key: 'ArrowDown', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(env.input.attributes['aria-activedescendant'], 'setting-model-option-0');

    env.input.listeners.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
    assert.equal(env.input.value, 'openai/gpt-4.1-mini');
    assert.equal(globalThis.document.activeElement, env.input);
    assert.equal(env.menu.hidden, true);
    assert.equal(env.input.attributes['aria-expanded'], 'false');

    globalThis.document.activeElement = env.input;
    env.input.listeners.focus();
    env.input.listeners.keydown({ key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(env.menu.hidden, true);
  } finally {
    env.restore();
  }
});

test('clicking any model option selects it without moving focus out of the combobox', async () => {
  const env = setupPicker({ focused: false, model: '' });
  try {
    await env.picker.refresh();
    globalThis.document.activeElement = env.input;
    env.input.listeners.focus();
    const option = env.menu.children[0];
    let prevented = false;
    option.listeners.mousedown({ preventDefault() { prevented = true; } });
    option.listeners.click();
    assert.equal(prevented, true);
    assert.equal(env.input.value, 'openai/gpt-4.1-mini');
    assert.equal(env.menu.hidden, true);
    assert.equal(env.input.attributes['aria-expanded'], 'false');
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

test('missing API Key or Base URL gets a neutral status with the missing field named', async () => {
  for (const [credentials, missingLabel] of [
    [{ apiKey: '', apiBaseUrl: 'https://example.com/v1' }, 'API Key'],
    [{ apiKey: 'sk-test', apiBaseUrl: '' }, 'Base URL'],
  ]) {
    const env = setupPicker(credentials);
    try {
      await env.picker.refresh();
      assert.equal(env.status.classList.contains('error'), false);
      assert.equal(env.status.classList.contains('warning'), false);
      assert.match(env.status.textContent, new RegExp(missingLabel));
    } finally {
      env.restore();
    }
  }
});

test('remote model-list endpoints require HTTPS while localhost can use HTTP', async () => {
  assert.equal(isAllowedModelEndpoint('https://api.example.com/v1'), true);
  assert.equal(isAllowedModelEndpoint('http://localhost:8080/v1'), true);
  assert.equal(isAllowedModelEndpoint('http://127.0.0.1:8080/v1'), true);
  assert.equal(isAllowedModelEndpoint('http://api.example.com/v1'), false);
  assert.equal(isAllowedModelEndpoint('https://user:pass@api.example.com/v1'), false);
  assert.equal(modelEndpointHost('https://api.example.com:8443/v1'), 'api.example.com');

  const env = setupPicker({ apiBaseUrl: 'http://api.example.com/v1' });
  try {
    await env.picker.refresh();
    assert.equal(env.fetchCalls, 0);
    assert.equal(env.status.classList.contains('warning'), true);
    assert.match(env.status.textContent, /HTTPS/);
  } finally {
    env.restore();
  }
});

test('invalidating settings aborts the request and leaves the changed status', async () => {
  const env = setupPicker();
  const previousFetch = globalThis.fetch;
  let requestSignal;
  try {
    globalThis.fetch = (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    };
    const pending = env.picker.refresh();
    env.picker.invalidatePending();
    assert.equal(requestSignal.aborted, true);
    await pending;
    assert.equal(env.status.classList.contains('error'), false);
    assert.match(env.status.textContent, /配置已更改/);
  } finally {
    globalThis.fetch = previousFetch;
    env.restore();
  }
});

test('model-list requests time out and report a localized failure', async () => {
  const env = setupPicker();
  const previousTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimer = 1;
  try {
    globalThis.setTimeout = (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    };
    globalThis.clearTimeout = (id) => timers.delete(id);
    globalThis.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const pending = env.picker.refresh();
    const [timerId, timer] = [...timers.entries()][0];
    assert.equal(timer.delay, 15000);
    timers.delete(timerId);
    timer.callback();
    await pending;
    assert.equal(env.status.classList.contains('error'), true);
    assert.match(env.status.textContent, /请求超时/);
    assert.equal(timers.has(timerId), false);
  } finally {
    globalThis.setTimeout = previousTimeout;
    globalThis.clearTimeout = previousClearTimeout;
    env.restore();
  }
});
