import { ViewHistory } from "./history.js";
import { createPlatform } from "./platform/index.js";
import {
  loadReadingPosition,
  readingFingerprint,
  saveReadingPosition,
} from "./reading-position.js";
import { highlightSnippet, searchDocument } from "./search.js";
import { loadSettings, saveSettings } from "./settings.js";
import { wireModelPicker } from "./model-picker.js";
import { MAX_TRANSLATE_CHARS, translateText } from "./translate.js";
import { PasswordResponses } from "../vendor/pdfjs/build/pdf.mjs";
import { PdfViewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const platform = createPlatform();

const history = new ViewHistory();
let passwordDialog = null;

function requestPdfPassword(reason) {
  if (passwordDialog) return passwordDialog;
  const modal = $("pdf-password-modal");
  const input = $("pdf-password-input");
  const error = $("pdf-password-error");
  const submit = $("pdf-password-submit");
  const cancel = $("pdf-password-cancel");
  passwordDialog = new Promise((resolve, reject) => {
    const cleanup = () => {
      modal.hidden = true;
      submit.removeEventListener("click", onSubmit);
      cancel.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      passwordDialog = null;
    };
    const onSubmit = () => {
      cleanup();
      resolve(input.value);
    };
    const onCancel = () => {
      cleanup();
      reject(new Error("已取消输入密码"));
    };
    const onKey = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onSubmit();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    error.hidden = reason !== PasswordResponses.INCORRECT_PASSWORD;
    error.textContent = reason === PasswordResponses.INCORRECT_PASSWORD ? "密码错误，请重试。" : "";
    input.value = "";
    modal.hidden = false;
    input.focus();
    submit.addEventListener("click", onSubmit);
    cancel.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
  });
  return passwordDialog;
}

const viewer = new PdfViewer({
  pagesEl: $("pages"),
  wrapEl: $("viewer-wrap"),
  history,
  onState: syncToolbar,
  onScrollPosition: scheduleSaveReadingPosition,
  onIndex: refreshIndexedSearch,
  onPassword: requestPdfPassword,
});
if (globalThis.__PDF_BENCH__) globalThis.__pdfViewer = viewer;

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = "application/pdf,.pdf";
fileInput.hidden = true;
document.body.appendChild(fileInput);

let settings = loadSettings();
let searchHits = [];
let openGeneration = 0;
let searchGeneration = 0;
let indexRefreshTimer = 0;
let objectUrl = null;
let currentFingerprint = "";
let positionSaveTimer = 0;
let translateAbort = null;
let translateRequestId = 0;
let bubbleSelectionId = 0;

history.onChange(() => {
  $("btn-back").disabled = !history.canBack();
  $("btn-forward").disabled = !history.canForward();
});

function syncToolbar(state) {
  $("page-input").value = String(state.page || 1);
  $("page-count").textContent = String(viewer.pageCount || 0);
  $("doc-title").textContent = viewer.name || "未打开文件";
  $("drop-hint").classList.toggle("hidden", Boolean(viewer.pdf));
  if (!["page-width", "page-fit"].includes(String(state.zoom))) {
    const value = String(state.zoom);
    const select = $("zoom-select");
    if (![...select.options].some((opt) => opt.value === value)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = `${value}%`;
      select.appendChild(opt);
    }
    select.value = value;
  } else {
    $("zoom-select").value = String(state.zoom);
  }
  $("btn-back").disabled = !history.canBack();
  $("btn-forward").disabled = !history.canForward();
  const page = state.page || 1;
  $("btn-page-prev").disabled = !viewer.pdf || page <= 1;
  $("btn-page-next").disabled = !viewer.pdf || page >= viewer.pageCount;
  updateOutlineActive(page);
  scheduleSaveReadingPosition();
}

function stepPage(delta) {
  if (!viewer.pageCount) return;
  const next = Math.min(viewer.pageCount, Math.max(1, viewer.currentPage + delta));
  if (next === viewer.currentPage) return;
  viewer.goToPage(next, { push: true });
}

function scheduleSaveReadingPosition() {
  if (!currentFingerprint || !viewer.pdf) return;
  clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(() => {
    saveReadingPosition(currentFingerprint, viewer.getState());
  }, 400);
}

function flushReadingPosition() {
  if (!currentFingerprint || !viewer.pdf) return;
  clearTimeout(positionSaveTimer);
  positionSaveTimer = 0;
  saveReadingPosition(currentFingerprint, viewer.getState());
}

function updateOutlineActive(page) {
  const pane = $("outline-pane");
  let found = false;
  pane.querySelectorAll(".outline-item").forEach((btn) => {
    const match = Number(btn.dataset.page) === page;
    btn.classList.toggle("active", match);
    if (!match) return;
    found = true;
    let node = btn.closest(".outline-node");
    while (node) {
      const branch = node.querySelector(":scope > .outline-branch");
      const toggle = node.querySelector(":scope > .outline-row > .outline-toggle");
      if (branch) {
        branch.classList.add("expanded");
        toggle?.setAttribute("aria-expanded", "true");
      }
      node = node.parentElement?.closest(".outline-node");
    }
  });
  if (!found) return;
}

async function openSource(getSource) {
  const request = ++openGeneration;
  searchGeneration += 1;
  flushReadingPosition();
  clearTimeout(indexRefreshTimer);
  indexRefreshTimer = 0;
  clearTimeout(searchTimer);
  cancelTranslate();
  viewer.close();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  currentFingerprint = "";
  $("search-input").value = "";
  renderSearchList([], "");
  $("outline-pane").replaceChildren();
  hideBubble();
  try {
    const source = await getSource();
    if (request !== openGeneration) return;
    const opened = await viewer.open(source);
    if (!opened || request !== openGeneration) return;
    currentFingerprint = readingFingerprint(source);
    const saved = loadReadingPosition(currentFingerprint);
    if (saved) viewer.applyReadingPosition(saved);
    await renderOutline(request);
    if (request === openGeneration && $("search-input").value.trim()) {
      await runSearch($("search-input").value);
    }
  } catch (error) {
    if (request === openGeneration) {
      $("outline-pane").textContent = `打开失败：${error.message || error}`;
    }
  }
}

async function openFile(file) {
  return openSource(() => {
    objectUrl = URL.createObjectURL(file);
    return {
      url: objectUrl,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
    };
  });
}

async function openFromPlatform(meta) {
  return openSource(() => ({
    url: meta.url,
    name: meta.name,
    id: meta.id,
    path: meta.path,
  }));
}

async function renderOutline(request) {
  const pane = $("outline-pane");
  const outline = await viewer.getOutline();
  if (request !== openGeneration) return;
  const pdf = viewer.pdf;
  const generation = viewer.generation;
  if (!pdf || !outline?.length) {
    pane.replaceChildren();
    if (!outline?.length) {
      pane.innerHTML = '<div class="empty-side">这份 PDF 没有目录。</div>';
    }
    return;
  }
  pane.replaceChildren();
  const mount = (items, depth, container) => {
    for (const item of items) {
      const node = document.createElement("div");
      node.className = "outline-node";
      const row = document.createElement("div");
      row.className = "outline-row";
      const hasChildren = Boolean(item.items?.length);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "outline-toggle";
      toggle.setAttribute("aria-expanded", "false");
      toggle.hidden = !hasChildren;
      toggle.title = hasChildren ? "展开/折叠" : "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "outline-item";
      btn.style.paddingLeft = `${4 + depth * 12}px`;
      btn.textContent = item.title || "未命名";
      if (item.pageNumber) btn.dataset.page = String(item.pageNumber);
      btn.addEventListener("click", () => viewer.goToDest(item.dest, true));
      row.append(toggle, btn);
      node.append(row);
      if (hasChildren) {
        const branch = document.createElement("div");
        branch.className = "outline-branch";
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          const expanded = branch.classList.toggle("expanded");
          toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
        });
        mount(item.items, depth + 1, branch);
        node.append(branch);
      }
      container.appendChild(node);
    }
  };
  await attachOutlinePages(outline, { request, pdf, generation });
  if (request !== openGeneration || viewer.generation !== generation || viewer.pdf !== pdf) return;
  mount(outline, 0, pane);
  updateOutlineActive(viewer.currentPage);
}

async function attachOutlinePages(items, ctx) {
  const { pdf, request, generation } = ctx;
  if (!pdf) return;
  const stillValid = () =>
    request === openGeneration && viewer.generation === generation && viewer.pdf === pdf;
  for (const item of items) {
    if (!stillValid()) return;
    try {
      if (item.dest != null) {
        let explicit = item.dest;
        if (typeof explicit === "string") explicit = await pdf.getDestination(explicit);
        if (!stillValid()) return;
        const ref = explicit?.[0];
        if (ref != null) {
          const pageIndex = typeof ref === "object" ? await pdf.getPageIndex(ref) : Number(ref);
          if (!stillValid()) return;
          item.pageNumber = pageIndex + 1;
        }
      }
    } catch {
      /* skip */
    }
    if (item.items?.length) await attachOutlinePages(item.items, ctx);
  }
}

function renderSearchList(hits, query, start = Math.max(0, viewer.hitIndex - 50)) {
  searchHits = hits;
  const pane = $("search-pane");
  const count = $("search-count");
  pane.replaceChildren();
  $("search-prev").disabled = hits.length === 0;
  $("search-next").disabled = hits.length === 0;
  if (!query) {
    count.hidden = true;
    pane.innerHTML = '<div class="empty-side">输入关键词后，这里会列出全部命中。</div>';
    return;
  }
  count.hidden = false;
  if (!hits.length) {
    count.textContent = "0 条";
    pane.innerHTML = '<div class="empty-side">没有找到匹配。</div>';
    return;
  }
  count.textContent = `${viewer.hitIndex + 1} / ${hits.length}`;
  const end = Math.min(hits.length, start + 200);
  const moreButton = (label, nextStart) => {
    const button = document.createElement("button");
    button.className = "btn";
    button.textContent = label;
    button.addEventListener("click", () => renderSearchList(hits, query, nextStart));
    pane.appendChild(button);
  };
  if (start > 0) moreButton("上一组结果", Math.max(0, start - 200));
  hits.slice(start, end).forEach((hit, localIndex) => {
    const index = start + localIndex;
    const btn = document.createElement("button");
    btn.className = `search-hit${index === viewer.hitIndex ? " active" : ""}`;
    btn.innerHTML = `<div class="meta">第 ${hit.pageNumber} 页 · ${index + 1}/${hits.length}</div>
      <div class="snippet">${highlightSnippet(hit.snippet, query)}</div>`;
    btn.addEventListener("click", async () => {
      try {
        await viewer.jumpToHit(index, { push: true });
        if (searchHits === hits && $("search-input").value === query) renderSearchList(hits, query);
      } catch (error) {
        if (searchHits === hits) pane.textContent = `定位失败：${error.message || error}`;
      }
    });
    pane.appendChild(btn);
  });
  if (end < hits.length) moreButton("下一组结果", end);
}

function refreshIndexedSearch() {
  if (indexRefreshTimer) return;
  if ($("search-input").value.trim()) indexRefreshTimer = setTimeout(() => {
    indexRefreshTimer = 0;
    runSearch($("search-input").value, searchGeneration, false);
  }, 100);
}

async function runSearch(query, request = searchGeneration, jump = true) {
  const generation = viewer.generation;
  const current = () => request === searchGeneration && generation === viewer.generation;
  try {
    if (!current()) return;
    const searchStarted = globalThis.__PDF_BENCH__ ? performance.now() : 0;
    const hits = searchDocument(viewer.pageTexts, query);
    if (globalThis.__PDF_BENCH__) {
      globalThis.__pdfSearchBench = {
        searchDocumentMs: performance.now() - searchStarted,
        hitCount: hits.length,
        query,
      };
    }
    const unchanged = !jump && hits.length === searchHits.length && viewer.query === query;
    // Keep the result list independent of page rendering: showHits may await
    // jumpToHit → renderPage for the current target only.
    const shown = unchanged
      ? null
      : viewer.showHits(hits, query, jump ? 0 : Math.max(0, viewer.hitIndex), { jump });
    if (!current()) {
      await shown;
      return;
    }
    renderSearchList(unchanged ? searchHits : hits, query);
    if (globalThis.__PDF_BENCH__) {
      globalThis.__pdfSearchBench.resultListVisibleMs = performance.now() - searchStarted;
    }
    if (query && jump) selectSidebar("search");
    if (shown) await shown;
    if (!current()) return;
    if (globalThis.__PDF_BENCH__) {
      globalThis.__pdfSearchBench.firstJumpMs = performance.now() - searchStarted;
    }
    if (query) {
      if (viewer.indexError) {
        const warning = document.createElement("div");
        warning.className = "empty-side";
        warning.textContent = "部分页面索引失败，当前仅显示已读取结果。";
        $("search-pane").appendChild(warning);
      } else if (viewer.indexedPages < viewer.pageCount) {
        $("search-count").textContent += ` · 索引 ${viewer.indexedPages}/${viewer.pageCount}`;
      }
    }
  } catch (error) {
    if (current()) $("search-pane").textContent = `搜索失败：${error.message || error}`;
  }
}

function selectSidebar(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  $("outline-pane").classList.toggle("active", name === "outline");
  $("search-pane").classList.toggle("active", name === "search");
}

function setSidebarCollapsed(collapsed) {
  document.querySelector(".workspace").classList.toggle("sidebar-collapsed", collapsed);
  $("btn-sidebar").classList.toggle("active", !collapsed);
  $("btn-sidebar").setAttribute("aria-pressed", collapsed ? "false" : "true");
}

async function pickFile() {
  const picked = await platform.pickFile();
  if (picked) {
    await openFromPlatform(picked);
    return;
  }
  fileInput.click();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) await openFile(file);
});

$("btn-open").addEventListener("click", pickFile);
$("btn-sidebar").addEventListener("click", () => {
  setSidebarCollapsed(!document.querySelector(".workspace").classList.contains("sidebar-collapsed"));
});
setSidebarCollapsed(false);
$("btn-back").addEventListener("click", () => viewer.back());
$("btn-forward").addEventListener("click", () => viewer.forward());
$("btn-zoom-in").addEventListener("click", () => {
  $("zoom-select").value = viewer.bumpZoom(1);
});
$("btn-zoom-out").addEventListener("click", () => {
  $("zoom-select").value = viewer.bumpZoom(-1);
});
$("zoom-select").addEventListener("change", (event) => {
  viewer.setZoom(event.target.value);
});
$("btn-page-prev").addEventListener("click", () => stepPage(-1));
$("btn-page-next").addEventListener("click", () => stepPage(1));
$("page-input").addEventListener("change", (event) => {
  viewer.goToPage(Number(event.target.value), { push: true });
});
$("page-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    viewer.goToPage(Number(event.target.value), { push: true });
  }
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectSidebar(tab.dataset.tab));
});

let searchTimer = 0;
$("search-input").addEventListener("input", (event) => {
  const query = event.target.value;
  const request = ++searchGeneration;
  clearTimeout(searchTimer);
  viewer.clearHits();
  renderSearchList([], "");
  searchTimer = setTimeout(() => runSearch(query, request), 180);
});
$("search-input").addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) await moveHit(-1);
    else await moveHit(1);
  }
  if (event.key === "Escape") {
    event.target.blur();
  }
});
$("search-prev").addEventListener("click", () => moveHit(-1));
$("search-next").addEventListener("click", () => moveHit(1));

async function moveHit(step) {
  if (!searchHits.length) return;
  const hits = searchHits;
  const next = (viewer.hitIndex + step + hits.length) % hits.length;
  try {
    await viewer.jumpToHit(next, { push: true });
    if (searchHits === hits) renderSearchList(hits, $("search-input").value);
  } catch (error) {
    if (searchHits === hits) $("search-pane").textContent = `定位失败：${error.message || error}`;
  }
}

const wrap = $("viewer-wrap");
wrap.addEventListener("dragover", (event) => {
  event.preventDefault();
  wrap.classList.add("dragover");
});
wrap.addEventListener("dragleave", () => wrap.classList.remove("dragover"));
wrap.addEventListener("drop", async (event) => {
  event.preventDefault();
  wrap.classList.remove("dragover");
  const file = [...(event.dataTransfer?.files || [])].find((item) =>
    item.name.toLowerCase().endsWith(".pdf"),
  );
  if (file) await openFile(file);
});

wrap.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    $("zoom-select").value = viewer.bumpZoom(event.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);

for (const type of ["mousedown", "mouseup", "auxclick", "pointerup"]) {
  window.addEventListener(
    type,
    (event) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (type !== "mouseup") return;
      if (event.button === 3) viewer.back();
      else viewer.forward();
    },
    true,
  );
}

window.addEventListener("keydown", (event) => {
  const typing = event.target.matches("input, textarea, select");
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    pickFile();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    $("search-input").focus();
    $("search-input").select();
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === "=" || event.key === "+")) {
    event.preventDefault();
    $("zoom-select").value = viewer.bumpZoom(1);
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "-") {
    event.preventDefault();
    $("zoom-select").value = viewer.bumpZoom(-1);
  }
  if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    viewer.back();
  }
  if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    viewer.forward();
  }
  if (event.key === "Backspace" && !typing) {
    event.preventDefault();
    viewer.back();
  }
  if (!typing && (event.key === "ArrowDown" || event.key === "PageDown")) {
    event.preventDefault();
    stepPage(1);
  }
  if (!typing && (event.key === "ArrowUp" || event.key === "PageUp")) {
    event.preventDefault();
    stepPage(-1);
  }
  if (event.key === "Escape" && !typing) {
    hideBubble();
    $("settings-modal").hidden = true;
  }
});

const bubble = $("translate-bubble");
let selectedText = "";

function cancelTranslate() {
  translateAbort?.abort();
  translateAbort = null;
  $("btn-translate-cancel").hidden = true;
}

function hideBubble() {
  bubble.hidden = true;
  $("translate-result").hidden = true;
  $("translate-result").classList.remove("error");
  $("translate-result").textContent = "";
  $("translate-status").hidden = true;
  cancelTranslate();
}

function positionBubble(x, y) {
  const left = Math.min(x, window.innerWidth - bubble.offsetWidth - 12);
  const top = Math.min(y, window.innerHeight - 12);
  bubble.style.left = `${Math.max(12, left)}px`;
  bubble.style.top = `${Math.max(12, top)}px`;
}

function showBubble(x, y, text) {
  const selectionId = ++bubbleSelectionId;
  selectedText = text;
  $("translate-source").textContent = text.length > 240 ? `${text.slice(0, 240)}…` : text;
  $("translate-result").hidden = true;
  $("translate-result").classList.remove("error");
  $("translate-result").textContent = "";
  bubble.hidden = false;
  positionBubble(x, y);
  void runTranslate(selectionId);
  return selectionId;
}

function setTranslateError(message, selectionId) {
  if (selectionId !== bubbleSelectionId) return;
  const result = $("translate-result");
  result.hidden = false;
  result.classList.add("error");
  result.replaceChildren();
  result.append(document.createTextNode(`${message} `));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "link-btn";
  retry.id = "btn-translate-retry";
  retry.textContent = "重试";
  retry.addEventListener("click", () => runTranslate(selectionId));
  result.append(retry);
  $("translate-status").hidden = true;
  $("btn-translate-cancel").hidden = true;
}

async function runTranslate(selectionId = bubbleSelectionId) {
  if (selectionId !== bubbleSelectionId) return;
  cancelTranslate();
  const text = selectedText;
  if (!text) return;
  if (text.length > MAX_TRANSLATE_CHARS) {
    setTranslateError(`选中文本过长（${text.length} 字），请缩短到 ${MAX_TRANSLATE_CHARS} 字以内。`, selectionId);
    return;
  }
  const result = $("translate-result");
  const status = $("translate-status");
  result.hidden = true;
  result.classList.remove("error");
  status.hidden = false;
  status.textContent = "翻译中…";
  $("btn-translate-cancel").hidden = false;

  const controller = new AbortController();
  translateAbort = controller;
  const requestId = ++translateRequestId;

  try {
    const translated = await translateText(text, loadSettings(), { signal: controller.signal });
    if (requestId !== translateRequestId || selectionId !== bubbleSelectionId) return;
    status.hidden = true;
    $("btn-translate-cancel").hidden = true;
    result.hidden = false;
    result.textContent = translated;
    translateAbort = null;
  } catch (error) {
    if (requestId !== translateRequestId || selectionId !== bubbleSelectionId) return;
    if (controller.signal.aborted) {
      status.hidden = true;
      $("btn-translate-cancel").hidden = true;
      return;
    }
    setTranslateError(error.message || String(error), selectionId);
  }
}

document.addEventListener("mouseup", (event) => {
  if (bubble.contains(event.target)) return;
  const selection = window.getSelection();
  const text = selection?.toString().trim() || "";
  if (!text || !selection.rangeCount) {
    if (!event.target.closest("#translate-bubble")) hideBubble();
    return;
  }
  const range = selection.getRangeAt(0);
  if (!range.startContainer.parentElement?.closest(".textLayer")) {
    hideBubble();
    return;
  }
  const rect = range.getBoundingClientRect();
  showBubble(rect.left, rect.bottom + 8, text);
});

$("btn-bubble-close").addEventListener("click", hideBubble);
$("btn-translate-cancel").addEventListener("click", () => {
  translateAbort?.abort();
  $("translate-status").hidden = true;
  $("btn-translate-cancel").hidden = true;
});
$("btn-copy").addEventListener("click", async () => {
  const copy = $("translate-result").textContent?.trim() || selectedText;
  if (copy) await navigator.clipboard.writeText(copy);
});
$("btn-translate").addEventListener("click", () => runTranslate());

const modelPicker = wireModelPicker({
  input: $("setting-model"),
  menu: $("setting-model-menu"),
  status: $("setting-model-status"),
  getCredentials: () => ({
    apiKey: $("setting-key").value.trim(),
    apiBaseUrl: $("setting-base").value.trim(),
  }),
});
let modelRefreshTimer = 0;
const scheduleModelRefresh = () => {
  clearTimeout(modelRefreshTimer);
  modelRefreshTimer = setTimeout(() => modelPicker.refresh(), 400);
};
const onCredentialInput = () => {
  if (!$("setting-key").value.trim() || !$("setting-base").value.trim()) {
    modelPicker.invalidatePending();
  }
  scheduleModelRefresh();
};
$("setting-key").addEventListener("input", onCredentialInput);
$("setting-base").addEventListener("input", onCredentialInput);

$("btn-settings").addEventListener("click", () => {
  settings = loadSettings();
  $("setting-key").value = settings.apiKey;
  $("setting-base").value = settings.apiBaseUrl;
  $("setting-model").value = settings.model;
  $("setting-lang").value = settings.targetLang;
  $("settings-modal").hidden = false;
  modelPicker.refresh();
});
$("btn-settings-cancel").addEventListener("click", () => {
  $("settings-modal").hidden = true;
});
$("btn-settings-save").addEventListener("click", () => {
  settings = saveSettings({
    apiKey: $("setting-key").value.trim(),
    apiBaseUrl: $("setting-base").value.trim(),
    model: $("setting-model").value.trim() || "openai/gpt-4o-mini",
    targetLang: $("setting-lang").value,
  });
  $("settings-modal").hidden = true;
});

async function boot() {
  document.body.dataset.platform = platform.id;
  const request = openGeneration;
  const startup = await platform.startupOpen();
  if (startup && request === openGeneration) await openFromPlatform(startup);
}

window.addEventListener("pagehide", flushReadingPosition);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushReadingPosition();
});

boot();
