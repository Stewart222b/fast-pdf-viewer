/**
 * Phase 1 render benchmark — headless Chromium + CDP.
 * Run: node tests/render-benchmark.mjs
 * Output: JSON to stdout; RESULT_PATH env for file.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH || "/usr/local/bin/google-chrome";

async function runBenchmark() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "fast-pdf-render-bench-"));
  const server = spawn("python3", ["tests/benchmark_server.py"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--no-first-run",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let socket;
  const report = {
    meta: { chrome: CHROME, viewport: "1280x900", date: new Date().toISOString() },
    fixtures: {},
  };

  try {
    const firstLine = (stream) =>
      new Promise((resolve, reject) => {
        let output = "";
        stream.on("data", (chunk) => {
          output += chunk;
          if (output.includes("\n")) resolve(output.split("\n")[0]);
        });
        setTimeout(() => reject(new Error("server startup timed out")), 60000).unref();
      });
    const endpoint = new Promise((resolve, reject) => {
      let output = "";
      chrome.stderr.on("data", (chunk) => {
        output += chunk;
        const m = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) resolve(m[1]);
      });
      chrome.on("error", reject);
      setTimeout(() => reject(new Error("Chrome startup timed out")), 30000).unref();
    });

    const fixtures = JSON.parse(await firstLine(server.stdout));
    const ws = await endpoint;
    const host = new URL(ws).host;
    const target = await (
      await fetch(`http://${host}/json/new?about:blank`, { method: "PUT" })
    ).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

    let id = 0;
    const waiting = new Map();
    const cdpErrors = [];
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const pending = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.error) pending?.reject(data.error);
        else pending?.resolve(data.result);
      }
      if (data.method === "Runtime.exceptionThrown") {
        cdpErrors.push(data.params.exceptionDetails.text);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        waiting.set(++id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const until = async (expression, timeoutMs = 120000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await evaluate(expression)) return;
        await sleep(40);
      }
      throw new Error(`Timed out: ${expression}`);
    };

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Performance.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: "globalThis.__PDF_BENCH__ = true;",
    });

    const domStats = () => evaluate(`(() => {
      const v = globalThis.__pdfViewer;
      const pages = [...document.querySelectorAll('.page')];
      const rendered = pages.filter(p => p.dataset.renderedZoom);
      const canvases = pages.map(p => p.querySelector('canvas'));
      const activeCanvas = canvases.filter(c => c.width > 0 && c.height > 0);
      const textSpans = pages.reduce((n, p) => n + p.querySelectorAll('.textLayer span').length, 0);
      const heap = performance.memory?.usedJSHeapSize ?? null;
      return {
        pageCount: pages.length,
        renderedDom: rendered.length,
        canvasWithPixels: activeCanvas.length,
        textLayerSpans: textSpans,
        textContentsCache: v?.textContents?.size ?? null,
        renderedPagesCache: v?.renderedPages?.size ?? null,
        renderJobs: v?.renderJobs?.size ?? null,
        activeRenderTasks: v?.tasks?.size ?? null,
        maxCachedPages: v?.maxCachedPages ?? null,
        bench: v?.bench ? { ...v.bench } : null,
        heapBytes: heap,
      };
    })()`);

    const measureScrollFps = async (distance, steps = 25) => {
      return evaluate(`(async () => {
        const wrap = document.getElementById('viewer-wrap');
        const step = ${distance} / ${steps};
        let frames = 0;
        let start = performance.now();
        const count = () => { frames++; };
        const run = new Promise(resolve => {
          const tick = () => {
            if (performance.now() - start >= 2000) { resolve(); return; }
            requestAnimationFrame(count);
            requestAnimationFrame(tick);
          };
          tick();
        });
        for (let i = 0; i < ${steps}; i++) {
          wrap.scrollTop += step;
          await new Promise(r => setTimeout(r, 16));
        }
        await run;
        const elapsed = performance.now() - start;
        return { frames, elapsedMs: Math.round(elapsed), fps: Math.round(frames / (elapsed / 1000)) };
      })()`);
    };

    const fastScrollBurst = async (totalPx, chunk = 400) => {
      await evaluate(`(async () => {
        const wrap = document.getElementById('viewer-wrap');
        let left = ${totalPx};
        while (left > 0) {
          const d = Math.min(${chunk}, left);
          wrap.scrollTop += d;
          left -= d;
          await new Promise(r => setTimeout(r, 8));
        }
      })()`);
      await sleep(800);
    };

    const zoomCycle = async (modes) => {
      for (const z of modes) {
        await evaluate(`document.getElementById('zoom-select').value='${z}';document.getElementById('zoom-select').dispatchEvent(new Event('change'))`);
        await sleep(120);
        await evaluate(`document.getElementById('viewer-wrap').scrollTop += 600`);
        await sleep(80);
      }
      await sleep(600);
    };

    const openFixture = async (key) => {
      await fetch(`http://127.0.0.1:${fixtures.port}/api/browser/set-opened`, {
        method: "POST",
        body: JSON.stringify({ path: fixtures.fixtures[key] }),
      });
      await send("Page.navigate", { url: `http://127.0.0.1:${fixtures.port}/` });
      const t0 = Date.now();
      await until(`document.querySelector('.page')?.dataset.renderedZoom`, 180000);
      const firstPaintMs = Date.now() - t0;
      await until(`globalThis.__pdfViewer?.indexedPages >= Math.min(10, globalThis.__pdfViewer?.pageCount||0)`, 300000);
      return { firstPaintMs };
    };

    for (const key of ["p100", "p500", "p1200"]) {
      const entry = { key };
      const { firstPaintMs } = await openFixture(key);
      entry.firstVisiblePageMs = firstPaintMs;
      entry.afterOpen = await domStats();

      await evaluate(`(() => { const v = globalThis.__pdfViewer; if (v?.bench) Object.keys(v.bench).forEach(k => v.bench[k] = 0); })()`);

      const scrollPx = key === "p100" ? 12000 : key === "p500" ? 40000 : 80000;
      entry.scrollFps = await measureScrollFps(scrollPx, 30);
      await fastScrollBurst(scrollPx);
      entry.afterFastScroll = await domStats();

      await evaluate(`(() => { const v = globalThis.__pdfViewer; if (v?.bench) Object.keys(v.bench).forEach(k => v.bench[k] = 0); })()`);
      entry.zoomStress = {};
      for (const z of ["150", "200", "300"]) {
        await zoomCycle([z, "200", "300", "150"]);
        entry.zoomStress[z] = await domStats();
      }

      await evaluate(`document.getElementById('search-input').value='needle';document.getElementById('search-input').dispatchEvent(new Event('input'))`);
      const searchStart = Date.now();
      await until(`document.querySelectorAll('.search-hit').length > 0`, 300000);
      entry.searchFirstHitMs = Date.now() - searchStart;
      entry.searchHits = await evaluate(`document.querySelectorAll('.search-hit').length`);
      await sleep(500);
      entry.afterSearch = await domStats();

      entry.memoryAfterReading = await evaluate(`(async () => {
        const wrap = document.getElementById('viewer-wrap');
        const peak = performance.memory?.usedJSHeapSize ?? null;
        for (let i = 0; i < 8; i++) {
          wrap.scrollTop = (i % 2 ? 0 : wrap.scrollHeight * 0.4);
          await new Promise(r => setTimeout(r, 400));
        }
        return { heapAfterPassBytes: performance.memory?.usedJSHeapSize ?? null, peakHeapBytes: peak };
      })()`);

      entry.duplicateScheduling = {
        note: "observerRenderCalls vs renderVisibleCalls during one burst",
        ...await evaluate(`(async () => {
          const v = globalThis.__pdfViewer;
          Object.keys(v.bench).forEach(k => v.bench[k] = 0);
          const wrap = document.getElementById('viewer-wrap');
          for (let i = 0; i < 15; i++) { wrap.scrollTop += 500; await new Promise(r => setTimeout(r, 30)); }
          await new Promise(r => setTimeout(r, 400));
          return {
            observerRenderCalls: v.bench.observerRenderCalls,
            renderVisibleCalls: v.bench.renderVisibleCalls,
            renderPageCalls: v.bench.renderPageCalls,
            renderTaskCancels: v.bench.renderTaskCancels,
            ratioObserverToRenderPage: v.bench.renderPageCalls
              ? (v.bench.observerRenderCalls / v.bench.renderPageCalls).toFixed(2) : null,
          };
        })()`),
      };

      report.fixtures[key] = entry;
    }

    report.cdpErrors = cdpErrors;
    report.config = {
      maxCachedPages: 8,
      rootMargin: "1200px 0px",
      renderVisibleMargin: "800px",
      scrollDebounceMs: 50,
      zoomDebounceMs: 80,
    };
  } finally {
    socket?.close();
    chrome.kill();
    server.kill();
    await sleep(500);
    await rm(profile, { recursive: true, force: true });
  }

  const out = JSON.stringify(report, null, 2);
  console.log(out);
  if (process.env.RESULT_PATH) await writeFile(process.env.RESULT_PATH, out);
  return report;
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
