import assert from 'node:assert/strict';
import test from 'node:test';

let moduleVersion = 0;

async function withSettingsEnvironment(language, initialValue = null) {
  const previous = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    chrome: Object.getOwnPropertyDescriptor(globalThis, 'chrome'),
  };
  const values = new Map();
  if (initialValue !== null) values.set('fast-pdf-viewer-settings', JSON.stringify(initialValue));
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:' } });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, String(value)); },
    },
  });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: undefined });
  const settings = await import(`../web/js/settings.js?case=${++moduleVersion}`);
  return {
    settings,
    values,
    restore() {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('fresh settings follow the browser language and leave automatic translation off', async () => {
  for (const [language, expected] of [['en-GB', 'en'], ['zh-TW', 'zh-CN'], ['fr-FR', 'zh-CN']]) {
    const env = await withSettingsEnvironment(language);
    try {
      const settings = env.settings.loadSettings();
      assert.equal(settings.uiLanguage, expected);
      assert.equal(settings.uiLanguageSelected, false);
      assert.equal(settings.autoTranslateOnSelect, false);
    } finally {
      env.restore();
    }
  }
});

test('explicit interface-language choice remains fixed while an automatic choice follows the browser', async () => {
  const explicit = await withSettingsEnvironment('en-US');
  try {
    await explicit.settings.saveSettings({ uiLanguage: 'zh-CN', uiLanguageSelected: true });
    globalThis.navigator.language = 'en-CA';
    assert.equal(explicit.settings.loadSettings().uiLanguage, 'zh-CN');
    assert.equal(explicit.settings.loadSettings().uiLanguageSelected, true);
  } finally {
    explicit.restore();
  }

  const automatic = await withSettingsEnvironment('en-US');
  try {
    await automatic.settings.saveSettings({ apiKey: 'test-key', uiLanguageSelected: false });
    globalThis.navigator.language = 'zh-TW';
    const settings = automatic.settings.loadSettings();
    assert.equal(settings.uiLanguage, 'zh-CN');
    assert.equal(settings.uiLanguageSelected, false);
    assert.equal(settings.autoTranslateOnSelect, false);
  } finally {
    automatic.restore();
  }
});

test('legacy saved interface-language choice is preserved', async () => {
  const env = await withSettingsEnvironment('en-US', { uiLanguage: 'zh-CN' });
  try {
    const settings = env.settings.loadSettings();
    assert.equal(settings.uiLanguage, 'zh-CN');
    assert.equal(settings.uiLanguageSelected, true);
    assert.equal(settings.autoTranslateOnSelect, false);
  } finally {
    env.restore();
  }
});
