import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/styles.css');

function blockForSelector(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `missing ${selector}`);
  const brace = css.indexOf('{', start);
  const end = css.indexOf('}', brace);
  return css.slice(brace + 1, end);
}

test('sidebar search row keeps input width; count wraps to its own line', async () => {
  const css = await readFile(stylesPath, 'utf8');
  const row = blockForSelector(css, '.sidebar-search {');
  const input = blockForSelector(css, '.sidebar-search input {');
  const count = blockForSelector(css, '.search-count {');

  assert.match(row, /flex-wrap:\s*wrap/);
  assert.match(input, /min-width:\s*3\.5rem/);
  assert.match(count, /flex:\s*0\s+0\s+100%/);
  assert.match(count, /text-overflow:\s*ellipsis/);
});
