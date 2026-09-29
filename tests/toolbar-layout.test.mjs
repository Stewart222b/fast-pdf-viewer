import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const indexHtml = readFileSync(path.join(root, "web/index.html"), "utf8");
const mainJs = readFileSync(path.join(root, "web/js/main.js"), "utf8");
const stylesCss = readFileSync(path.join(root, "web/styles.css"), "utf8");

function edgeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    ...(process.platform === "linux" ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"] : []),
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

function makeFixture() {
  const sprite = indexHtml.match(/<svg class="icon-sprite"[\s\S]*?<\/svg>/)?.[0];
  const toolbar = indexHtml.match(/<header class="toolbar">[\s\S]*?<\/header>/)?.[0];
  assert.ok(sprite && toolbar, "toolbar markup is available for the isolated fixture");

  const start = mainJs.indexOf('const toolbarMoreButton = $("btn-toolbar-more");');
  const end = mainJs.indexOf("\nconst history = new ViewHistory();", start);
  assert.ok(start >= 0 && end > start, "toolbar event handlers have stable source boundaries");
  const toolbarHandlers = mainJs.slice(start, end);
  const longName = "quarterly_review_copy_with_a_deliberately_long_filename_".repeat(3) + "2026.pdf";
  const titleLiteral = JSON.stringify(longName);

  return "<!doctype html>\n"
    + "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<link rel=\"stylesheet\" href=\"/web/styles.css\">\n"
    + "</head><body><div id=\"app\">" + sprite + toolbar + "</div>\n"
    + "<script>\n"
    + "const $ = id => document.getElementById(id);\n"
    + "const title = " + titleLiteral + ";\n"
    + "$(\"page-controls\").hidden = false;\n"
    + "$(\"page-divider\").hidden = false;\n"
    + "$(\"page-input\").disabled = false;\n"
    + "$(\"page-input\").value = \"999999\";\n"
    + "$(\"page-count\").textContent = \"888888\";\n"
    + "$(\"doc-title\").textContent = title;\n"
    + "$(\"doc-title\").title = title;\n"
    + "$(\"doc-title\").setAttribute(\"aria-label\", title);\n"
    + "$(\"doc-title-menu-label\").textContent = title;\n"
    + "$(\"btn-doc-title-menu\").setAttribute(\"aria-label\", title);\n"
    + "$(\"btn-doc-title-menu\").title = title;\n"
    + "$(\"doc-title-popover\").textContent = title;\n"
    + toolbarHandlers + "\n"
    + "</script></body></html>";
}

const edgePath = edgeExecutable();
test("toolbar layout at narrow and wide viewport widths", {
  skip: !edgePath || typeof WebSocket === "undefined" ? "Set CHROME_PATH or EDGE_PATH to run browser layout checks" : false,
}, async () => {
  const fixture = makeFixture();
  const server = createServer((request, response) => {
    if (request.url === "/fixture.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(fixture);
      return;
    }
    if (request.url === "/web/styles.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(stylesCss);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const profile = mkdtempSync(path.join(tmpdir(), "fpv-toolbar-edge-"));
  let edge;
  let socket;

  const waitFor = async (predicate, description, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for " + description);
  };

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const serverPort = server.address().port;
    edge = spawn(edgePath, [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-gpu",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--user-data-dir=" + profile,
      "about:blank",
    ], { stdio: "ignore", windowsHide: true });

    const activePortFile = path.join(profile, "DevToolsActivePort");
    const debuggingPort = await waitFor(() => {
      try {
        const portValue = Number(readFileSync(activePortFile, "utf8").split(/\r?\n/)[0]);
        return Number.isFinite(portValue) && portValue > 0 ? portValue : null;
      } catch {
        return null;
      }
    }, "Edge remote debugging");
    const targets = await (await fetch("http://127.0.0.1:" + debuggingPort + "/json/list")).json();
    const page = targets.find(target => target.type === "page");
    assert.ok(page, "Edge opened a page target");

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", async event => {
      const raw = event.data instanceof Blob ? await event.data.text() : String(event.data);
      const message = JSON.parse(raw);
      if (!message.id) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + " timed out"));
      }, 5000);
      pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
      }
      return result.result.value;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: "http://127.0.0.1:" + serverPort + "/fixture.html" });
    await waitFor(async () => evaluate("document.readyState === 'complete' && !!document.querySelector('.toolbar')"), "toolbar fixture");

    const widths = [320, 400, 620, 640, 700, 800, 1024, 1440];
    for (const width of widths) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const rects = await evaluate("(() => {\n"
        + "const box = selector => { const element = document.querySelector(selector); const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, display: getComputedStyle(element).display }; };\n"
        + "const toolbar = document.querySelector('.toolbar');\n"
        + "return { viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth, toolbar: { width: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth }, left: box('.toolbar-left'), center: box('.toolbar-center'), right: box('.toolbar-right'), page: box('#page-controls'), more: box('#btn-toolbar-more') };\n"
        + "})()");

      assert.equal(rects.viewport, width, width + "px: emulated viewport width");
      assert.ok(rects.documentWidth <= width, width + "px: document has horizontal overflow (" + rects.documentWidth + "px)");
      assert.ok(rects.toolbar.scrollWidth <= rects.toolbar.width + 1, width + "px: toolbar content overflows its box");
      assert.ok(rects.left.right <= rects.right.left + 1, width + "px: page controls overlap the zoom/search area");
      if (rects.center.display !== "none") {
        assert.ok(rects.left.right <= rects.center.left + 1, width + "px: left controls overlap the title");
        assert.ok(rects.center.right <= rects.right.left + 1, width + "px: title overlaps right controls");
      }
      if (width <= 1020) {
        assert.ok(rects.more.width > 0, width + "px: More entry remains visible");
      }
    }

    await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 800, deviceScaleFactor: 1, mobile: false });
    const menuResult = await evaluate("(() => { document.getElementById('btn-toolbar-more').click(); const menu = document.getElementById('toolbar-more-menu'); const rect = menu.getBoundingClientRect(); return { expanded: document.getElementById('btn-toolbar-more').getAttribute('aria-expanded'), display: getComputedStyle(menu).display, hidden: menu.getAttribute('aria-hidden'), left: rect.left, right: rect.right, titleButton: getComputedStyle(document.getElementById('btn-doc-title-menu')).display, titleText: document.getElementById('doc-title-menu-label').textContent }; })()");
    assert.equal(menuResult.expanded, "true", "More control opens the menu");
    assert.notEqual(menuResult.display, "none", "menu items become visible");
    assert.equal(menuResult.hidden, "false", "open menu is exposed to accessibility APIs");
    assert.ok(menuResult.left >= 0 && menuResult.right <= 320, "menu stays within the narrow viewport");
    assert.ok(menuResult.titleButton !== "none" && menuResult.titleText.length > 60, "menu exposes the full document name");

    const titlePopover = await evaluate("(() => { document.getElementById('btn-doc-title-menu').click(); const popover = document.getElementById('doc-title-popover'); const rect = popover.getBoundingClientRect(); return { hidden: popover.hidden, left: rect.left, right: rect.right, text: popover.textContent }; })()");
    assert.equal(titlePopover.hidden, false, "full filename entry opens its detail popover");
    assert.ok(titlePopover.left >= 0 && titlePopover.right <= 320, "full filename popover stays within the narrow viewport");
    assert.ok(titlePopover.text.endsWith("2026.pdf"), "popover contains the complete filename");
  } finally {
    socket?.close();
    edge?.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const resolvedProfile = path.resolve(profile);
    const resolvedTemp = path.resolve(tmpdir());
    if (resolvedProfile.startsWith(resolvedTemp + path.sep)) {
      try { rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* browser may release files later */ }
    }
  }
});
