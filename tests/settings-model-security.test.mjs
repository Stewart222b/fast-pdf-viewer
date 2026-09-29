import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const savedSettings = {
  apiKey: 'saved-key',
  apiBaseUrl: 'https://old.example/v1',
  model: 'vendor/model-a',
  targetLang: 'zh-CN',
  uiLanguage: 'zh-CN',
  autoTranslateOnSelect: false,
};

async function createSettingsDialog() {
  const source = await readFile(new URL('../web/js/main.js', import.meta.url), 'utf8');
  const start = source.indexOf('const modelPicker = wireModelPicker({');
  const end = source.indexOf('$("btn-settings-save").addEventListener("click"', start);
  assert.ok(start >= 0 && end > start, 'settings event block markers should exist in main.js');

  const elements = new Map();
  const timers = new Map();
  const timerCallbacks = new Map();
  const pendingRequests = [];
  const refreshes = [];
  const refreshOptions = [];
  const sentRequests = [];
  let invalidations = 0;
  let timerId = 0;
  const document = {
    activeElement: null,
    getElementById(id) { return get(id); },
  };
  function element(id = '') {
    return {
      id,
      value: '',
      textContent: '',
      hidden: false,
      checked: false,
      disabled: false,
      attrs: {},
      listeners: {},
      addEventListener(name, listener) { this.listeners[name] = listener; },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
      getAttribute(name) { return this.attrs[name] ?? null; },
      focus() { document.activeElement = this; },
      querySelector() { return get('settings-modal-card'); },
      querySelectorAll() { return []; },
    };
  }
  function get(id) {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  }
  const setTimer = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    timerCallbacks.set(id, callback);
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const wireModelPicker = ({ getCredentials }) => ({
    refresh(options) {
      refreshOptions.push(options);
      const credentials = getCredentials();
      refreshes.push(credentials);
      if (!credentials.apiKey) return;
      const controller = new AbortController();
      const id = setTimer(() => {
        if (!controller.signal.aborted) sentRequests.push(credentials);
      }, 15000);
      pendingRequests.push({ controller, id });
    },
    invalidatePending() {
      invalidations += 1;
      for (const request of pendingRequests.splice(0)) {
        clearTimer(request.id);
        request.controller.abort();
      }
    },
    showPrompt() { this.invalidatePending(); },
    hideMenu() {},
  });

  const context = vm.createContext({
    URL,
    AbortController,
    document,
    $: get,
    loadSettings: () => ({ ...savedSettings }),
    wireModelPicker,
    clearReadingPositions() {},
    positionSaveTimer: 0,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    t(key, values = {}) {
      if (key === 'apiHost') return `Host: ${values.host}`;
      if (key === 'apiHostInvalid') return 'Invalid host';
      if (key === 'missingCredentials') return `Enter ${values.fields}`;
      if (key === 'configChanged') return 'Configuration changed';
      return key;
    },
  });
  vm.runInContext(source.slice(start, end), context, { filename: 'main.js settings block' });
  return {
    get,
    document,
    timers,
    timerCallbacks,
    refreshes,
    refreshOptions,
    sentRequests,
    get invalidations() { return invalidations; },
  };
}

test('settings require an explicit model check and clear the old key after endpoint edits', async () => {
  const app = await createSettingsDialog();
  app.get('btn-settings').listeners.click();
  assert.equal(app.get('setting-base').value, 'https://old.example/v1');
  assert.equal(app.get('setting-key').value, 'saved-key');
  assert.match(app.get('setting-base-host').textContent, /old\.example/);
  assert.equal(app.refreshes.length, 0, 'opening settings must not send the saved key');

  app.get('btn-check-models').listeners.click();
  assert.equal(app.refreshes.length, 1, 'the explicit check button starts model loading');
  assert.equal(app.refreshOptions[0].focusInput, true, 'the explicit check moves focus into the model field');
  assert.equal(app.refreshes[0].apiKey, 'saved-key');
  assert.equal(app.refreshes[0].apiBaseUrl, 'https://old.example/v1');
  assert.equal(app.timers.size, 1);

  app.get('setting-base').value = 'https://new.example/v1';
  app.get('setting-base').listeners.input();
  assert.equal(app.get('setting-key').value, '', 'editing the endpoint discards the old key');
  assert.equal(app.timers.size, 0, 'editing the endpoint cancels the prior request timeout');
  assert.equal(app.refreshes.length, 1, 'editing the endpoint does not start another request');
  assert.match(app.get('setting-base-host').textContent, /new\.example/);

  app.get('btn-check-models').listeners.click();
  assert.equal(app.refreshes[1].apiKey, '', 'the old key cannot be sent to the changed endpoint');
  assert.equal(app.refreshes[1].apiBaseUrl, 'https://new.example/v1');
  assert.equal(app.timers.size, 0, 'missing credentials do not start a request timer');

  app.get('setting-key').value = 'new-key';
  app.get('setting-key').listeners.input();
  app.get('btn-check-models').listeners.click();
  assert.equal(app.refreshes[2].apiKey, 'new-key');
  assert.equal(app.refreshes[2].apiBaseUrl, 'https://new.example/v1');
  assert.equal(app.timers.size, 1);

  app.get('btn-settings-cancel').listeners.click();
  assert.equal(app.timers.size, 0, 'cancel clears a pending request timer');
  for (const callback of app.timerCallbacks.values()) callback();
  assert.equal(app.sentRequests.length, 0);
  assert.ok(app.invalidations >= 3);
});

test('Escape invalidates model loading before closing the settings dialog', async () => {
  const app = await createSettingsDialog();
  app.get('btn-settings').listeners.click();
  app.get('btn-check-models').listeners.click();
  assert.equal(app.timers.size, 1);

  app.get('settings-modal').listeners.keydown({
    key: 'Escape',
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(app.get('settings-modal').hidden, true);
  assert.equal(app.timers.size, 0);
  for (const callback of app.timerCallbacks.values()) callback();
  assert.equal(app.sentRequests.length, 0);
});

test('model input uses a provider-neutral localized placeholder', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const translations = await readFile(new URL('../web/js/i18n.js', import.meta.url), 'utf8');
  assert.match(html, /id="setting-model"[^>]*placeholder="选择或输入模型 ID"[^>]*data-i18n-placeholder="modelInputPlaceholder"/);
  assert.match(translations, /modelInputPlaceholder: "选择或输入模型 ID"/);
  assert.match(translations, /modelInputPlaceholder: "Select or enter a model ID"/);
});
