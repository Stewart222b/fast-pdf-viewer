import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function createHistory() {
  const context = vm.createContext({});
  const source = await readFile(new URL('../web/js/history.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => { throw new Error('history.js has no imports'); });
  await module.evaluate();
  return new module.namespace.ViewHistory();
}

const state = page => ({ page, zoom: 'page-width', scrollTop: 0, scrollLeft: 0 });

test('consecutive search previews replace the latest stop and back returns to the origin', async () => {
  const history = await createHistory();
  history.reset(state(8));
  history.push(state(1), { group: 'search-input' });
  history.push(state(3), { group: 'search-input' });

  assert.equal(history.back().page, 8);
  assert.equal(history.canForward(), true);
  assert.equal(history.forward().page, 3);
});

test('explicit navigation ends a search preview group', async () => {
  const history = await createHistory();
  history.reset(state(8));
  history.push(state(1), { group: 'search-input' });
  history.push(state(3), { group: 'search-input' });
  history.push(state(6));

  assert.equal(history.back().page, 3);
  assert.equal(history.back().page, 8);
});

test('a first preview equal to the current state preserves the origin', async () => {
  const history = await createHistory();
  history.reset(state(8));
  history.push(state(8), { group: 'search-input' });
  history.push(state(3), { group: 'search-input' });

  assert.equal(history.back().page, 8);
});
