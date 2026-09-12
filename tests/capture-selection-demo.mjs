import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.argv[2];
if (!out) throw new Error('usage: node capture-selection-demo.mjs <output.png>');

const profile = await mkdtemp(path.join(os.tmpdir(), 'shot-'));
const server = spawn('python3', ['tests/browser_server.py'], { stdio: ['ignore', 'pipe', 'pipe'] });
const fixtures = JSON.parse(await new Promise((resolve, reject) => {
  let o = '';
  server.stdout.on('data', c => { o += c; if (o.includes('\n')) resolve(o.split('\n')[0]); });
  setTimeout(() => reject(new Error('timeout')), 15000);
}));
const url = `http://127.0.0.1:${fixtures.port}/`;
const chrome = spawn('/usr/local/bin/google-chrome', [
  '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1280,900', `--app=${url}`,
], { env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' } });
const ws = await new Promise((resolve, reject) => {
  let o = '';
  chrome.stderr.on('data', c => { o += c; const m = o.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('timeout')), 15000);
});
await sleep(800);
const host = new URL(ws).host;
const target = (await (await fetch(`http://${host}/json/list`)).json()).find(p => p.url.includes(String(fixtures.port)));
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => socket.addEventListener('open', r, { once: true }));
let id = 0;
const waiting = new Map();
socket.addEventListener('message', e => {
  const d = JSON.parse(e.data);
  if (d.id) { waiting.get(d.id)?.resolve(d.result); waiting.delete(d.id); }
});
const send = (m, p = {}) => new Promise((res, rej) => {
  waiting.set(++id, { resolve: res, reject: rej });
  socket.send(JSON.stringify({ id, method: m, params: p }));
});
const ev = async ex => (await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true })).result.value;
await send('Runtime.enable');
await send('Page.enable');
await fetch(`http://127.0.0.1:${fixtures.port}/api/browser/set-opened`, { method: 'POST', body: JSON.stringify({ path: fixtures.small }) });
await send('Page.reload');
for (let i = 0; i < 100; i++) {
  if (await ev(`!!document.querySelector('.page')?.dataset.renderedZoom`)) break;
  await sleep(50);
}
await ev(`window.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '演示翻译' } }] }) });`);
const line = await ev(`(() => {
  const page = document.querySelector('.page');
  const spans = [...page.querySelectorAll('.textLayer span')].filter(s => s.textContent.trim());
  const boxed = spans.map(s => {
    const r = s.getBoundingClientRect();
    return { left: r.left, right: r.right, midY: r.top + r.height / 2, top: r.top };
  }).sort((a, b) => a.top - b.top || a.left - b.left);
  const row = boxed.filter(x => Math.abs(x.top - boxed[0].top) < 4);
  const l = row[0];
  const r = row[row.length - 1];
  const w = r.right - l.left;
  return { from: { x: l.left + w * 0.1, y: l.midY }, to: { x: l.left + w * 0.7, y: l.midY } };
})()`);
const SHIFT = 8;
async function click(pt, mod = 0) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, modifiers: mod });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, modifiers: mod });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, modifiers: mod });
}
await click(line.from);
await click(line.to, SHIFT);
await sleep(400);
const shot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(out, Buffer.from(shot.data, 'base64'));
console.log(out);
chrome.kill();
server.kill();
