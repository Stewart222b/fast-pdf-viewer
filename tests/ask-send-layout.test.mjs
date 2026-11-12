import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const indexHtml = readFileSync(path.join(root, "web/index.html"), "utf8");
const stylesCss = readFileSync(path.join(root, "web/styles.css"), "utf8");

function edgeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.platform === "win32" ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" : "",
    process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : "",
    ...(process.platform === "linux" ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"] : []),
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

function makeFixture() {
  const sprite = indexHtml.match(/<svg class="icon-sprite"[\s\S]*?<\/svg>/)?.[0];
  const compose = indexHtml.match(/<div class="ask-compose">[\s\S]*?<\/div>\s*<div class="ask-foot">/)?.[0];
  assert.ok(sprite && compose, "ask compose markup is available");
  const composeOnly = compose.replace(/\s*<div class="ask-foot">$/, "");
  return `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/web/styles.css">
<style>body{margin:24px;background:var(--sidebar-bg);width:320px}</style>
</head><body>${sprite}${composeOnly}
<script>
const submit = document.getElementById("ask-submit");
const stop = document.getElementById("ask-stop");
let clicks = 0;
submit.addEventListener("mousedown", event => event.preventDefault());
submit.addEventListener("click", () => { clicks += 1; });
window.__askSendState = () => ({
  submitDisplay: getComputedStyle(submit).display,
  stopDisplay: getComputedStyle(stop).display,
  clicks,
});
window.__askComposeLayout = () => {
  const input = document.getElementById("ask-input");
  const compose = document.querySelector(".ask-compose");
  const composeStyle = getComputedStyle(compose);
  const inputStyle = getComputedStyle(input);
  input.style.height = "auto";
  const emptyHeight = input.scrollHeight;
  input.value = "第一行\\n第二行\\n第三行\\n第四行\\n第五行";
  input.style.height = "auto";
  const grownHeight = input.scrollHeight;
  input.value = Array.from({ length: 40 }, (_, i) => "很长的一行 " + i).join("\\n");
  input.style.height = "auto";
  const capped = Math.min(input.scrollHeight, parseFloat(inputStyle.maxHeight));
  input.style.height = capped + "px";
  const more = document.getElementById("ask-more");
  more.hidden = false;
  const row = document.querySelector(".ask-compose-actions").getBoundingClientRect();
  const field = input.getBoundingClientRect();
  const left = more.getBoundingClientRect();
  const right = document.querySelector(".ask-send-slot").getBoundingClientRect();
  const moreButton = document.getElementById("btn-ask-more").getBoundingClientRect();
  const effortButton = document.getElementById("btn-ask-effort").getBoundingClientRect();
  return {
    fieldLeft: field.left, fieldRight: field.right, fieldBottom: field.bottom,
    rowLeft: row.left, rowRight: row.right, rowTop: row.top,
    moreLeft: left.left, sendRight: right.right,
    moreBottom: moreButton.bottom, effortBottom: effortButton.bottom, sendBottom: right.bottom,
    resize: inputStyle.resize,
    paddingTop: composeStyle.paddingTop,
    paddingBottom: composeStyle.paddingBottom,
    emptyHeight,
    grownHeight,
    capped,
    maxHeight: parseFloat(inputStyle.maxHeight),
    hasLabel: Boolean(document.querySelector(".ask-label")),
  };
};
</script></body></html>`;
}

const edgePath = edgeExecutable();
test("hidden ask stop does not cover the send circle", {
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
  const profile = mkdtempSync(path.join(tmpdir(), "fpv-ask-send-edge-"));
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
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: "http://127.0.0.1:" + serverPort + "/fixture.html" });
    await waitFor(() => evaluate("document.readyState === 'complete' && typeof window.__askSendState === 'function'"), "ask send fixture");
    const idle = await evaluate("window.__askSendState()");
    assert.notEqual(idle.submitDisplay, "none");
    assert.equal(idle.stopDisplay, "none");
    const layout = await evaluate("window.__askComposeLayout()");
    assert.equal(layout.resize, "none");
    assert.equal(layout.hasLabel, false);
    assert.equal(layout.paddingTop, layout.paddingBottom);
    assert.ok(layout.emptyHeight <= 34, "empty input stays one line, got " + layout.emptyHeight);
    assert.ok(layout.grownHeight > layout.emptyHeight, "wrapped input grows");
    assert.equal(layout.capped, layout.maxHeight);
    assert.ok(Math.abs(layout.fieldLeft - layout.rowLeft) < 1, "text uses the full toolbar width on the left");
    assert.ok(Math.abs(layout.fieldRight - layout.rowRight) < 1, "no full-height reserved column on the right");
    assert.ok(layout.rowTop >= layout.fieldBottom, "toolbar sits below long text");
    assert.ok(Math.abs(layout.moreLeft - layout.rowLeft) < 1, "more sits at the bottom left");
    assert.ok(Math.abs(layout.sendRight - layout.rowRight) < 1, "send sits at the bottom right");
    assert.ok(Math.abs(layout.moreBottom - layout.sendBottom) < 1, "more aligns with the bottom of send");
    assert.ok(Math.abs(layout.effortBottom - layout.sendBottom) < 1, "effort aligns with the bottom of send");
    const afterClick = await evaluate(`(() => {
      const submit = document.getElementById("ask-submit");
      submit.disabled = false;
      submit.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const stop = document.getElementById("ask-stop");
      submit.hidden = true;
      stop.hidden = false;
      return window.__askSendState();
    })()`);
    assert.equal(afterClick.clicks, 1);
    assert.equal(afterClick.submitDisplay, "none");
    assert.notEqual(afterClick.stopDisplay, "none");
  } finally {
    socket?.close();
    if (edge) {
      edge.kill();
      await new Promise(resolve => {
        const done = () => resolve();
        edge.once("exit", done);
        setTimeout(done, 1000);
      });
    }
    await new Promise(resolve => server.close(resolve));
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may keep the profile lock on Windows */ }
  }
});
