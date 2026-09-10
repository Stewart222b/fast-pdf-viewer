// Real Chromium smoke/measurement runner. CHROME_PATH can override the executable.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = await mkdtemp(path.join(os.tmpdir(), 'fast-pdf-chrome-'));
const server = spawn('python3', ['tests/browser_server.py'], { stdio: ['ignore', 'pipe', 'pipe'] });
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let socket;
try {
  const firstLine = stream => new Promise((resolve, reject) => {
    let output = ''; stream.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(output.split('\n')[0]); });
    setTimeout(() => reject(new Error('server startup timed out')), 15000).unref();
  });
  const endpoint = new Promise((resolve, reject) => {
    let output = ''; chrome.stderr.on('data', chunk => { output += chunk; const m = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) resolve(m[1]); });
    chrome.on('error', reject); setTimeout(() => reject(new Error('Chrome startup timed out')), 15000).unref();
  });
  const fixtures = JSON.parse(await firstLine(server.stdout));
  const ws = await endpoint;
  const host = new URL(ws).host;
  const target = await (await fetch(`http://${host}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0; const waiting = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id) { const pending = waiting.get(data.id); waiting.delete(data.id); if (data.error) pending?.reject(data.error); else pending?.resolve(data.result); }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text + ': ' + (data.params.exceptionDetails.exception?.description || ''));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const until = async expression => {
    const start = Date.now();
    while (Date.now() - start < 20000) { if (await evaluate(expression)) return; await sleep(30); }
    throw new Error(`Timed out: ${expression}; errors: ${errors.join('\n')}`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  const results = [];
  for (const key of ['small', 'long']) {
    await fetch(`http://127.0.0.1:${fixtures.port}/api/open-path`, { method: 'POST', body: JSON.stringify({ path: fixtures[key] }) });
    await send('Page.navigate', { url: `http://127.0.0.1:${fixtures.port}/` });
    await until(`document.querySelector('.page')?.dataset.renderedZoom`);
    const firstPageMs = await evaluate('performance.now()');
    await evaluate(`document.getElementById('search-input').value='${key === 'small' ? 'translation' : 'needle'}';document.getElementById('search-input').dispatchEvent(new Event('input'));window.searchStarted=performance.now()`);
    await until(`document.querySelectorAll('.search-hit').length > 0`);
    const searchMs = await evaluate('performance.now()-window.searchStarted');
    const count = await evaluate(`Number(document.getElementById('page-count').textContent)`);
    for (let page = 1; page <= Math.min(count, 40); page++) {
      await evaluate(`document.getElementById('page-input').value='${page}';document.getElementById('page-input').dispatchEvent(new Event('change'))`);
      await until(`document.querySelector('[data-page-number="${page}"]')?.dataset.renderedZoom`);
    }
    const metrics = await evaluate(`({canvases:[...document.querySelectorAll('.page')].filter(p=>p.dataset.renderedZoom).length, canvasBytes:[...document.querySelectorAll('.page')].filter(p=>p.dataset.renderedZoom).reduce((n,p)=>{const c=p.querySelector('canvas');return n+c.width*c.height*4},0), dpr:devicePixelRatio, heapBytes:performance.memory?.usedJSHeapSize})`);
    results.push({ fixture: key, pages: count, firstPageMs: Math.round(firstPageMs), firstSearchMs: Math.round(searchMs), ...metrics });
    await evaluate(`document.getElementById('search-input').value='';document.getElementById('search-input').dispatchEvent(new Event('input'))`);
    await until(`document.querySelectorAll('.hl').length===0`);
    assert.equal(await evaluate(`document.getElementById('doc-title').textContent.includes('.pdf')`), true);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
  if (process.env.RESULT_PATH) await writeFile(process.env.RESULT_PATH, JSON.stringify(results, null, 2));
} finally {
  socket?.close(); chrome.kill(); server.kill();
  await sleep(500); await rm(profile, { recursive: true, force: true });
}
