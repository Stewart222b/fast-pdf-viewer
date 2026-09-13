// Headless checks for text layer, search jump, outline, and internal links.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = await mkdtemp(path.join(os.tmpdir(), 'fast-pdf-interaction-'));
const server = spawn('python3', ['tests/browser_server.py'], { stdio: ['ignore', 'pipe', 'pipe'] });
const chrome = spawn(process.env.CHROME_PATH || '/usr/local/bin/google-chrome', [
  '--headless=new', '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let socket;
try {
  const firstLine = stream => new Promise((resolve, reject) => {
    let output = '';
    stream.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(output.split('\n')[0]); });
    setTimeout(() => reject(new Error('server startup timed out')), 15000).unref();
  });
  const endpoint = new Promise((resolve, reject) => {
    let output = '';
    chrome.stderr.on('data', chunk => { output += chunk; const m = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) resolve(m[1]); });
    chrome.on('error', reject);
    setTimeout(() => reject(new Error('Chrome startup timed out')), 15000).unref();
  });
  const fixtures = JSON.parse(await firstLine(server.stdout));
  const ws = await endpoint;
  const host = new URL(ws).host;
  const target = await (await fetch(`http://${host}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const waiting = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const pending = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) pending?.reject(data.error);
      else pending?.resolve(data.result);
    }
    if (data.method === 'Runtime.exceptionThrown') {
      errors.push(data.params.exceptionDetails.text + ': ' + (data.params.exceptionDetails.exception?.description || ''));
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    waiting.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const until = async expression => {
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (await evaluate(expression)) return;
      await sleep(30);
    }
    throw new Error(`Timed out: ${expression}; errors: ${errors.join('\n')}`);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await fetch(`http://127.0.0.1:${fixtures.port}/api/browser/set-opened`, {
    method: 'POST',
    body: JSON.stringify({ path: fixtures.small }),
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${fixtures.port}/` });
  await until(`document.querySelector('.page')?.dataset.renderedZoom`);

  const linkLayerPe = await evaluate(`getComputedStyle(document.querySelector('.linkLayer')).pointerEvents`);
  assert.equal(linkLayerPe, 'none');

  const textLayerPe = await evaluate(`getComputedStyle(document.querySelector('.textLayer')).pointerEvents`);
  assert.equal(textLayerPe, 'auto');

  await evaluate(`document.getElementById('search-input').value='translation';document.getElementById('search-input').dispatchEvent(new Event('input'))`);
  await until(`document.querySelectorAll('.search-hit').length > 0`);
  await sleep(300);
  assert.equal(errors.filter(e => e.includes('convertToViewportRectangle')).length, 0);

  const sidebarToggle = await evaluate(`(() => {
    const btn = document.getElementById('btn-sidebar');
    const before = document.querySelector('.workspace').classList.contains('sidebar-collapsed');
    btn.click();
    const after = document.querySelector('.workspace').classList.contains('sidebar-collapsed');
    btn.click();
    return { before, after, restored: !document.querySelector('.workspace').classList.contains('sidebar-collapsed') };
  })()`);
  assert.equal(sidebarToggle.before, false);
  assert.equal(sidebarToggle.after, true);
  assert.equal(sidebarToggle.restored, true);

  const motion = await evaluate(`(async () => {
    await new Promise(r => setTimeout(r, 220));
    const sidebar = document.getElementById('sidebar');
    const width = sidebar.getBoundingClientRect().width;
    document.getElementById('btn-sidebar').click();
    await new Promise(r => setTimeout(r, 60));
    const middle = sidebar.getBoundingClientRect().width;
    await new Promise(r => setTimeout(r, 200));
    const end = sidebar.getBoundingClientRect().width;
    document.getElementById('btn-sidebar').click();
    await new Promise(r => setTimeout(r, 220));
    return { width, middle, end };
  })()`);
  console.log('sidebar motion', motion);
  assert.ok(motion.middle > motion.width * 0.1 && motion.middle < motion.width * 0.95, 'collapse must have an intermediate width');
  assert.ok(motion.end <= 1);

  const outlineCount = await evaluate(`document.querySelectorAll('.outline-item').length`);
  if (outlineCount > 0) {
    const pageBefore = await evaluate(`Number(document.getElementById('page-input').value)`);
    await evaluate(`document.querySelector('.outline-item').click()`);
    await sleep(200);
    const pageAfter = await evaluate(`Number(document.getElementById('page-input').value)`);
    assert.notEqual(pageAfter, pageBefore);
  }

  const selection = await evaluate(`(() => {
    const span = document.querySelector('.textLayer span');
    if (!span || !span.firstChild) return { ok: false, reason: 'no-span' };
    const range = document.createRange();
    range.setStart(span.firstChild, 0);
    range.setEnd(span.firstChild, Math.min(3, span.firstChild.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { ok: sel.toString().length > 0, text: sel.toString() };
  })()`);
  assert.equal(selection.ok, true, selection.reason || selection.text);

  console.log(JSON.stringify({ linkLayerPe, textLayerPe, outlineCount, selection, errors }, null, 2));
  assert.deepEqual(errors, []);
} finally {
  socket?.close();
  chrome.kill();
  server.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true });
}
