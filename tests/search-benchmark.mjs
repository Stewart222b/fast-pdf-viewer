/**
 * Search performance: result list stays independent of page rendering.
 * Run: node tests/search-benchmark.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH || "/usr/local/bin/google-chrome";

async function runBenchmark() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "fast-pdf-search-bench-"));
  const server = spawn("python3", ["tests/search_benchmark_server.py"], {
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
    const until = async (expression, timeoutMs = 180000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await evaluate(expression)) return;
        await sleep(30);
      }
      throw new Error(`Timed out: ${expression}`);
    };

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: "globalThis.__PDF_BENCH__ = true;",
    });

    const stats = () => evaluate(`(() => {
      const v = globalThis.__pdfViewer;
      const pages = [...document.querySelectorAll('.page')];
      const canvases = pages.filter(p => {
        const c = p.querySelector('canvas');
        return c && c.width > 0 && c.height > 0;
      }).length;
      const textLayers = pages.filter(p => p.querySelector('.textLayer')?.childElementCount > 0).length;
      return {
        pageCount: pages.length,
        hitCount: v?.hits?.length ?? 0,
        renderedPages: v?.renderedPages?.size ?? 0,
        renderJobs: v?.renderJobs?.size ?? 0,
        maxCachedPages: v?.maxCachedPages ?? null,
        canvases,
        textLayers,
        highlights: document.querySelectorAll('.hl').length,
        searchHits: document.querySelectorAll('.search-hit').length,
        bench: v?.bench ? { ...v.bench } : null,
        searchBench: globalThis.__pdfSearchBench ?? null,
      };
    })()`);

    await fetch(`http://127.0.0.1:${fixtures.port}/api/open-path`, {
      method: "POST",
      body: JSON.stringify({ path: fixtures.fixtures.surf720 }),
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${fixtures.port}/` });
    await until(`document.querySelector('.page')?.dataset.renderedZoom`);
    await until(
      `globalThis.__pdfViewer?.indexedPages === globalThis.__pdfViewer?.pageCount`,
      300000,
    );

    report.afterIndex = await stats();
    assert.equal(report.afterIndex.pageCount, fixtures.expected.pageCount);

    await evaluate(`(() => {
      const v = globalThis.__pdfViewer;
      if (v?.bench) Object.keys(v.bench).forEach(k => v.bench[k] = 0);
      globalThis.__pdfSearchBench = null;
    })()`);

    const typed = await evaluate(`(() => {
      const input = document.getElementById('search-input');
      const snapshot = () => globalThis.__pdfViewer.bench.renderPageCalls;
      const calls = [];
      for (const value of ['s', 'su', 'sur', 'surf']) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        calls.push(snapshot());
      }
      return { calls, afterTyping: snapshot() };
    })()`);
    report.typing = typed;
    assert.ok(
      typed.afterTyping === 0 && typed.calls.every((n) => n === 0),
      `typing launched page renders: ${JSON.stringify(typed)}`,
    );

    await until(`document.querySelectorAll('.search-hit').length > 0`);
    const atList = await stats();
    report.atResultList = atList;
    assert.ok(atList.searchHits > 0);
    assert.ok(atList.hitCount >= fixtures.expected.surfHits, `hits ${atList.hitCount}`);
    assert.ok(
      atList.searchBench.resultListVisibleMs <= 200,
      `result list ${atList.searchBench.resultListVisibleMs}ms`,
    );
    assert.ok(
      atList.bench.renderPageCalls <= 3,
      `search renderPageCalls ${atList.bench.renderPageCalls}`,
    );
    assert.ok(atList.renderedPages <= atList.maxCachedPages + 2);
    assert.ok((atList.bench.renderJobsPeak ?? atList.renderJobs) < 8);
    assert.ok(atList.canvases < 20);
    assert.ok(atList.textLayers < 20);
    assert.ok(atList.canvases <= atList.hitCount / 10);

    await until(`document.querySelector('.hl')`, 30000);
    report.firstHighlight = await stats();
    report.metrics = {
      searchDocumentMs: atList.searchBench.searchDocumentMs,
      resultListVisibleMs: atList.searchBench.resultListVisibleMs,
      firstHitHighlightMs: report.firstHighlight.searchBench.firstJumpMs,
      searchTriggeredRenderPageCalls: atList.bench.renderPageCalls,
      renderJobsPeak: atList.bench.renderJobsPeak,
      canvasPeak: atList.bench.canvasPeak,
      textLayerPeak: atList.bench.textLayerPeak,
    };

    const beforeClear = report.firstHighlight.bench.renderPageCalls;
    await evaluate(`(() => {
      const input = document.getElementById('search-input');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(`document.querySelectorAll('.hl').length === 0 && document.querySelectorAll('.search-hit').length === 0`);
    const afterClear = await stats();
    report.afterClear = afterClear;
    assert.equal(afterClear.bench.renderPageCalls, beforeClear);

    await evaluate(`(() => {
      const v = globalThis.__pdfViewer;
      if (v?.bench) Object.keys(v.bench).forEach(k => v.bench[k] = 0);
    })()`);
    await evaluate(`(() => {
      const input = document.getElementById('search-input');
      input.value = 'surf';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(`document.querySelectorAll('.search-hit').length > 0`);
    await until(`document.querySelector('.hl')`);
    const afterResearch = await stats();
    const beforeNext = afterResearch.bench.renderPageCalls;
    await evaluate(`document.getElementById('search-next').click()`);
    await until(`globalThis.__pdfViewer.hitIndex === 1`);
    await until(`document.querySelector('[data-page-number="${fixtures.expected.secondHitPage}"]')?.dataset.renderedZoom`);
    const afterNext = await stats();
    report.nextResult = {
      beforeRenderPageCalls: beforeNext,
      afterRenderPageCalls: afterNext.bench.renderPageCalls,
      currentPage: await evaluate(`globalThis.__pdfViewer.currentPage`),
    };
    assert.ok(
      afterNext.bench.renderPageCalls - beforeNext <= afterNext.maxCachedPages,
      `next-result renders ${afterNext.bench.renderPageCalls - beforeNext}`,
    );
    assert.equal(report.nextResult.currentPage, fixtures.expected.secondHitPage);

    const farPage = 300;
    await evaluate(`(() => {
      const el = document.querySelector('[data-page-number="${farPage}"]');
      document.getElementById('viewer-wrap').scrollTop = el.offsetTop - 16;
    })()`);
    await until(`document.querySelector('[data-page-number="${farPage}"]')?.dataset.renderedZoom`);
    await until(`document.querySelector('[data-page-number="${farPage}"] .hl')`);
    report.scrolledHitPage = await stats();
    report.scrolledHitPage.page = farPage;
    assert.ok(report.scrolledHitPage.renderedPages <= report.scrolledHitPage.maxCachedPages + 2);

    report.cdpErrors = cdpErrors;
    assert.deepEqual(cdpErrors, []);
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
