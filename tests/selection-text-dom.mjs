import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = fileURLToPath(new URL("../", import.meta.url));
const jsRoot = path.join(root, "web", "js");
const html = `<!doctype html>
<meta charset="utf-8">
<title>Selection text DOM regression</title>
<script type="module">
  window.runSelectionTextCases = async () => {
    const { normalizePdfSelectionText } = await import("/js/selection-text.js");
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:20px;top:20px;font:20px monospace;line-height:24px";
    document.body.append(host);

    const partial = document.createTextNode("abcDEFghi");
    host.append(partial);
    const sameRange = document.createRange();
    sameRange.setStart(partial, 3);
    sameRange.setEnd(partial, 6);
    const sameNode = normalizePdfSelectionText(sameRange.toString(), sameRange);

    host.replaceChildren();
    const left = document.createElement("span");
    left.textContent = "alpha ";
    const right = document.createElement("span");
    right.textContent = "beta";
    host.append(left, right);
    const crossRange = document.createRange();
    crossRange.setStart(left.firstChild, 2);
    crossRange.setEnd(right.firstChild, 3);
    const crossSpan = normalizePdfSelectionText(crossRange.toString(), crossRange);

    host.replaceChildren();
    const first = document.createElement("div");
    first.textContent = "first line";
    const second = document.createElement("div");
    second.textContent = "second line";
    host.append(first, second);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.setBaseAndExtent(second.firstChild, 6, first.firstChild, 6);
    const backwardRange = selection.getRangeAt(0);
    const backward = normalizePdfSelectionText(selection.toString(), backwardRange);
    const reverseDirection = selection.anchorNode === second.firstChild &&
      selection.focusNode === first.firstChild;

    host.remove();
    selection.removeAllRanges();
    return { sameNode, crossSpan, backward, reverseDirection };
  };
  window.__selectionTextTest = window.runSelectionTextCases().then((result) => {
    const expected = {
      sameNode: "DEF",
      crossSpan: "pha bet",
      backward: "line second",
      reverseDirection: true,
    };
    const passed = Object.keys(expected).every((key) => result[key] === expected[key]);
    document.body.dataset.testStatus = passed ? "passed" : "failed";
    document.body.textContent = JSON.stringify({ passed, result });
    if (!passed) throw new Error("Unexpected selection text result");
    return result;
  }).catch((error) => {
    document.body.dataset.testStatus = "failed";
    document.body.textContent = error.stack || String(error);
    throw error;
  });
</script>`;

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  if (pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (pathname.startsWith("/js/")) {
    const filePath = path.resolve(jsRoot, pathname.slice("/js/".length));
    if (!filePath.startsWith(`${jsRoot}${path.sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const source = await readFile(filePath);
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(source);
    } catch {
      response.writeHead(404);
      response.end();
    }
    return;
  }
  response.writeHead(404);
  response.end();
});

const edgePath = process.env.CHROME_PATH ||
  (process.platform === "win32"
    ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    : "/usr/bin/chromium");
const profile = await mkdtemp(path.join(os.tmpdir(), "fast-pdf-selection-dom-"));
let browser;
let socket;
let stage = "starting Edge";
let browserOutput = "";
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const appUrl = `http://127.0.0.1:${server.address().port}/`;

if (process.argv.includes("--serve")) {
  console.log(appUrl);
} else {
try {
  browser = spawn(edgePath, [
    "--headless=new",
    "--no-first-run",
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${profile}`,
    "--window-size=1000,800",
    `--app=${appUrl}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Edge startup timed out: ${stderr}`)), 15000);
    browser.stderr.on("data", (chunk) => {
      stderr += chunk;
      browserOutput = stderr;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    browser.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    browser.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Edge exited before DevTools started (${code}): ${stderr}`));
    });
  });

  const host = new URL(endpoint).host;
  let targets;
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://${host}/json/list`);
      targets = await response.json();
      break;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  if (!targets) throw new Error(`Cannot read Edge DevTools targets: ${lastError}`);
  const page = targets.find((target) => target.url === appUrl) || targets.find((target) => target.type === "page");
  if (!page) throw new Error("Edge did not open the selection test page");

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let requestId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      if (message.method === "Runtime.exceptionThrown") {
        browserOutput += `\n${message.params.exceptionDetails.text}`;
      }
      if (message.method === "Inspector.targetCrashed") {
        browserOutput += `\nRenderer crashed: ${JSON.stringify(message.params)}`;
      }
      return;
    }
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request?.timeout);
    if (message.error) request?.reject(new Error(`${request.method}: ${JSON.stringify(message.error)}`));
    else request?.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 5000);
    pending.set(id, { resolve, reject, method, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };

  stage = "enabling Runtime";
  await send("Runtime.enable");
  const start = Date.now();
  stage = "waiting for test module";
  while (Date.now() - start < 10000 && !(await evaluate("typeof window.runSelectionTextCases === 'function'"))) {
    await sleep(50);
  }
  stage = "running range cases";
  const actual = await evaluate("window.runSelectionTextCases()");
  assert.deepEqual(actual, {
    sameNode: "DEF",
    crossSpan: "pha bet",
    backward: "line second",
    reverseDirection: true,
  });
  console.log(JSON.stringify(actual));
} catch (error) {
  console.error(`${stage}: ${error.message}\n${browserOutput}`);
  throw error;
} finally {
  socket?.close();
  browser?.kill();
  await new Promise((resolve) => server.close(resolve));
  await sleep(250);
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
}
}
