// Headless checks for text layer, search jump, outline, and internal links.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = await mkdtemp(path.join(os.tmpdir(), 'fast-pdf-interaction-'));
const server = spawn(process.env.PYTHON_PATH || 'python3', ['tests/browser_server.py'], { stdio: ['ignore', 'pipe', 'pipe'] });
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

  const layerGeometry = await evaluate(`(() => {
    const page = document.querySelector('.page');
    const rect = el => {const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};};
    return {canvas:rect(page.querySelector('canvas')), text:rect(page.querySelector('.textLayer')), border:getComputedStyle(page).borderWidth};
  })()`);
  console.log('layer geometry', layerGeometry);
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(layerGeometry.canvas[key] - layerGeometry.text[key]) <= 1, 'canvas and text must share ' + key);
  }

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
    const outlineOpen = !document.querySelector('.workspace').classList.contains('sidebar-collapsed') &&
      document.getElementById('sidebar-tab-outline').getAttribute('aria-selected') === 'true';
    btn.click();
    const collapsed = document.querySelector('.workspace').classList.contains('sidebar-collapsed');
    btn.click();
    return { before, outlineOpen, collapsed, restored: document.querySelector('.workspace').classList.contains('sidebar-collapsed') === before };
  })()`);
  assert.equal(sidebarToggle.before, false);
  assert.equal(sidebarToggle.outlineOpen, true, 'outline button switches search to outline before collapsing');
  assert.equal(sidebarToggle.collapsed, true);
  assert.equal(sidebarToggle.restored, true);

  const motion = await evaluate(`(async () => {
    const toggle = document.getElementById('btn-sidebar');
    const workspace = document.querySelector('.workspace');
    // Normalize: measure the collapse motion starting from expanded.
    if (workspace.classList.contains('sidebar-collapsed')) {
      toggle.click();
      await new Promise(r => setTimeout(r, 220));
    }
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
  const pinch = await evaluate(`(async () => {
    // Fit-width depends on platform scrollbar metrics; use a fixed start scale.
    const zoom = document.getElementById('zoom-select');
    zoom.value = '150';
    zoom.dispatchEvent(new Event('change'));
    const wrap = document.querySelector('.viewer-wrap');
    const page = document.querySelector('.page');
    const before = page.getBoundingClientRect().width;
    const rect = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new WheelEvent('wheel', {ctrlKey:true, deltaY:-1,
      clientX:rect.left + 200, clientY:rect.top + 200, bubbles:true, cancelable:true}));
    await new Promise(r => setTimeout(r, 50));
    const during = page.getBoundingClientRect().width;
    const select = document.getElementById("zoom-select");
    const previewLabel = document.getElementById("zoom-label").textContent;
    await new Promise(r => setTimeout(r, 300));
    return { before, during, after:page.getBoundingClientRect().width, previewLabel, finalLabel:document.getElementById("zoom-label").textContent };
  })()`);
  console.log('pinch motion', pinch);
  assert.equal(pinch.previewLabel, '152%', 'toolbar updates during the gesture and rounds to an integer');
  assert.equal(pinch.finalLabel, pinch.previewLabel);
  assert.ok(motion.middle > motion.width * 0.1 && motion.middle < motion.width * 0.95, 'collapse must have an intermediate width');
  assert.ok(motion.end <= 1);
  assert.ok(pinch.during > pinch.before && pinch.during < pinch.before * 1.03, 'tiny pinch must produce a small continuous scale change');
  assert.ok(Math.abs(pinch.after - pinch.during) < 1, 'preview and final scale must agree');

  const burst = await evaluate(`(async () => {
    const wrap = document.querySelector('.viewer-wrap');
    const page = document.querySelector('.page');
    wrap.scrollTop = 300;
    await new Promise(r => setTimeout(r, 200));
    const rect = wrap.getBoundingClientRect();
    const anchorY = rect.top + 220;
    const before = page.getBoundingClientRect();
    const fraction = (anchorY - before.top) / before.height;
    const canvas = page.querySelector('canvas');
    for (let i = 0; i < 10; i++) {
      wrap.dispatchEvent(new WheelEvent('wheel', {ctrlKey:true, deltaY:-1,
        clientX:rect.left + 220, clientY:anchorY, bubbles:true, cancelable:true}));
      await new Promise(r => setTimeout(r, 16));
    }
    const during = page.getBoundingClientRect();
    const sameCanvas = canvas === page.querySelector('canvas');
    const previewError = Math.abs(during.top + fraction * during.height - anchorY);
    await new Promise(r => setTimeout(r, 450));
    const after = page.getBoundingClientRect();
    const finalError = Math.abs(after.top + fraction * after.height - anchorY);
    const customOptions = document.querySelectorAll('option[data-custom-zoom]').length;
    return {sameCanvas, previewError, finalError, ratio:after.width / before.width, customOptions};
  })()`);
  console.log('pinch burst', burst);
  assert.ok(burst.sameCanvas, 'gesture must reuse the bitmap without rendering');
  assert.ok(burst.previewError < 1 && burst.finalError < 1, 'reading point must stay anchored');
  assert.ok(Math.abs(burst.ratio - Math.exp(0.1)) < 0.001, 'all gesture deltas must accumulate');
  assert.equal(burst.customOptions, 0, "gesture percentages must never become dropdown options");

  const nativePinch = await evaluate(`(async () => {
    const wrap = document.querySelector('.viewer-wrap');
    const page = document.querySelector('.page');
    const before = page.getBoundingClientRect().width;
    const rect = wrap.getBoundingClientRect();
    for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 0.9], ['gestureend', 0.9]]) {
      const event = new Event(type, {bubbles:true, cancelable:true});
      Object.assign(event, {scale, clientX:rect.left + 220, clientY:rect.top + 220});
      wrap.dispatchEvent(event);
    }
    await new Promise(r => setTimeout(r, 350));
    return page.getBoundingClientRect().width / before;
  })()`);
  console.log('native pinch ratio', nativePinch);
  assert.ok(Math.abs(nativePinch - 0.9) < 0.001, 'native WebView gesture must scale continuously');

  const zoomMenu = await evaluate(`(async () => {
    const trigger = document.getElementById('zoom-button');
    const menu = document.getElementById('zoom-menu');
    const buttons = [...menu.querySelectorAll('button')];
    const presets = buttons.map(button => button.textContent);
    trigger.click();
    buttons.at(-1).click();
    trigger.click();
    const rect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const complete = buttons.every(button => {
      const box = button.getBoundingClientRect();
      return box.top >= rect.top && box.bottom <= rect.bottom &&
        document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === button;
    });
    const lastSelected = buttons.at(-1).getAttribute('aria-checked');
    const lastLabel = document.getElementById('zoom-label').textContent;
    menu.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}));
    const homeFocus = document.activeElement === buttons[0];
    menu.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    const escapeClosed = menu.hidden && document.activeElement === trigger;
    trigger.click();
    buttons.find(button => button.dataset.zoom === '100').click();
    const wrap = document.querySelector('.viewer-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 1.389], ['gestureend', 1.389]]) {
      const event = new Event(type, {bubbles:true, cancelable:true});
      Object.assign(event, {scale, clientX:wrapRect.left + 220, clientY:wrapRect.top + 220});
      wrap.dispatchEvent(event);
    }
    await new Promise(r => setTimeout(r, 300));
    trigger.click();
    const customLabel = document.getElementById('zoom-label').textContent;
    const fixed = [...menu.querySelectorAll('button')].map(button => button.textContent);
    wrap.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
    return {presets, complete, lastSelected, lastLabel, homeFocus, escapeClosed,
      below:rect.top >= triggerRect.bottom, onScreen:rect.bottom <= innerHeight,
      fixed, customLabel, outsideClosed:menu.hidden};
  })()`);
  console.log('zoom menu', zoomMenu);
  assert.deepEqual(zoomMenu.presets, ['适合宽度', '适合页面', '100%', '125%', '150%', '200%', '250%']);
  assert.deepEqual(zoomMenu.fixed, zoomMenu.presets);
  assert.equal(zoomMenu.customLabel, '139%');
  assert.equal(zoomMenu.lastLabel, '250%');
  assert.equal(zoomMenu.lastSelected, 'true');
  assert.ok(zoomMenu.complete && zoomMenu.below && zoomMenu.onScreen, 'all presets must remain visible when opening at 250%');
  assert.ok(zoomMenu.homeFocus && zoomMenu.escapeClosed && zoomMenu.outsideClosed);

  await until(`document.querySelector('.page')?.dataset.renderedZoom === '1.389'`);
  const fractionalGeometry = await evaluate(`(() => {
    const page = document.querySelector('.page');
    const canvas = page.querySelector('canvas').getBoundingClientRect();
    return ['.textLayer', '.hlLayer', '.linkLayer'].map(selector => {
      const layer = page.querySelector(selector).getBoundingClientRect();
      return {selector, error:Math.max(...['x','y','width','height'].map(key => Math.abs(canvas[key]-layer[key])))};
    });
  })()`);
  console.log('fractional zoom alignment', fractionalGeometry);
  assert.ok(fractionalGeometry.every(layer => layer.error <= 1), 'all interaction layers must match the bitmap after fractional pinch zoom');

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

  // History must restore document coordinates after fit-width layout changes.
  await fetch(`http://127.0.0.1:${fixtures.port}/api/browser/set-opened`, {
    method: 'POST', body: JSON.stringify({ path: fixtures.long }),
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload');
  await until(`document.getElementById('page-count').textContent === '120' && document.querySelector('.page')?.dataset.renderedZoom`);
  await evaluate(`document.getElementById('zoom-select').value='page-width';document.getElementById('zoom-select').dispatchEvent(new Event('change'))`);
  await evaluate(`document.getElementById('page-input').value='20';document.getElementById('page-input').dispatchEvent(new Event('change'))`);
  await until(`document.querySelector('[data-page-number="20"]')?.dataset.renderedZoom`);
  const beforeResize = await evaluate(`(() => {
    const page = document.querySelector('[data-page-number="20"]');
    return (document.getElementById('viewer-wrap').scrollTop + 64 - page.offsetTop) / Number(page.dataset.renderedZoom);
  })()`);
  await evaluate(`document.getElementById('page-input').value='80';document.getElementById('page-input').dispatchEvent(new Event('change'))`);
  await until(`document.querySelector('[data-page-number="80"]')?.dataset.renderedZoom`);
  const wideZoom = await evaluate(`document.querySelector('[data-page-number="80"]').dataset.renderedZoom`);
  await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(`document.querySelector('[data-page-number="80"]')?.dataset.renderedZoom && document.querySelector('[data-page-number="80"]').dataset.renderedZoom !== ${JSON.stringify(wideZoom)}`);
  await evaluate(`document.getElementById('btn-back').click()`);
  await until(`document.getElementById('page-input').value === '20' && document.querySelector('[data-page-number="20"]')?.dataset.renderedZoom`);
  const afterResize = await evaluate(`(() => {
    const page = document.querySelector('[data-page-number="20"]');
    return (document.getElementById('viewer-wrap').scrollTop + 64 - page.offsetTop) / Number(page.dataset.renderedZoom);
  })()`);
  assert.ok(Math.abs(afterResize - beforeResize) < 1, 'back restores the same PDF reading point after resizing');
  console.log('history resize', { beforeResize, afterResize });

  console.log(JSON.stringify({ linkLayerPe, textLayerPe, outlineCount, selection, errors }, null, 2));
  assert.deepEqual(errors, []);
} finally {
  socket?.close();
  chrome.kill();
  server.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
