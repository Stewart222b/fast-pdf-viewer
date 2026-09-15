// Real Chrome/Edge regression runner for the unpacked browser extension.
// CHROME_PATH selects one executable; otherwise every installed default below is tested.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_DIR = path.join(ROOT, "dist", "browser-extension");
const SAMPLE_PDF = path.join(ROOT, "samples", "demo.pdf");
const TIMEOUT_MS = 20_000;
const DEFAULT_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error?.message) return String(error.message);
  return typeof error === "string" ? error : JSON.stringify(error);
}

function deadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function exists(file) {
  try {
    await access(file, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function executable(file) {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), sleep(1_500).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(500)]);
}

function capture(stream, limit = 16_000) {
  let value = "";
  stream?.on("data", chunk => {
    value = (value + chunk.toString()).slice(-limit);
  });
  return () => value;
}

function firstJsonLine(child, stderr) {
  return deadline(new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", chunk => {
      text += chunk.toString();
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(text.slice(0, newline)));
      } catch (error) {
        reject(new Error(`browser server returned invalid JSON: ${errorMessage(error)}`));
      }
    });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(
      `browser server exited with code ${code}: ${stderr().trim() || "no stderr"}`,
    )));
  }), 15_000, "browser server startup");
}

function devtoolsEndpoint(child, stderr) {
  return deadline(new Promise((resolve, reject) => {
    let text = "";
    child.stderr.on("data", chunk => {
      text = (text + chunk.toString()).slice(-32_000);
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(
      `browser exited before opening DevTools (code ${code}): ${stderr().trim() || "no stderr"}`,
    )));
  }), 15_000, "browser startup");
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${options?.method || "GET"} ${url} returned ${response.status}`);
  return response.json();
}

class CdpPage {
  constructor(webSocketDebuggerUrl) {
    this.socket = new WebSocket(webSocketDebuggerUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.requests = new Map();
    this.opened = deadline(new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
    }), 10_000, "CDP connection");
    this.socket.addEventListener("message", event => this.#message(event));
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP websocket closed"));
      this.pending.clear();
    });
  }

  #message(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter?.resolve(message.result);
      return;
    }
    if (message.method === "Network.requestWillBeSent") {
      this.requests.set(message.params.requestId, message.params.request.url);
    }
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params.exceptionDetails;
      this.events.push({
        type: "exception",
        text: detail.exception?.description || detail.text || "runtime exception",
      });
    } else if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params.type)) {
      this.events.push({
        type: "console",
        text: message.params.args.map(arg => arg.value ?? arg.description ?? "").join(" "),
      });
    } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      this.events.push({ type: "log", text: message.params.entry.text });
    } else if (message.method === "Network.loadingFailed") {
      this.events.push({
        type: "network",
        url: this.requests.get(message.params.requestId) || "",
        text: message.params.errorText || message.params.blockedReason || "loading failed",
        canceled: Boolean(message.params.canceled),
      });
    }
  }

  async send(method, params = {}) {
    await this.opened;
    const id = ++this.nextId;
    return deadline(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    }), TIMEOUT_MS, `CDP ${method}`);
  }

  async enable() {
    await Promise.all([
      this.send("Page.enable"),
      this.send("Runtime.enable"),
      this.send("DOM.enable"),
      this.send("Log.enable"),
      this.send("Network.enable"),
    ]);
    try {
      await this.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch {
      // --window-size still applies on browsers that reject this override.
    }
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async navigate(url) {
    const result = await this.send("Page.navigate", { url });
    if (result.errorText) throw new Error(`navigation to ${url} failed: ${result.errorText}`);
    await this.until("document.readyState === 'complete'", 15_000);
  }

  async until(expression, timeout = TIMEOUT_MS) {
    const started = Date.now();
    let lastError = "";
    while (Date.now() - started < timeout) {
      try {
        if (await this.evaluate(expression)) return;
      } catch (error) {
        lastError = errorMessage(error);
      }
      await sleep(40);
    }
    const eventText = this.events.slice(-8).map(event => `${event.type}: ${event.text}`).join("; ");
    throw new Error(`timed out waiting for ${expression}${lastError ? `; last error: ${lastError}` : ""}${eventText ? `; events: ${eventText}` : ""}`);
  }

  close() {
    this.socket.close();
  }
}

class CdpPipe {
  constructor(incoming, outgoing) {
    this.incoming = incoming;
    this.outgoing = outgoing;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
    incoming.setEncoding("utf8");
    incoming.on("data", chunk => this.#onData(chunk));
    incoming.on("error", error => this.#failAll(error));
    incoming.on("close", () => this.#failAll(new Error("CDP pipe closed")));
  }

  #onData(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf("\0")) !== -1) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!raw) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!message.id) continue;
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter?.resolve(message.result);
    }
  }

  #failAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return deadline(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.outgoing.write(`${JSON.stringify({ id, method, params })}\0`);
    }), 8_000, `pipe CDP ${method}`);
  }
}

export function extensionIdFromLoadUnpacked(result) {
  return /^[a-p]{32}$/.test(result?.id || "") ? result.id : null;
}

async function loadUnpackedViaPipe(pipe) {
  if (!pipe) return null;
  try {
    return extensionIdFromLoadUnpacked(await pipe.send("Extensions.loadUnpacked", { path: EXTENSION_DIR }));
  } catch {
    return null;
  }
}

async function newPage(httpBase, url = "about:blank") {
  const target = await jsonRequest(`${httpBase}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const page = new CdpPage(target.webSocketDebuggerUrl);
  await page.enable();
  return page;
}

async function connectListedTarget(httpBase, targetId) {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    const targets = await jsonRequest(`${httpBase}/json/list`);
    const target = targets.find(item => item.id === targetId && item.webSocketDebuggerUrl);
    if (target) {
      const page = new CdpPage(target.webSocketDebuggerUrl);
      await page.enable();
      return page;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for CDP target ${targetId}`);
}

async function openExtensionPage(httpBase, url, pipe) {
  try {
    const page = await newPage(httpBase, url);
    const href = await page.evaluate("location.href").catch(() => "");
    if (href.startsWith("chrome-extension://")) return page;
    page.close();
  } catch {
    // Chrome 152 can refuse /json/new or Page.navigate onto chrome-extension://.
  }
  if (pipe) {
    try {
      const created = await pipe.send("Target.createTarget", { url });
      if (created?.targetId) return await connectListedTarget(httpBase, created.targetId);
    } catch {
      // Fall through to a blank-tab navigation, which still works on Edge.
    }
  }
  const page = await newPage(httpBase);
  await page.navigate(url);
  return page;
}

export function pickUnpackedExtensionTarget(targets = []) {
  const workers = targets.filter(
    target => target?.type === "service_worker" || target?.type === "background_page",
  );
  const preferred = workers.find(target => /\/background\.js(?:\?|#|$)/.test(target.url || ""));
  const match = preferred?.url?.match(/^chrome-extension:\/\/([a-p]{32})\//);
  return match ? { id: match[1], source: preferred.type, url: preferred.url } : null;
}

export function matchInstalledExtension(items = []) {
  return items.find(item =>
    (item.name === "速览" || item.name === "Fast PDF Viewer") && /^[a-p]{32}$/.test(item.id),
  ) ?? null;
}

async function extensionIdFromTargets(httpBase) {
  return pickUnpackedExtensionTarget(await jsonRequest(`${httpBase}/json/list`));
}

async function extensionIdFromPage(httpBase) {
  const page = await newPage(httpBase);
  try {
    await page.navigate("chrome://extensions/");
    await page.until("document.querySelector('extensions-manager')?.shadowRoot", 8_000);
    const installed = await page.evaluate(`(() => {
      const found = [];
      const walk = root => {
        for (const element of root.querySelectorAll('*')) {
          if (element.localName === 'extensions-item') {
            const data = element.data || element.extensionInfo || {};
            found.push({
              id: data.id || element.getAttribute('id') || element.id || '',
              name: data.name || element.shadowRoot?.querySelector('#name')?.textContent?.trim() || '',
            });
          }
          if (element.shadowRoot) walk(element.shadowRoot);
        }
      };
      walk(document);
      return found;
    })()`);
    const match = matchInstalledExtension(installed);
    return { match: match ? { id: match.id, source: "chrome://extensions" } : null, installed };
  } catch (error) {
    return { match: null, installed: [], error: errorMessage(error) };
  } finally {
    page.close();
  }
}

async function findExtension(httpBase, preferredId) {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    const found = await extensionIdFromTargets(httpBase);
    if (found && (!preferredId || found.id === preferredId)) {
      return { ...found, inventory: [] };
    }
    await sleep(100);
  }
  if (preferredId) return { id: preferredId, source: "Extensions.loadUnpacked", inventory: [] };
  const fallback = await extensionIdFromPage(httpBase);
  if (fallback.match) return { ...fallback.match, inventory: fallback.installed };
  const detail = fallback.error
    ? `chrome://extensions inspection failed: ${fallback.error}`
    : `chrome://extensions listed: ${JSON.stringify(fallback.installed)}`;
  throw new Error(
    `unpacked extension did not load from ${EXTENSION_DIR}; no extension service worker target was created and ${detail}. ` +
    "This Chromium build may have disabled --load-extension; the runner also tries CDP Extensions.loadUnpacked.",
  );
}

function relevantPageErrors(page, extensionOrigin) {
  return page.events.filter(event => {
    if (event.type === "network") {
      return !event.canceled && event.url.startsWith(extensionOrigin);
    }
    return /content security policy|refused to|failed to load|module script|uncaught|syntaxerror|typeerror|referenceerror/i.test(event.text);
  });
}

async function revealFirstPage(page) {
  await page.evaluate(`(() => {
    const wrap = document.getElementById("viewer-wrap");
    if (wrap && wrap.clientHeight < 100) {
      wrap.style.minHeight = "800px";
      wrap.style.height = "800px";
    }
    document.querySelector('[data-page-number="1"]')?.scrollIntoView({ block: "start" });
    wrap?.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  })()`);
}

async function waitForFirstRenderedPage(page) {
  const started = Date.now();
  let layout = null;
  let kickedCompositor = false;
  while (Date.now() - started < TIMEOUT_MS) {
    layout = await page.evaluate(`({
      wrapH: document.getElementById("viewer-wrap")?.clientHeight || 0,
      wrapW: document.getElementById("viewer-wrap")?.clientWidth || 0,
      zoom: document.querySelector('[data-page-number="1"]')?.dataset.renderedZoom || "",
      canvas: document.querySelector('[data-page-number="1"] canvas')?.width || 0,
      pageH: document.querySelector('[data-page-number="1"]')?.offsetHeight || 0,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
    })`);
    if (layout.zoom) return layout;
    if (layout.wrapH < 100) await revealFirstPage(page);
    if (!kickedCompositor && Date.now() - started > 1_000) {
      kickedCompositor = true;
      await page.send("Page.captureScreenshot", { format: "png" }).catch(() => {});
      await revealFirstPage(page);
    }
    await sleep(40);
  }
  const eventText = page.events.map(event => `${event.type}: ${event.text}`).slice(-12).join("; ");
  throw new Error(
    `timed out waiting for first page render; layout=${JSON.stringify(layout)}` +
    (eventText ? `; events: ${eventText}` : ""),
  );
}

async function testStandalone(page, extensionId) {
  const origin = `chrome-extension://${extensionId}`;
  const readerUrl = `${origin}/web/index.html`;
  const current = await page.evaluate("location.href").catch(() => "");
  if (!current.startsWith(readerUrl)) await page.navigate(readerUrl);
  await page.until(`document.body?.dataset.platform === 'extension' && document.getElementById('btn-open')`);

  const capabilities = await page.evaluate(`({
    runtimeId: chrome?.runtime?.id || null,
    permissions: {
      object: typeof chrome?.permissions === 'object',
      contains: typeof chrome?.permissions?.contains === 'function',
      request: typeof chrome?.permissions?.request === 'function',
    },
    mimeHandler: {
      object: typeof chrome?.mimeHandler === 'object',
      getStreamInfo: typeof chrome?.mimeHandler?.getStreamInfo === 'function',
      abortAndFallbackToNativeHandler: typeof chrome?.mimeHandler?.abortAndFallbackToNativeHandler === 'function',
      setMimeHandlerOptions: typeof chrome?.mimeHandler?.setMimeHandlerOptions === 'function',
    },
  })`);
  assert.equal(capabilities.runtimeId, extensionId, "reader must run in the discovered extension");

  const documentNode = await page.send("DOM.getDocument", { depth: -1, pierce: true });
  const input = await page.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: "input[type=file]",
  });
  assert.ok(input.nodeId, "reader must create its local PDF file input");
  await page.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [SAMPLE_PDF] });
  await page.until(`Number(document.getElementById('page-count')?.textContent) === 5`);
  await revealFirstPage(page);
  await waitForFirstRenderedPage(page);

  const pdf = await page.evaluate(`({
    pages: document.querySelectorAll('.page').length,
    rendered: [...document.querySelectorAll('.page')].filter(item => item.dataset.renderedZoom).length,
    currentPage: Number(document.getElementById('page-input').value),
    title: document.getElementById('doc-title').textContent,
  })`);
  assert.equal(pdf.pages, 5);
  assert.ok(pdf.rendered > 0, "at least one PDF page must render");
  assert.equal(pdf.currentPage, 1);
  assert.equal(pdf.title, "demo.pdf");

  await page.evaluate(`(() => {
    const input = document.getElementById('search-input');
    input.value = 'translation';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.until(`document.querySelectorAll('.search-hit').length > 1 && !document.getElementById('search-next').disabled`);
  const before = await page.evaluate(`({
    count: document.getElementById('search-count').textContent,
    active: document.querySelector('.search-hit.active')?.textContent || '',
    page: Number(document.getElementById('page-input').value),
    hits: document.querySelectorAll('.search-hit').length,
  })`);
  await page.evaluate("document.getElementById('search-next').click()");
  const nextCount = `document.getElementById('search-count').textContent.trim().startsWith('2 /')`;
  try {
    await page.until(nextCount, 8_000);
  } catch {
    await page.evaluate("document.getElementById('search-next').click()");
    await page.until(nextCount);
  }
  const after = await page.evaluate(`({
    count: document.getElementById('search-count').textContent,
    active: document.querySelector('.search-hit.active')?.textContent || '',
    page: Number(document.getElementById('page-input').value),
  })`);
  assert.notEqual(after.active, before.active, "next search result must become active");
  assert.match(after.count.trim(), /^2 \/ \d+/);

  const errors = relevantPageErrors(page, origin);
  assert.deepEqual(errors, [], `extension reader CSP/import errors: ${JSON.stringify(errors)}`);
  return {
    url: readerUrl,
    cspImports: "pass",
    pdf,
    search: { hits: before.hits, from: before.count.trim(), to: after.count.trim(), page: after.page },
    capabilities,
  };
}

async function testLegacyRemote(page, extensionId, fixtures) {
  const originPattern = `http://127.0.0.1:${fixtures.port}/*`;
  const capabilities = await page.evaluate(`({
    contains: typeof chrome?.permissions?.contains === 'function',
    request: typeof chrome?.permissions?.request === 'function',
  })`);
  if (!capabilities.contains) {
    return { status: "skip", reason: "chrome.permissions.contains is unavailable", capabilities };
  }
  const granted = await page.evaluate(
    `chrome.permissions.contains({origins:[${JSON.stringify(originPattern)}]})`,
  );
  if (!granted) {
    return {
      status: "skip",
      reason: `fresh profile has no optional host permission for ${originPattern}; no permission was spoofed or requested without a user gesture`,
      capabilities,
    };
  }

  const response = await fetch(`http://127.0.0.1:${fixtures.port}/api/browser/set-opened`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fixtures.small }),
  });
  assert.equal(response.ok, true, "fixture server must accept the remote PDF");
  const opened = await response.json();
  const remoteUrl = `http://127.0.0.1:${fixtures.port}/opened/${encodeURIComponent(opened.id)}.pdf`;
  const readerUrl = `chrome-extension://${extensionId}/web/index.html?file=${encodeURIComponent(remoteUrl)}`;
  await page.navigate(readerUrl);
  await page.until(`Number(document.getElementById('page-count')?.textContent) === 5`);
  await revealFirstPage(page);
  await waitForFirstRenderedPage(page);
  return { status: "pass", pages: 5, url: remoteUrl, capabilities };
}

async function runBrowser(browserPath, fixtures) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "fast-pdf-extension-"));
  const args = [
    /Microsoft Edge/i.test(browserPath) ? "--headless=new" : "--headless=old",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--window-size=1280,900",
    "--force-device-scale-factor=1",
    "about:blank",
  ];
  const browser = spawn(browserPath, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const stderr = capture(browser.stderr);
  const pipe = browser.stdio[3] && browser.stdio[4]
    ? new CdpPipe(browser.stdio[4], browser.stdio[3])
    : null;
  let page;
  try {
    const endpoint = await devtoolsEndpoint(browser, stderr);
    const httpBase = `http://${new URL(endpoint).host}`;
    const version = await jsonRequest(`${httpBase}/json/version`);
    const loadedId = await loadUnpackedViaPipe(pipe);
    const extension = await findExtension(httpBase, loadedId);
    page = await openExtensionPage(httpBase, `chrome-extension://${extension.id}/web/index.html`, pipe);
    const standalone = await testStandalone(page, extension.id);
    const legacyRemote = await testLegacyRemote(page, extension.id, fixtures);
    return {
      ok: true,
      executable: browserPath,
      product: version.Browser || "unknown",
      extensionId: extension.id,
      extensionIdSource: extension.source,
      standalone,
      legacyRemote,
    };
  } catch (error) {
    let product = "unknown";
    const endpointMatch = stderr().match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (endpointMatch) {
      try {
        product = (await jsonRequest(`http://${new URL(endpointMatch[1]).host}/json/version`)).Browser || product;
      } catch {
        // Keep the original, more useful failure.
      }
    }
    return {
      ok: false,
      executable: browserPath,
      product,
      error: errorMessage(error),
      browserStderr: stderr().trim().split("\n").slice(-6),
    };
  } finally {
    page?.close();
    await stop(browser);
    await rm(profile, { recursive: true, force: true });
  }
}

async function browserPaths() {
  if (process.env.CHROME_PATH) return [process.env.CHROME_PATH];
  const found = [];
  for (const candidate of DEFAULT_BROWSERS) {
    if (await executable(candidate)) found.push(candidate);
  }
  return [...new Set(found)];
}

async function main() {
  const report = { ok: false, browsers: [] };
  let server;
  try {
    if (!await exists(path.join(EXTENSION_DIR, "manifest.json"))) {
      throw new Error(`extension build is missing: ${path.join(EXTENSION_DIR, "manifest.json")}`);
    }
    JSON.parse(await readFile(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
    assert.equal(await exists(SAMPLE_PDF), true, `fixture is missing: ${SAMPLE_PDF}`);
    const paths = await browserPaths();
    if (!paths.length) {
      throw new Error("no supported Chrome/Edge executable found; set CHROME_PATH to the browser executable");
    }

    server = spawn("python3", ["tests/browser_server.py"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const serverStderr = capture(server.stderr);
    const fixtures = await firstJsonLine(server, serverStderr);
    for (const browserPath of paths) report.browsers.push(await runBrowser(browserPath, fixtures));
    report.ok = report.browsers.length > 0 && report.browsers.every(result => result.ok);
  } catch (error) {
    report.error = errorMessage(error);
  } finally {
    await stop(server);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
