import assert from 'node:assert/strict';
import test from 'node:test';
import { wireModelPicker } from '../web/js/model-picker.js';

function element() {
  const el = {
    hidden: true,
    value: 'openai/gpt-4o-mini',
    textContent: '',
    children: [],
    classList: { toggle() {} },
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

function setupPicker({ focused = false } = {}) {
  const input = element();
  const menu = element();
  const status = element();
  const created = [];
  const previous = globalThis.document;
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
      apiKey: 'sk-or-v1-test',
      apiBaseUrl: 'https://openrouter.ai/api/v1',
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
    picker,
    restore() {
      globalThis.document = previous;
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
