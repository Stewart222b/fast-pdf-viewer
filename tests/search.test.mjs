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
test('soft hyphens are searchable as invisible characters with raw offsets preserved', () => {
  const raw = 'co\u00ADoperate';
  const { hits } = search([item(raw)], 'cooperate');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].offset, 0);
  assert.equal(hits[0].length, raw.length);
  assert.equal(search([item(raw)], 'co\u00ADoperate').hits.length, 1);
  const wrapped = search([item('co\u00AD', 0, true), item('operate')], 'cooperate').hits[0];
  assert.equal(wrapped.offset, 0);
  assert.equal(wrapped.length, 'co\u00ADoperate'.length);
});
test('EOL hyphenation joins lowercase continuations and maps the removed hyphen', () => {
  const raw = ['inspec-', 'tion'];
  const { hits } = search([item(raw[0], 0, true), item(raw[1])], 'inspection');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].offset, 0);
  assert.equal(hits[0].length, raw.join('').length);

  const compoundItems = [item('well-', 0, true), item('known')];
  const compound = search(compoundItems, 'well-known').hits[0];
  const joinedVariant = search(compoundItems, 'wellknown').hits[0];
  assert.equal(compound.offset, 0);
  assert.equal(compound.length, 'well-known'.length);
  assert.equal(joinedVariant.offset, 0);
  assert.equal(joinedVariant.length, 'well-known'.length);

  assert.equal(search([item('well-', 0, true), item('Known')], 'wellknown').hits.length, 0);
});
test('EOL hyphen characters share the same optional dehyphenated search path', () => {
  for (const hyphen of ['-', '\u2010', '\u2011']) {
    const raw = `inter${hyphen}national`;
    const hits = search([item(`inter${hyphen}`, 0, true), item('national')], 'international').hits;
    assert.equal(hits.length, 1, JSON.stringify(hyphen));
    assert.equal(hits[0].offset, 0);
    assert.equal(hits[0].length, raw.length);
  }
});
test('canonical combining sequences search and map to the full UTF-16 source range', () => {
  const raw = '😀 cafe\u0301 foo';
  const { hits } = search([item(raw)], 'CAFÉ');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].offset, 3);
  assert.equal(hits[0].length, 5);
  assert.equal(search([item(raw)], 'foo').hits[0].offset, 9);
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

test('matchRects skips text divs that have no measurable text node', () => {
  const layer = {
    clientWidth: 100,
    clientHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    ownerDocument: {
      createRange: () => ({
        setStart(node) {
          if (!node) throw new TypeError('Range.setStart: node is null');
        },
        setEnd(node) {
          if (!node) throw new TypeError('Range.setEnd: node is null');
        },
        getClientRects: () => [{ left: 10, top: 10, width: 20, height: 10 }],
      }),
    },
  };
  const mapping = {
    entries: [{ div: { isConnected: true, firstChild: null }, start: 0, end: 5 }],
  };
  assert.deepEqual(matchRects(mapping, layer, 0, 3), []);
});
