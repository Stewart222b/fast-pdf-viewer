import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../web/js/search.js', import.meta.url), 'utf8');
const { buildTextIndex, searchDocument, matchRects, highlightSnippet } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const item = (str, x = 0, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, 100], height: 10, width: str.length * 10, hasEOL });
const viewport = { convertToViewportPoint: (x, y) => [x, y] };
function search(items, query) {
  const content = { items };
  return { content, hits: searchDocument([{ pageNumber: 1, ...buildTextIndex(content) }], query) };
}
test('English line breaks and geometric word gaps preserve raw highlight offsets', () => {
  for (const items of [[item('hello', 0, true), item('world')], [item('hello'), item('world', 60)]]) {
    const { content, hits } = search(items, 'hello world');
    assert.equal(hits.length, 1); assert.equal(hits[0].length, 10);
    assert.equal(search(items, 'world').hits[0].offset, 5);
  }
});
test('Chinese line breaks and adjacent fragments do not gain spurious spaces', () => {
  assert.equal(search([item('中文', 0, true), item('搜索')], '中文搜索').hits.length, 1);
  assert.equal(search([item('hel'), item('lo', 30)], 'hello').hits.length, 1);
});
test('collapsed whitespace, ligatures and fullwidth text map to original characters', () => {
  const { hits } = search([item('a  \t\nb ﬃ Ａ')], 'b ffi a');
  assert.equal(hits.length, 1); assert.equal(hits[0].offset, 5); assert.equal(hits[0].length, 5);
  assert.equal(search([item('ﬃ')], 'fi').hits[0].length, 1);
});
test('ligature partial queries keep non-zero raw highlight ranges', () => {
  const { content, hits: fHits } = search([item('ﬃ')], 'f');
  const fHit = fHits.find((hit) => hit.length > 0);
  assert.ok(fHit);
  assert.equal(fHit.length, 1);
  const { hits: ffHits } = search([item('ﬃ')], 'ff');
  assert.equal(ffHits[0].length, 1);
});
test('snippet highlighting does not corrupt HTML entities or inject markup', () => {
  assert.equal(highlightSnippet('x < y & z', '<'), 'x <mark>&lt;</mark> y &amp; z');
  assert.equal(highlightSnippet('<img>', 'img'), '&lt;<mark>img</mark>&gt;');
});
