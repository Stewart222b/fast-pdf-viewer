// Real held-button drags through text and whitespace; never Shift+click.
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
const chrome = spawn(process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/local/bin/google-chrome'), [
  '--headless=new', '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1800,1000', '--window-position=0,0',
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
      await until(`document.querySelector('.page:nth-child(2)')?.dataset.renderedZoom === ${JSON.stringify(key)}`);
    }
    await sleep(Number(mode) >= 200 ? 400 : 200);
  }

  async function drag(points) {
    // Clear only test setup state; all selection under test comes from the drag.
    await evaluate(`getSelection().empty(); document.getElementById('translate-bubble').hidden = true`);
    const first = points[0];
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...first, button: 'left', buttons: 1, clickCount: 1 });
    const samples = [];
    for (let p = 1; p < points.length; p++) {
      const a = points[p - 1], b = points[p];
      for (let i = 1; i <= 8; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x-a.x)*i/8,
          y: a.y + (b.y-a.y)*i/8, button: 'left', buttons: 1 });
        await sleep(25);
        const selection = await evaluate(`(() => {const s=getSelection();return {text:s.toString(),anchor:(s.anchorNode?.nodeType === 3 ? s.anchorNode.parentElement : s.anchorNode)?.closest?.('.page')?.dataset.pageNumber,focus:(s.focusNode?.nodeType === 3 ? s.focusNode.parentElement : s.focusNode)?.closest?.('.page')?.dataset.pageNumber};})()`);
        assert.equal(selection.anchor, '2', 'anchor left expected page');
        assert.equal(selection.focus, '2', `focus left expected page: ${JSON.stringify(selection)} ${JSON.stringify(points)}`);
        samples.push(selection.text);
      }
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...points.at(-1), button: 'left', buttons: 0, clickCount: 1 });
    await sleep(80);
    assert.equal(await evaluate(`getSelection().toString()`), samples.at(-1), 'release changed selection');
    for (const text of samples) {
      assert.ok(text.length < 240, `drag escaped adjacent rows: ${text}`);
      assert.ok('SectionGdetailsSectionHdetailsSectionIdetails'.includes(text.replace(/[\d.\s]/g, '')), `unexpected row: ${text}`);
    }
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

  const cases = [];
  for (const zoom of ['100', '150', '200']) {
    await openPdf(fixtures.multiline);
    await setZoom(zoom);
    await evaluate(`(() => {
      const layer = document.querySelector('.page:nth-child(2) .textLayer');
      // Leave a narrow strip of actual page canvas outside the text layer.
      layer.style.width = (layer.parentElement.clientWidth - 16) + 'px';
      const spans = [...layer.querySelectorAll('span')];
      const box = text => spans.find(s => s.textContent === text).getBoundingClientRect();
      const a = box('Section G details'), b = box('Section H details');
      document.getElementById('viewer-wrap').scrollTop += a.top - 240;
      return true;
    })()`);
    const points = await evaluate(`(() => {
      const layer = document.querySelector('.page:nth-child(2) .textLayer');
      const spans = [...layer.querySelectorAll('span')];
      const box = text => spans.find(s => s.textContent === text).getBoundingClientRect();
      const a = box('Section G details'), b = box('Section H details');
      const page = layer.parentElement.getBoundingClientRect();
      return [{x:a.left+8,y:a.top+a.height/2},
        {x:b.right-4,y:(a.bottom+b.top)/2}, {x:b.left+60,y:b.top+b.height/2},
        {x:page.left+440*${Number(zoom)/100},y:b.top+b.height/2},
        {x:page.right-8,y:b.top+b.height/2}];
    })()`);
    assert.equal(await evaluate(`!!document.querySelector('.page:nth-child(2) .textLayer .endOfContent')`), true);
    assert.equal(await evaluate(`document.elementFromPoint(${points[4].x},${points[4].y}).closest('.textLayer') === null`), true, 'path exits text layer into page canvas');
    for (const stop of [2, 3, 4]) {
      await drag(points.slice(0, stop));
      const selected = await assertStableAfterMouseup(`toc-${zoom}-stop-${stop}`);
      assert.ok(selected.text.length < 240 && (stop === 2 || selected.text.length >= 4), `zoom=${zoom} stop=${stop} text=${JSON.stringify(selected.text)}`);
    }
    for (const reverse of [false, true]) {
      // Reverse starts in text on H, traverses page blank and line gap, then G.
      const route = reverse ? [points[2], points[4], points[3], points[2], points[1], points[0]] : points;
      await drag(route);
      const selected = await assertStableAfterMouseup(`toc-${zoom}-${reverse}`);
      assert.ok(selected.text.length >= 4 && selected.text.length < 240, selected.text);
      assert.equal(await evaluate(`!document.getElementById('translate-bubble').hidden`), true);
      const direction = await evaluate(`(() => {const s=getSelection(); const r=document.createRange();
        r.setStart(s.anchorNode,s.anchorOffset);r.setEnd(s.focusNode,s.focusOffset);return r.collapsed;})()`);
      assert.equal(direction, reverse, 'anchor/focus direction');
      cases.push({zoom, reverse, length:selected.text.length});
    }
    await evaluate(`(() => { const q=document.getElementById('search-input'); q.value='surf'; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await until(`document.querySelector('.hl')`);
    await sleep(500);
    for (const repaintZoom of [zoom === '100' ? '150' : '100', zoom]) {
      await setZoom(repaintZoom);
      await until(`document.querySelector('.hl')`);
      const geometry = await evaluate(`(() => {
        const expected=[...document.querySelectorAll('.textLayer span')].filter(s=>s.textContent.includes('SurfRDS')).flatMap(span=>{
          const r=document.createRange(), start=span.textContent.indexOf('Surf');
          r.setStart(span.firstChild,start);r.setEnd(span.firstChild,start+4);
          return [...r.getClientRects()].map(r=>({x:r.x,y:r.y,width:r.width,height:r.height}));
        });
        const actual=[...document.querySelectorAll('.hl')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
        return {expected,actual};
      })()`);
      assert.equal(geometry.actual.length, geometry.expected.length);
      for (const expected of geometry.expected) {
        assert.ok(geometry.actual.some(actual=>['x','y','width','height'].every(k=>Math.abs(actual[k]-expected[k])<=1.5)), JSON.stringify(geometry));
      }
    }
    // Exercise NFKC, UTF-16, cross-div matching and merging against native DOM
    // geometry, including a sentinel between the text nodes.
    const mapped = await evaluate(`(async () => {
      const {buildTextIndex,buildTextMapping,searchDocument,matchRects}=await import('./js/search.js');
      const host=document.createElement('div');
      host.style.cssText='position:absolute;left:20px;top:100px;font:24px Arial';
      document.body.append(host);
      const strings=['😀 Ａ ﬃ Sur','fRDS'];
      const divs=strings.map(str=>{const span=document.createElement('span');span.textContent=str;host.append(span);return span;});
      const sentinel=document.createElement('div');sentinel.style.cssText='position:absolute;width:600px;height:800px';
      divs[0].after(sentinel);
      const mapping=buildTextMapping(divs,strings);
      const index=buildTextIndex({items:strings.map(str=>({str}))});
      const results=[];
      for(const query of ['a','fi','surf']) {
        const hit=searchDocument([{pageNumber:1,...index}],query)[0];
        const actual=matchRects(mapping,host,hit.offset,hit.length);
        const expected=[];let offset=0;const origin=host.getBoundingClientRect();
        for(const span of divs) {
          const end=offset+span.textContent.length;
          if(end>hit.offset && offset<hit.offset+hit.length) {
            const r=document.createRange();r.setStart(span.firstChild,Math.max(0,hit.offset-offset));
            r.setEnd(span.firstChild,Math.min(end,hit.offset+hit.length)-offset);
            for(const b of r.getClientRects())expected.push({left:b.left-origin.left,top:b.top-origin.top,width:b.width,height:b.height});
          }offset=end;
        }
        const left=Math.min(...expected.map(r=>r.left)), right=Math.max(...expected.map(r=>r.left+r.width));
        results.push({actual,expected:{left,top:expected[0].top,width:right-left,height:expected[0].height}});
      }
      host.remove();return results;
    })()`);
    for (const {actual,expected} of mapped) {
      assert.equal(actual.length,1);
      for(const key of ['left','top','width','height']) assert.ok(Math.abs(actual[0][key]-expected[key])<=1.5);
    }

  }

  console.log(JSON.stringify({ cases, errors }, null, 2));
  assert.deepEqual(errors, []);
} finally {
  socket?.close();
  chrome.kill();
  server.kill();
  await sleep(500);
  try { await rm(profile, { recursive: true, force: true }); } catch {}
}
