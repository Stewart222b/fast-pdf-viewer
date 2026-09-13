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
import {
  readBubblePlainText,
  renderBubbleSource,
  renderBubbleTranslation,
} from "./bubble-text-render.js";
import { getSelectionAnchorFromSelection, getSelectionAnchorRect } from "./selection-anchor.js";
import { prepareSelectionForTranslation } from "./selection-text.js";
import { applyBubblePlacement } from "./translate-bubble-placement.js";
import { MAX_TRANSLATE_CHARS, translateText } from "./translate.js";
import { PasswordResponses } from "../vendor/pdfjs/build/pdf.mjs";
import { PdfViewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const platform = createPlatform();

// The fixed select supplies presets; the visible label can show any gesture scale.
const zoomMenuItems = [...$("zoom-select").options].map(option => {
  const item = document.createElement("button");
  item.type = "button";
  item.tabIndex = -1;
  item.dataset.zoom = option.value;
  item.textContent = option.textContent;
  item.setAttribute("role", "menuitemradio");
  item.setAttribute("aria-checked", String(option.selected));
  item.addEventListener("click", () => {
    setZoomMenuOpen(false);
    viewer.setZoom(option.value);
    $("zoom-button").focus({ preventScroll: true });
  });
  $("zoom-menu").appendChild(item);
  return item;
});

function setZoomMenuOpen(open, index) {
  $("zoom-menu").hidden = !open;
  $("zoom-button").setAttribute("aria-expanded", String(open));
  if (open) {
    const selected = zoomMenuItems.findIndex(item => item.getAttribute("aria-checked") === "true");
    zoomMenuItems[index ?? Math.max(0, selected)]?.focus({ preventScroll: true });
    $("zoom-menu").scrollTop = 0;
  }
}

$("zoom-button").addEventListener("click", () => setZoomMenuOpen($("zoom-menu").hidden));
$("zoom-button").addEventListener("keydown", event => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    setZoomMenuOpen(true, event.key === "ArrowDown" ? 0 : zoomMenuItems.length - 1);
  }
});
$("zoom-menu").addEventListener("keydown", event => {
  const index = zoomMenuItems.indexOf(document.activeElement);
  let next;
  if (event.key === "ArrowDown") next = (index + 1) % zoomMenuItems.length;
  if (event.key === "ArrowUp") next = (index - 1 + zoomMenuItems.length) % zoomMenuItems.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = zoomMenuItems.length - 1;
  if (next !== undefined) {
    event.preventDefault();
    zoomMenuItems[next]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    setZoomMenuOpen(false);
    $("zoom-button").focus({ preventScroll: true });
  }
});
document.addEventListener("pointerdown", event => {
  if (!$("zoom-picker").contains(event.target)) setZoomMenuOpen(false);
});
$("zoom-picker").addEventListener("focusout", event => {
  if (!$("zoom-picker").contains(event.relatedTarget)) setZoomMenuOpen(false);
});


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
  onZoomPreview: syncZoom,
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

function syncZoom(mode) {
  const value = String(mode);
  const select = $("zoom-select");
  const preset = [...select.options].find(opt => opt.value === value);
  $("zoom-label").textContent = preset?.textContent || `${Math.round(Number(value))}%`;
  select.value = value;
  for (const item of zoomMenuItems) {
    item.setAttribute("aria-checked", String(item.dataset.zoom === value));
  }
}

function syncToolbar(state) {
  $("page-input").value = String(state.page || 1);
  $("page-count").textContent = String(viewer.pageCount || 0);
  $("doc-title").textContent = viewer.name || "未打开文件";
  $("drop-hint").classList.toggle("hidden", Boolean(viewer.pdf));
  syncZoom(viewer.pinch ? viewer.pinch.target * 100 : state.zoom);
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
  $("sidebar").setAttribute("aria-hidden", collapsed ? "true" : "false");
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
function pageInputValue(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const page = Number(digits);
  return Number.isFinite(page) && page > 0 ? page : null;
}

$("page-input").addEventListener("change", (event) => {
  const page = pageInputValue(event.target.value);
  if (page) viewer.goToPage(page, { push: true });
});
$("page-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const page = pageInputValue(event.target.value);
    if (page) viewer.goToPage(page, { push: true });
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

let nativeGestureScale = null;
wrap.addEventListener("gesturestart", (event) => {
  if (!viewer.pdf) return;
  event.preventDefault();
  nativeGestureScale = event.scale || 1;
}, { passive: false });
wrap.addEventListener("gesturechange", (event) => {
  if (nativeGestureScale == null || !(event.scale > 0)) return;
  event.preventDefault();
  viewer.pinchZoom({
    deltaY: -100 * Math.log(event.scale / nativeGestureScale),
    deltaMode: 0, clientX: event.clientX, clientY: event.clientY,
  });
  nativeGestureScale = event.scale;
}, { passive: false });
wrap.addEventListener("gestureend", (event) => {
  if (nativeGestureScale == null) return;
  event.preventDefault();
  nativeGestureScale = null;
  viewer.finishPinch();
}, { passive: false });

wrap.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (nativeGestureScale == null) viewer.pinchZoom(event);
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
const translateChip = $("translate-chip");
let selectedText = "";
let selectedTranslationMode = "passage";
let bubbleSelectionRect = null;

function isAutoTranslateOn() {
  return loadSettings().autoTranslateOnSelect !== false;
}

function setBubbleStreaming(streaming) {
  $("btn-translate-cancel").hidden = !streaming;
}

function currentSelectionRect() {
  const viewport = wrap.getBoundingClientRect();
  const anchored = getSelectionAnchorFromSelection(window.getSelection(), viewport);
  return anchored || bubbleSelectionRect;
}

function repositionBubble() {
  if (bubble.hidden) return;
  const rect = currentSelectionRect();
  if (!rect) return;
  applyBubblePlacement(bubble, rect, wrap.getBoundingClientRect());
}

function scheduleRepositionBubble() {
  requestAnimationFrame(() => {
    repositionTranslateChip();
    repositionBubble();
  });
}

function cancelTranslate() {
  translateAbort?.abort();
  translateAbort = null;
  setBubbleStreaming(false);
}

function hideTranslateChip() {
  translateChip.hidden = true;
}

function repositionTranslateChip() {
  if (translateChip.hidden) return;
  const rect = currentSelectionRect();
  if (!rect) return;
  const viewport = wrap.getBoundingClientRect();
  const gap = 8;
  const margin = 8;
  translateChip.hidden = false;
  const w = translateChip.offsetWidth;
  const h = translateChip.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + gap;
  if (top + h > viewport.bottom - margin) top = rect.top - gap - h;
  left = Math.min(Math.max(left, viewport.left + margin), viewport.right - w - margin);
  top = Math.min(Math.max(top, viewport.top + margin), viewport.bottom - h - margin);
  translateChip.style.left = `${left}px`;
  translateChip.style.top = `${top}px`;
}

function hideBubble() {
  bubbleSelectionRect = null;
  hideTranslateChip();
  bubble.hidden = true;
  const result = $("translate-result");
  result.hidden = true;
  result.classList.remove("error", "streaming");
  result.textContent = "";
  setBubbleStreaming(false);
  cancelTranslate();
}

function showTranslateChip(selectionRect, text) {
  selectedText = text;
  bubbleSelectionRect = selectionRect;
  translateChip.hidden = false;
  repositionTranslateChip();
}

function showStreamingCaret(result) {
  result.hidden = false;
  result.classList.add("streaming");
  renderBubbleTranslation(result, "", selectedTranslationMode, { streaming: true });
}

function openTranslatePanel(selectionRect, text, { startTranslate = true } = {}) {
  hideTranslateChip();
  const selectionId = ++bubbleSelectionId;
  selectedText = text;
  bubbleSelectionRect = selectionRect;
  const source = $("translate-source");
  renderBubbleSource(source, text, selectedTranslationMode);
  const result = $("translate-result");
  result.hidden = true;
  result.classList.remove("error", "streaming");
  result.replaceChildren();
  bubble.hidden = false;
  setBubbleStreaming(false);
  repositionBubble();
  if (startTranslate) void runTranslate(selectionId);
  return selectionId;
}

function setTranslateError(message, selectionId) {
  if (selectionId !== bubbleSelectionId) return;
  const result = $("translate-result");
  result.hidden = false;
  result.classList.remove("streaming");
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
  setBubbleStreaming(false);
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
  result.classList.remove("error");
  showStreamingCaret(result);
  scheduleRepositionBubble();
  setBubbleStreaming(true);

  const controller = new AbortController();
  translateAbort = controller;
  const requestId = ++translateRequestId;

  try {
    const translated = await translateText(text, loadSettings(), {
      signal: controller.signal,
      mode: selectedTranslationMode,
      onDelta: (partial) => {
        if (requestId !== translateRequestId || selectionId !== bubbleSelectionId) return;
        renderBubbleTranslation(result, partial, selectedTranslationMode, { streaming: true });
        scheduleRepositionBubble();
      },
    });
    if (requestId !== translateRequestId || selectionId !== bubbleSelectionId) return;
    setBubbleStreaming(false);
    result.classList.remove("streaming");
    renderBubbleTranslation(result, translated, selectedTranslationMode);
    translateAbort = null;
    scheduleRepositionBubble();
  } catch (error) {
    if (requestId !== translateRequestId || selectionId !== bubbleSelectionId) return;
    if (controller.signal.aborted) {
      setBubbleStreaming(false);
      return;
    }
    setTranslateError(error.message || String(error), selectionId);
  }
}

document.addEventListener("mouseup", (event) => {
  if (bubble.contains(event.target) || translateChip.contains(event.target)) return;
  const selection = window.getSelection();
  const prepared = selection?.rangeCount ? prepareSelectionForTranslation(selection) : null;
  const text = prepared?.text || "";
  if (!text || !selection.rangeCount) {
    if (
      !event.target.closest("#translate-bubble") &&
      !event.target.closest("#translate-chip")
    ) {
      hideBubble();
    }
    return;
  }
  const range = selection.getRangeAt(0);
  const inTextLayer =
    range.endContainer.parentElement?.closest(".textLayer") ||
    range.startContainer.parentElement?.closest(".textLayer");
  if (!inTextLayer) {
    hideBubble();
    return;
  }
  selectedTranslationMode = prepared.mode;
  const anchor = getSelectionAnchorRect(range, wrap.getBoundingClientRect());
  if (isAutoTranslateOn()) {
    openTranslatePanel(anchor, text);
  } else {
    bubble.hidden = true;
    cancelTranslate();
    showTranslateChip(anchor, text);
  }
});

wrap.addEventListener("scroll", scheduleRepositionBubble, { passive: true });
window.addEventListener("resize", scheduleRepositionBubble);

translateChip.addEventListener("click", (event) => {
  event.stopPropagation();
  const rect = currentSelectionRect() || bubbleSelectionRect;
  if (!rect || !selectedText) return;
  openTranslatePanel(rect, selectedText);
});

$("btn-bubble-close").addEventListener("click", hideBubble);
$("btn-translate-cancel").addEventListener("click", () => {
  translateAbort?.abort();
  setBubbleStreaming(false);
});
$("btn-copy").addEventListener("click", async () => {
  const copy = readBubblePlainText($("translate-result")) || selectedText;
  if (copy) await navigator.clipboard.writeText(copy);
});

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
  $("setting-auto-translate").checked = settings.autoTranslateOnSelect !== false;
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
    autoTranslateOnSelect: $("setting-auto-translate").checked,
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
