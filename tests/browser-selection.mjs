// Real mouse selection checks (anchor + shift+click / reverse); no Range rewriting in app code.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = await mkdtemp(path.join(os.tmpdir(), 'fast-pdf-selection-'));
const server = spawn('python3', ['tests/browser_server.py'], { stdio: ['ignore', 'pipe', 'pipe'] });
const fixtures = JSON.parse(await new Promise((resolve, reject) => {
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(output.split('\n')[0]); });
  setTimeout(() => reject(new Error('server startup timed out')), 15000).unref();
}));

const appUrl = `http://127.0.0.1:${fixtures.port}/`;
const chrome = spawn(process.env.CHROME_PATH || '/usr/local/bin/google-chrome', [
  '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1280,900', '--window-position=0,0',
  `--app=${appUrl}`,
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' },
});

const PROBE_SCRIPT = `(() => {
  if (window.__selectionProbeInstalled) return;
  window.__selectionProbeInstalled = true;
  const snap = () => {
    const sel = window.getSelection();
    if (!sel?.rangeCount) {
      return { text: '', startOffset: 0, endOffset: 0, collapsed: true };
    }
    const r = sel.getRangeAt(0);
    return {
      text: sel.toString(),
      startOffset: r.startOffset,
      endOffset: r.endOffset,
      collapsed: r.collapsed,
    };
  };
  document.addEventListener('mouseup', () => { window.__selBeforeHandler = snap(); }, true);
  document.addEventListener('mouseup', () => { window.__selAfterHandler = snap(); }, false);
})();`;

let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const m = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) resolve(m[1]);
    });
    chrome.on('error', reject);
    setTimeout(() => reject(new Error('Chrome startup timed out')), 15000).unref();
  });
  await sleep(600);
  const host = new URL(endpoint).host;
  const pages = await (await fetch(`http://${host}/json/list`)).json();
  const pageTarget = pages.find(p => p.url.includes(String(fixtures.port))) || pages[0];
  socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
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
    while (Date.now() - start < 25000) {
      if (await evaluate(expression)) return;
      await sleep(30);
    }
    throw new Error(`Timed out: ${expression}; errors: ${errors.join('\n')}`);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SCRIPT });

  async function openPdf(pdfPath) {
    await fetch(`http://127.0.0.1:${fixtures.port}/api/open-path`, {
      method: 'POST',
      body: JSON.stringify({ path: pdfPath }),
    });
    await send('Page.reload');
    await until(`document.querySelector('.page')?.dataset.renderedZoom`);
    await evaluate(`document.getElementById('viewer-wrap').scrollTop = 0`);
    await sleep(200);
  }

  async function setZoom(mode) {
    await evaluate(`(() => {
      const select = document.getElementById('zoom-select');
      select.value = ${JSON.stringify(String(mode))};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const numeric = Number(mode);
    if (Number.isFinite(numeric)) {
      const key = (numeric / 100).toFixed(3);
      await until(`document.querySelector('.page')?.dataset.renderedZoom === ${JSON.stringify(key)}`);
    }
    await sleep(Number(mode) >= 200 ? 400 : 200);
  }

  const SHIFT = 8;

  async function clickAt(x, y, { modifiers = 0 } = {}) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers,
    });
    await sleep(40);
  }

  /** Chromium CDP drag often fails to extend PDF text selection; anchor + Shift+click is real mouse input. */
  async function mouseExtendSelect(from, to) {
    await evaluate(`(() => {
      window.getSelection().removeAllRanges();
      const bubble = document.getElementById('translate-bubble');
      if (bubble) bubble.hidden = true;
      window.__selBeforeHandler = window.__selAfterHandler = null;
    })()`);
    await clickAt(from.x, from.y);
    await clickAt(to.x, to.y, { modifiers: SHIFT });
    await sleep(80);
  }

  async function mouseReverseSelect(from, to) {
    await evaluate(`(() => {
      window.getSelection().removeAllRanges();
      const bubble = document.getElementById('translate-bubble');
      if (bubble) bubble.hidden = true;
      window.__selBeforeHandler = window.__selAfterHandler = null;
    })()`);
    await clickAt(to.x, to.y);
    await clickAt(from.x, from.y, { modifiers: SHIFT });
    await sleep(80);
  }

  async function pickSameLineRange() {
    return evaluate(`(() => {
      const page = document.querySelector('.page');
      const spans = [...(page?.querySelectorAll('.textLayer span') || [])]
        .filter(s => (s.textContent || '').trim().length > 0);
      if (!spans.length) return null;
      const boxed = spans.map(s => {
        const r = s.getBoundingClientRect();
        return { s, r, top: r.top, left: r.left, right: r.right, midY: r.top + r.height / 2 };
      }).filter(x => x.r.width > 1 && x.r.height > 1);
      boxed.sort((a, b) => a.top - b.top || a.left - b.left);
      const lineTop = boxed[0].top;
      const line = boxed.filter(x => Math.abs(x.top - lineTop) < 4);
      const left = line[0];
      const right = line[line.length - 1];
      const y = left.midY;
      const width = right.right - left.left;
      return {
        from: { x: left.left + width * 0.08, y },
        to: { x: left.left + width * 0.75, y },
      };
    })()`);
  }

  async function pickMultiLineRange() {
    return evaluate(`(() => {
      const page = document.querySelector('.page');
      const spans = [...(page?.querySelectorAll('.textLayer span') || [])]
        .filter(s => (s.textContent || '').trim().length > 0);
      if (spans.length < 2) return null;
      const keyed = spans.map(s => {
        const r = s.getBoundingClientRect();
        return { left: r.left, right: r.right, midY: r.top + r.height / 2, top: r.top };
      }).sort((a, b) => a.top - b.top || a.left - b.left);
      const start = keyed[0];
      const end = keyed.find(x => x.top - start.top > 18) || keyed[keyed.length - 1];
      return {
        from: { x: start.left + 4, y: start.midY },
        to: { x: end.right - 4, y: end.midY },
      };
    })()`);
  }

  async function pickWhitespaceRange() {
    return evaluate(`(() => {
      const page = document.querySelector('.page');
      const spans = [...(page?.querySelectorAll('.textLayer span') || [])]
        .filter(s => (s.textContent || '').trim().length > 0);
      if (spans.length < 2) return null;
      const keyed = spans.map(s => {
        const r = s.getBoundingClientRect();
        return { left: r.left, right: r.right, midY: r.top + r.height / 2, top: r.top };
      }).sort((a, b) => a.top - b.top || a.left - b.left);
      const a = keyed[0];
      const b = keyed.find(x => x.top - a.top > 18) || keyed[1];
      return {
        from: { x: a.left + 4, y: a.midY },
        to: { x: (a.right + b.left) / 2, y: (a.midY + b.midY) / 2 },
      };
    })()`);
  }

  async function assertStableAfterMouseup(label) {
    const probe = await evaluate(`(() => {
      const before = window.__selBeforeHandler;
      const after = window.__selAfterHandler;
      const live = (() => {
        const sel = window.getSelection();
        if (!sel?.rangeCount) return { text: '', startOffset: 0, endOffset: 0, collapsed: true };
        const r = sel.getRangeAt(0);
        return { text: sel.toString(), startOffset: r.startOffset, endOffset: r.endOffset, collapsed: r.collapsed };
      })();
      return { before, after, live, label: ${JSON.stringify(label)} };
    })()`);
    assert.ok(probe.before && probe.after, `${label}: missing probe snapshots`);
    assert.equal(probe.before.text, probe.after.text, `${label}: text changed on mouseup`);
    assert.equal(probe.before.startOffset, probe.after.startOffset, `${label}: startOffset changed on mouseup`);
    assert.equal(probe.before.endOffset, probe.after.endOffset, `${label}: endOffset changed on mouseup`);
    assert.equal(probe.after.text, probe.live.text, `${label}: live selection diverged`);
    return probe.live;
  }

  await evaluate(`window.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'mock translation' } }] }),
  });`);

  await openPdf(fixtures.small);
  const textLayerPe = await evaluate(`getComputedStyle(document.querySelector('.textLayer')).pointerEvents`);
  assert.equal(textLayerPe, 'auto');

  const cases = [];
  for (const zoom of ['100', '150', '200']) {
    await openPdf(fixtures.small);
    await setZoom(zoom);
    const line = await pickSameLineRange();
    assert.ok(line, `same-line anchors at ${zoom}%`);

    await mouseReverseSelect(line.from, line.to);
    const reverse = await assertStableAfterMouseup(`reverse-${zoom}`);
    assert.ok(reverse.text.trim().length >= 4, `reverse text at ${zoom}%`);

    const lineForward = await pickSameLineRange();
    assert.ok(lineForward, `same-line forward anchors at ${zoom}%`);
    await mouseExtendSelect(lineForward.from, lineForward.to);
    const forward = await assertStableAfterMouseup(`same-line-forward-${zoom}`);
    assert.ok(forward.text.trim().length >= 4, `same-line text at ${zoom}%: "${forward.text.slice(0, 20)}"`);

    const bubbleVisible = await evaluate(`!document.getElementById('translate-bubble').hidden`);
    assert.equal(bubbleVisible, true, `translate bubble at ${zoom}%`);
    cases.push({ zoom, forward: forward.text.length, reverse: reverse.text.length });
  }

  await openPdf(fixtures.multiline);
  await setZoom('150');
  const multi = await pickMultiLineRange();
  assert.ok(multi, 'multiline anchors');
  await mouseExtendSelect(multi.from, multi.to);
  const multiSel = await assertStableAfterMouseup('multiline-forward');
  assert.ok(multiSel.text.trim().length >= 4, 'multiline selection');

  const gap = await pickWhitespaceRange();
  assert.ok(gap, 'whitespace anchors');
  await mouseExtendSelect(gap.from, gap.to);
  await assertStableAfterMouseup('through-whitespace');

  console.log(JSON.stringify({ cases, errors }, null, 2));
  assert.deepEqual(errors, []);
} finally {
  socket?.close();
  chrome.kill();
  server.kill();
  await sleep(500);
  try { await rm(profile, { recursive: true, force: true }); } catch {}
}
