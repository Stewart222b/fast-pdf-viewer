import test from 'node:test';
import assert from 'node:assert/strict';

test('extension settings load and save without placing API keys in localStorage', async () => {
  const previous = { chrome: globalThis.chrome, location: globalThis.location, localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
  const values = { 'fast-pdf-viewer-settings': { apiKey: 'test-only', model: 'test-model' } };
  let listener;
  try {
    globalThis.location = { protocol: 'chrome-extension:' };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem() { throw new Error('must not read web storage'); },
      setItem() { throw new Error('must not write web storage'); },
    } });
    globalThis.chrome = { runtime: { id: 'test-extension' }, storage: {
      local: { get: async () => values, set: async (next) => Object.assign(values, next) },
      onChanged: { addListener(fn) { listener = fn; } },
    } };
    const settings = await import('../web/js/settings.js');
    await settings.initSettings();
    assert.equal(settings.loadSettings().apiKey, 'test-only');
    assert.equal(settings.loadSettings().targetLang, 'zh-CN');
    await settings.saveSettings({ model: 'updated' });
    assert.equal(values['fast-pdf-viewer-settings'].model, 'updated');
    listener({ 'fast-pdf-viewer-settings': { newValue: { model: 'other-tab' } } }, 'local');
    assert.equal(settings.loadSettings().model, 'other-tab');
    assert.equal(settings.loadSettings().apiKey, '');
  } finally {
    globalThis.chrome = previous.chrome;
    globalThis.location = previous.location;
    if (previous.localStorage) Object.defineProperty(globalThis, 'localStorage', previous.localStorage);
    else delete globalThis.localStorage;
  }
});
