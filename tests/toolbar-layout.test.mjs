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

// Geometry the review measured on the shipped toolbar: a filename this wide has
// to survive 1024px, the narrowest window the extension is expected to run in.
const TITLE_BUDGET_1024 = 394;

function makeFixture() {
  const sprite = indexHtml.match(/<svg class="icon-sprite"[\s\S]*?<\/svg>/)?.[0];
  const toolbar = indexHtml.match(/<header class="toolbar">[\s\S]*?<\/header>/)?.[0];
  assert.ok(sprite && toolbar, "toolbar markup is available for the isolated fixture");

  const start = mainJs.indexOf('const docTitleButton = $("doc-title");');
  const end = mainJs.indexOf("\nconst history = new ViewHistory();", start);
  assert.ok(start >= 0 && end > start, "toolbar event handlers have stable source boundaries");
  const toolbarHandlers = mainJs.slice(start, end).replace(/\r\n/g, "\n");
  const longName = "quarterly_review_copy_with_a_deliberately_long_filename_".repeat(3) + "2026.pdf";
  const titleLiteral = JSON.stringify(longName);

  return "<!doctype html>\n"
    + "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + "<link rel=\"stylesheet\" href=\"/web/styles.css\">\n"
    + "</head><body><div id=\"app\">" + sprite + toolbar + "</div>\n"
    + "<script>\n"
    + "const $ = id => document.getElementById(id);\n"
    + "const title = " + titleLiteral + ";\n"
    + "window.__setPage = (current, total) => {\n"
    + "  $(\"page-controls\").hidden = false;\n"
    + "  $(\"page-divider\").hidden = false;\n"
    + "  $(\"page-input\").disabled = false;\n"
    + "  $(\"page-input\").value = current;\n"
    + "  $(\"page-count\").textContent = total;\n"
    + "};\n"
    + "window.__setTitle = text => {\n"
    + "  $(\"doc-title\").textContent = text;\n"
    + "  $(\"doc-title\").title = text;\n"
    + "  $(\"doc-title\").setAttribute(\"aria-label\", text);\n"
    + "  $(\"doc-title-menu-label\").textContent = text;\n"
    + "  $(\"doc-title-popover\").textContent = text;\n"
    + "};\n"
    + "__setPage(\"999999\", \"888888\");\n"
    + "__setTitle(title);\n"
    + "$(\"btn-original-pdf\").hidden = false;\n"  // extension chrome is on
    + "$(\"btn-doc-title-menu\").setAttribute(\"aria-label\", title);\n"
    + "$(\"btn-doc-title-menu\").title = title;\n"
    + toolbarHandlers + "\n"
    + "</script></body></html>";
}

const edgePath = edgeExecutable();
test("toolbar keeps one overflow entry and a centered title at every width", {
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
      // Headless Chrome in a restricted/CI sandbox cannot initialize its own
      // renderer sandbox; without these two the browser accepts the WebSocket
      // but never answers a single page-domain command, so every step just
      // times out instead of failing loudly.
      "--no-sandbox",
      "--disable-dev-shm-usage",
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
    const resize = async width => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await new Promise(resolve => setTimeout(resolve, 80));
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: "http://127.0.0.1:" + serverPort + "/fixture.html" });
    await waitFor(async () => evaluate("document.readyState === 'complete' && !!document.querySelector('.toolbar')"), "toolbar fixture");

    // 1. One row, no overlap, and the same secondary entry everywhere.
    const widths = [320, 400, 620, 640, 700, 800, 900, 1000, 1024, 1280, 1440, 1920, 2560, 3840];
    for (const width of widths) {
      await resize(width);
      const rects = await evaluate("(() => {\n"
        + "const box = selector => { const element = document.querySelector(selector); const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, display: getComputedStyle(element).display }; };\n"
        + "const toolbar = document.querySelector('.toolbar');\n"
        + "const menu = document.getElementById('toolbar-more-menu');\n"
        + "const extent = selector => {\n"
        + "  const root = document.querySelector(selector);\n"
        + "  if (!root || getComputedStyle(root).display === 'none') return null;\n"
        + "  let left = Infinity; let right = -Infinity;\n"
        + "  for (const el of [root, ...root.querySelectorAll('*')]) {\n"
        + "    if (el.offsetParent === null) continue;\n"
        + "    const box = el.getBoundingClientRect();\n"
        + "    if (box.width === 0) continue;\n"
        + "    left = Math.min(left, box.left); right = Math.max(right, box.right);\n"
        + "  }\n"
        + "  return Number.isFinite(left) ? { left, right } : null;\n"
        + "};\n"
        + "return { viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth, toolbar: { width: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth }, left: box('.toolbar-left'), center: box('.toolbar-center'), right: box('.toolbar-right'), page: box('#page-controls'), more: box('#btn-toolbar-more'), moreMenu: box('#toolbar-more-menu'), back: box('#btn-back'), extent: { left: extent('.toolbar-left'), center: extent('.toolbar-center'), right: extent('.toolbar-right') }, expanded: document.getElementById('btn-toolbar-more').getAttribute('aria-expanded'), hidden: menu.getAttribute('aria-hidden'), inert: menu.inert };\n"
        + "})()");

      assert.equal(rects.viewport, width, width + "px: emulated viewport width");
      assert.ok(rects.documentWidth <= width, width + "px: document has horizontal overflow (" + rects.documentWidth + "px)");
      assert.ok(rects.toolbar.scrollWidth <= rects.toolbar.width + 1, width + "px: toolbar content overflows its box");
      assert.ok(rects.left.right <= rects.right.left + 1, width + "px: page controls overlap the zoom/search area");
      // Clusters can still collide when their boxes do not: a flexible track
      // shrinks the box while the children keep painting past its edge. Compare
      // what each cluster actually paints, not the track it sits in.
      assert.ok(
        rects.extent.left.right <= rects.extent.right.left + 1,
        width + "px: left cluster paints " + (rects.extent.left.right - rects.extent.right.left).toFixed(1) + "px into the right cluster",
      );
      if (rects.extent.center) {
        assert.ok(rects.extent.left.right <= rects.extent.center.left + 1, width + "px: left cluster overlaps the title");
        assert.ok(rects.extent.center.right <= rects.extent.right.left + 1, width + "px: title overlaps the right cluster");
      }
      assert.ok(rects.extent.left.left >= -1, width + "px: left cluster starts off-screen");
      assert.ok(rects.extent.right.right <= width + 1, width + "px: right cluster ends off-screen");
      if (rects.center.display !== "none") {
        assert.ok(rects.left.right <= rects.center.left + 1, width + "px: left controls overlap the title");
        assert.ok(rects.center.right <= rects.right.left + 1, width + "px: title overlaps right controls");
      }
      // 更多 is the single secondary entry: never hidden, always the same popover.
      assert.ok(rects.more.width > 0, width + "px: More entry stays visible");
      assert.notEqual(rects.more.display, "none", width + "px: More entry is a visible control");
      assert.ok(rects.back.width > 0, width + "px: back action remains visible");
      assert.equal(rects.expanded, "false", width + "px: More starts closed");
      assert.equal(rects.moreMenu.display, "none", width + "px: secondary actions are collapsed at rest");
      assert.equal(rects.hidden, "true", width + "px: closed menu is hidden from assistive tech");
      assert.equal(rects.inert, true, width + "px: closed menu leaves the tab order");
    }

    // 1b. Large desktop chrome scales in steps; 1919px stays compact.
    for (const [width, expected] of [
      [1919, { root: "13px", toolbar: 40, sidebar: "272px", btn: 30 }],
      [1920, { root: "14px", toolbar: 48, sidebar: "320px", btn: 34 }],
      [2560, { root: "15px", toolbar: 56, sidebar: "360px", btn: 38 }],
      [3840, { root: "17px", toolbar: 64, sidebar: "420px", btn: 44 }],
    ]) {
      await resize(width);
      const scale = await evaluate("(() => {\n"
        + "const root = getComputedStyle(document.documentElement);\n"
        + "const toolbar = document.querySelector('.toolbar');\n"
        + "const sidebarButton = document.getElementById('btn-sidebar');\n"
        + "return { root: root.fontSize, toolbar: toolbar.getBoundingClientRect().height, sidebar: root.getPropertyValue('--sidebar-w').trim(), btn: sidebarButton.getBoundingClientRect().height };\n"
        + "})()");
      assert.equal(scale.root, expected.root, width + "px: chrome type scale");
      assert.equal(scale.toolbar, expected.toolbar, width + "px: toolbar height");
      assert.equal(scale.sidebar, expected.sidebar, width + "px: sidebar width token");
      assert.equal(scale.btn, expected.btn, width + "px: toolbar control height");
    }

    // 2. The title centers between the two clusters and keeps 1024px workable.
    const longName = "quarterly_review_copy_with_a_deliberately_long_filename_".repeat(3) + "2026.pdf";
    for (const width of [1024, 1280, 1440]) {
      await resize(width);
      await evaluate("window.__setPage('12', '128')");
      await evaluate("window.__setTitle('2026_Q3_quarterly_review_final_v2.pdf')");
      const geometry = await evaluate("(() => {\n"
        + "const rect = selector => document.querySelector(selector).getBoundingClientRect();\n"
        + "const title = document.getElementById('doc-title');\n"
        + "const range = document.createRange(); range.selectNodeContents(title);\n"
        + "const text = range.getBoundingClientRect();\n"
        + "const left = rect('.toolbar-left'); const right = rect('.toolbar-right');\n"
        + "return { textCenter: (text.left + text.right) / 2, clusterCenter: (left.right + right.left) / 2, space: rect('.toolbar-center').width, truncated: title.scrollWidth > title.clientWidth + 1 };\n"
        + "})()");
      assert.equal(geometry.truncated, false, width + "px: a normal filename fits without ellipsis");
      assert.ok(
        Math.abs(geometry.textCenter - geometry.clusterCenter) <= 4,
        width + "px: title text center sits " + (geometry.textCenter - geometry.clusterCenter).toFixed(1) + "px off the cluster midpoint",
      );
      if (width === 1024) {
        assert.ok(geometry.space >= TITLE_BUDGET_1024, width + "px: title has only " + geometry.space.toFixed(1) + "px");
      }
      // A name that cannot fit still truncates in place instead of pushing chrome.
      await evaluate("window.__setTitle(" + JSON.stringify(longName) + ")");
      const overflow = await evaluate("(() => {\n"
        + "const title = document.getElementById('doc-title');\n"
        + "const left = document.querySelector('.toolbar-left').getBoundingClientRect();\n"
        + "const right = document.querySelector('.toolbar-right').getBoundingClientRect();\n"
        + "const box = title.getBoundingClientRect();\n"
        + "return { truncated: title.scrollWidth > title.clientWidth + 1, inside: box.left >= left.right - 1 && box.right <= right.left + 1, scrollWidth: document.querySelector('.toolbar').scrollWidth, clientWidth: document.querySelector('.toolbar').clientWidth };\n"
        + "})()");
      assert.equal(overflow.truncated, true, width + "px: an oversized name is ellipsized");
      assert.ok(overflow.inside, width + "px: an oversized name stays between the clusters");
      assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1, width + "px: an oversized name does not widen the toolbar");
    }

    // 3. The popover follows the filename, not the window.
    for (const width of [1024, 1440]) {
      await resize(width);
      await evaluate("window.__setTitle('2026_Q3_quarterly_review_final_v2.pdf')");
      const popover = await evaluate("(() => {\n"
        + "document.getElementById('doc-title').click();\n"
        + "const pop = document.getElementById('doc-title-popover');\n"
        + "const box = pop.getBoundingClientRect();\n"
        + "const title = document.getElementById('doc-title');\n"
        + "const range = document.createRange(); range.selectNodeContents(title);\n"
        + "const text = range.getBoundingClientRect();\n"
        + "return { hidden: pop.hidden, center: (box.left + box.right) / 2, textCenter: (text.left + text.right) / 2, left: box.left, right: box.right, viewport: window.innerWidth };\n"
        + "})()");
      assert.equal(popover.hidden, false, width + "px: clicking the filename opens the full name");
      assert.ok(
        Math.abs(popover.center - popover.textCenter) <= 8,
        width + "px: popover center sits " + (popover.center - popover.textCenter).toFixed(1) + "px off the filename",
      );
      assert.ok(popover.left >= 0 && popover.right <= popover.viewport, width + "px: full filename popover stays inside the viewport");
      await evaluate("document.getElementById('doc-title').click()");
    }

    // 4. 更多 holds the same low-frequency set; the filename entry appears only
    //    once the centered title is gone.
    await evaluate("window.__setTitle(" + JSON.stringify(longName) + ")");
    for (const [width, expectTitleEntry] of [[1440, false], [900, true], [320, true]]) {
      await resize(width);
      const menu = await evaluate("(() => {\n"
        + "document.getElementById('btn-toolbar-more').click();\n"
        + "const menu = document.getElementById('toolbar-more-menu');\n"
        + "const box = menu.getBoundingClientRect();\n"
        + "const item = id => { const el = document.getElementById(id); return { display: getComputedStyle(el).display, text: el.textContent.trim(), width: el.getBoundingClientRect().width }; };\n"
        + "return { expanded: document.getElementById('btn-toolbar-more').getAttribute('aria-expanded'), display: getComputedStyle(menu).display, hidden: menu.getAttribute('aria-hidden'), inert: menu.inert, left: box.left, right: box.right, viewport: window.innerWidth, titleButton: item('btn-doc-title-menu'), original: item('btn-original-pdf'), theme: item('btn-theme'), settings: item('btn-settings') };\n"
        + "})()");
      assert.equal(menu.expanded, "true", width + "px: More control opens the menu");
      assert.notEqual(menu.display, "none", width + "px: menu items become visible");
      assert.equal(menu.hidden, "false", width + "px: open menu is exposed to accessibility APIs");
      assert.equal(menu.inert, false, width + "px: open menu is reachable");
      assert.ok(menu.left >= 0 && menu.right <= menu.viewport, width + "px: menu stays within the viewport");
      assert.notEqual(menu.original.display, "none", width + "px: original PDF lives in the menu");
      assert.notEqual(menu.theme.display, "none", width + "px: theme lives in the menu");
      assert.notEqual(menu.settings.display, "none", width + "px: settings live in the menu");
      if (expectTitleEntry) {
        assert.notEqual(menu.titleButton.display, "none", width + "px: filename entry covers the hidden title");
        assert.ok(menu.titleButton.text.length > 60, width + "px: filename entry carries the full document name");
      } else {
        assert.equal(menu.titleButton.display, "none", width + "px: no duplicate filename entry while the title is visible");
      }
      await evaluate("document.getElementById('btn-toolbar-more').click()");
    }

    // 5. Picking the filename from 更多 hands the popover over to the More seat.
    await resize(320);
    const fromMenu = await evaluate("(() => {\n"
      + "document.getElementById('btn-toolbar-more').click();\n"
      + "document.getElementById('btn-doc-title-menu').click();\n"
      + "const pop = document.getElementById('doc-title-popover');\n"
      + "const box = pop.getBoundingClientRect();\n"
      + "const more = document.getElementById('btn-toolbar-more').getBoundingClientRect();\n"
      + "return { menuOpen: document.getElementById('toolbar-more-menu').classList.contains('is-open'), hidden: pop.hidden, left: box.left, right: box.right, width: box.width, viewport: window.innerWidth, moreCenter: (more.left + more.right) / 2, popoverCenter: (box.left + box.right) / 2, text: pop.textContent };\n"
      + "})()");
    assert.equal(fromMenu.menuOpen, false, "picking the filename closes the menu");
    assert.equal(fromMenu.hidden, false, "full filename entry opens its detail popover");
    assert.ok(fromMenu.left >= 0 && fromMenu.right <= fromMenu.viewport, "full filename popover stays within the narrow viewport");
    assert.ok(fromMenu.text.endsWith("2026.pdf"), "popover contains the complete filename");
    // Clamping is allowed to pull the popover inward, but never further than it must.
    const expectedCenter = Math.min(
      Math.max(fromMenu.moreCenter, 8 + fromMenu.width / 2),
      fromMenu.viewport - 8 - fromMenu.width / 2,
    );
    assert.ok(
      Math.abs(fromMenu.popoverCenter - expectedCenter) <= 8,
      "popover re-anchors on the More seat after the menu closes",
    );
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

// The settings card is its own scroll container, so a short window used to push
// 取消 / 保存 out of view with no way to reach them but scrolling the dialog.
test("modal action row stays pinned while the card scrolls", () => {
  const block = selector => {
    const match = stylesCss.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*\\}"));
    assert.ok(match, selector + " has a style block");
    return match[0];
  };
  assert.match(block(".modal-card"), /overflow-y:\s*(auto|scroll)/, "the card owns the scroll");
  const actions = block(".modal-actions");
  assert.match(actions, /position:\s*sticky/, "the action row is pinned inside the card");
  assert.match(actions, /bottom:\s*0/, "the action row sticks to the bottom edge");
});
