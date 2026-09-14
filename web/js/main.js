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
import { destPdfY, pickOutlineActive } from "./outline-active.js";
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
    markZoomTouched();
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

let dismissPassword = null;

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
      dismissPassword = null;
      try {
        document.getElementById("app")?.removeAttribute("inert");
      } catch {
        /* ignore */
      }
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
    dismissPassword = onCancel;
    try {
      document.getElementById("app")?.setAttribute("inert", "");
    } catch {
      /* ignore */
    }
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
  onPinchCommit: markZoomTouched,
  onScrollPosition: () => {
    scheduleSaveReadingPosition();
    scheduleOutlineActive();
  },
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
  const hasDoc = Boolean(viewer.pdf);
  $("page-controls").hidden = !hasDoc;
  $("page-divider").hidden = !hasDoc;
  $("page-input").value = hasDoc ? String(state.page || 1) : "—";
  $("page-input").disabled = !hasDoc;
  $("page-count").textContent = hasDoc ? String(viewer.pageCount || 0) : "—";
  $("doc-title").textContent = viewer.name || "未打开文件";
  $("doc-title").title = viewer.name || "未打开文件";
  $("drop-hint").classList.toggle("hidden", hasDoc);
  // Empty state keeps a primary 打开; once a PDF is open it steps down.
  $("btn-open").classList.toggle("demoted", hasDoc);
  syncZoom(viewer.pinch ? viewer.pinch.target * 100 : state.zoom);
  $("btn-back").disabled = !history.canBack();
  $("btn-forward").disabled = !history.canForward();
  updateOutlineActive();
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

function scheduleOutlineActive() {
  if (typeof requestAnimationFrame !== "function") {
    updateOutlineActive();
    return;
  }
  if (outlineActiveRaf) return;
  outlineActiveRaf = requestAnimationFrame(() => {
    outlineActiveRaf = 0;
    updateOutlineActive();
  });
}

function setOutlineActive(active) {
  if (!outlineTreeApi?.entries?.length) return;
  for (const entry of outlineTreeApi.entries) {
    const selected = entry === active;
    entry.btn.classList.toggle("active", selected);
    if (selected) entry.btn.setAttribute("aria-current", "true");
    else entry.btn.removeAttribute("aria-current");
    entry.node?.setAttribute("aria-selected", String(selected));
  }
  if (outlineAutoReveal && active) {
    for (let entry = active; entry; entry = entry.parent) {
      if (entry.hasChildren) outlineTreeApi.setEntryExpanded(entry, true);
    }
  }
}

function updateOutlineActive() {
  if (!outlineTreeApi?.entries?.length) return;
  const view = viewer.getReadingPoint?.() || { page: viewer.currentPage || 1, pdfY: NaN };
  setOutlineActive(pickOutlineActive(outlineTreeApi.entries, view));
}

/** Live outline entries from the last renderOutline mount (cleared when pane resets). */
let outlineTreeApi = null;
/** When false, page changes highlight the current row but do not re-open branches. */
let outlineAutoReveal = true;
let outlineActiveRaf = 0;

function pinOutlineDisclosure() {
  outlineAutoReveal = false;
}

function syncOutlineTreeActions() {
  const actions = $("outline-tree-actions");
  if (!actions) return;
  const hasBranches = Boolean(outlineTreeApi?.entries?.some((entry) => entry.hasChildren));
  const show = sidebarMode === "outline" && hasBranches;
  actions.hidden = !show;
}

function expandAllOutlineNodes() {
  if (!outlineTreeApi) return;
  for (const entry of outlineTreeApi.entries) {
    if (entry.hasChildren) outlineTreeApi.setEntryExpanded(entry, true);
  }
  pinOutlineDisclosure();
}

function collapseAllOutlineNodes() {
  if (!outlineTreeApi) return;
  for (const entry of outlineTreeApi.entries) {
    if (entry.hasChildren) outlineTreeApi.setEntryExpanded(entry, false);
  }
  pinOutlineDisclosure();
}

function showViewerStatus(text, { action = false } = {}) {
  const box = $("viewer-status");
  if (!box) return;
  $("viewer-status-text").textContent = text;
  const btn = $("viewer-status-action");
  if (btn) btn.hidden = !action;
  box.hidden = false;
}

function hideViewerStatus() {
  const box = $("viewer-status");
  if (box) box.hidden = true;
}

let userZoomTouched = false;
function markZoomTouched() {
  if (viewer.pdf) userZoomTouched = true;
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
  $("search-clear").hidden = true;
  renderSearchList([], "");
  $("outline-pane").replaceChildren();
  outlineTreeApi = null;
  outlineAutoReveal = true;
  syncOutlineTreeActions();
  hideBubble();
  showViewerStatus("正在打开…");
  try {
    const source = await getSource();
    if (request !== openGeneration) return;
    const opened = await viewer.open(source);
    if (!opened || request !== openGeneration) return;
    currentFingerprint = readingFingerprint(source);
    const saved = loadReadingPosition(currentFingerprint);
    if (saved) {
      viewer.applyReadingPosition(saved);
      markZoomTouched();
      hideViewerStatus();
    } else {
      // First open fits the page width; later opens respect the user's zoom.
      if (!userZoomTouched) viewer.setZoom("page-width", { silent: true });
      hideViewerStatus();
    }
    await renderOutline(request);
    if (request === openGeneration && $("search-input").value.trim()) {
      await runSearch($("search-input").value);
    }
  } catch (error) {
    if (request === openGeneration) {
      const message = `打开失败：${error.message || error}`;
      $("outline-pane").textContent = message;
      showViewerStatus(message, { action: true });
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
    outlineTreeApi = null;
    outlineAutoReveal = true;
    syncOutlineTreeActions();
    pane.removeAttribute("role");
    pane.removeAttribute("aria-label");
    if (!outline?.length) {
      pane.innerHTML = '<div class="empty-side">这份 PDF 没有目录。</div>';
      // Late outline with no entries must not kick the user out of search.
      if (sidebarMode !== "search") {
        selectSidebar("outline");
        setSidebarCollapsed(true);
      }
    }
    return;
  }
  await attachOutlinePages(outline, { request, pdf, generation });
  if (request !== openGeneration || viewer.generation !== generation || viewer.pdf !== pdf) return;
  // Some producers wrap the whole outline in one destination-less container
  // (e.g. a lone "system" node). Promoting its children restores a real tree.
  let roots = outline;
  while (
    roots?.length === 1 &&
    roots[0]?.items?.length &&
    roots[0]?.dest == null &&
    roots[0]?.pageNumber == null
  ) {
    roots = roots[0].items;
  }
  pane.replaceChildren();
  pane.setAttribute("role", "tree");
  pane.setAttribute("aria-label", "文档目录");
  // Flat entries in mount order with parent links, so the active path can be
  // revealed without DOM tree-walking.
  const entries = [];
  const setEntryExpanded = (entry, expanded) => {
    entry.branch?.classList.toggle("expanded", expanded);
    entry.toggle?.setAttribute("aria-expanded", String(expanded));
    if (entry.hasChildren) entry.node?.setAttribute("aria-expanded", String(expanded));
  };
  const mount = (items, depth, container, parentEntry) => {
    for (const item of items) {
      const title = item.title || "未命名";
      const hasChildren = Boolean(item.items?.length);
      const node = document.createElement("div");
      node.className = "outline-node";
      node.setAttribute("role", "treeitem");
      node.setAttribute("aria-level", String(depth + 1));
      const row = document.createElement("div");
      row.className = "outline-row";
      if (depth > 0) row.style.paddingLeft = `${depth * 16}px`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "outline-toggle";
      // Leaves keep a reserved (invisible) toggle so sibling titles align.
      toggle.tabIndex = -1;
      if (hasChildren) {
        toggle.setAttribute("aria-expanded", depth === 0 ? "true" : "false");
        toggle.setAttribute("aria-label", `展开/折叠 ${title}`);
        toggle.title = "展开/折叠";
      } else {
        toggle.classList.add("is-leaf");
        toggle.setAttribute("aria-hidden", "true");
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "outline-item";
      // One line + ellipsis via CSS; title carries the full heading.
      btn.textContent = title;
      btn.title = title;
      const page = Number(item.pageNumber);
      if (Number.isFinite(page) && page > 0) {
        btn.dataset.page = String(page);
        btn.setAttribute("aria-description", `第 ${page} 页`);
      }
      row.append(toggle, btn);
      node.append(row);
      const entry = { node, branch: null, toggle, btn, parent: parentEntry, hasChildren, page, pdfY: Number(item.pdfY) };
      entries.push(entry);
      btn.addEventListener("click", () => {
        setOutlineActive(entry);
        viewer.goToDest(item.dest, true);
      });
      if (hasChildren) {
        const branch = document.createElement("div");
        branch.className = "outline-branch";
        branch.setAttribute("role", "group");
        entry.branch = branch;
        const expanded = depth === 0;
        if (expanded) setEntryExpanded(entry, true);
        else {
          branch.classList.toggle("expanded", false);
          node.setAttribute("aria-expanded", "false");
        }
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          pinOutlineDisclosure();
          setEntryExpanded(entry, !branch.classList.contains("expanded"));
        });
        btn.addEventListener("keydown", (event) => {
          if (event.key === "ArrowRight" && !branch.classList.contains("expanded")) {
            event.preventDefault();
            pinOutlineDisclosure();
            setEntryExpanded(entry, true);
          } else if (event.key === "ArrowLeft" && branch.classList.contains("expanded")) {
            event.preventDefault();
            pinOutlineDisclosure();
            setEntryExpanded(entry, false);
          }
        });
        mount(item.items, depth + 1, branch, entry);
        node.append(branch);
      }
      container.appendChild(node);
    }
  };
  mount(roots, 0, pane, null);
  outlineTreeApi = { entries, setEntryExpanded };
  outlineAutoReveal = true;
  syncOutlineTreeActions();
  if (isSidebarCollapsed()) syncSidebarTabStops(true);
  // Default-expand the current section's ancestor chain, then keep the row in view.
  updateOutlineActive();
  const activeBtn = pane.querySelector(".outline-item.active");
  activeBtn?.scrollIntoView?.({ block: "nearest" });
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
          item.pdfY = destPdfY(explicit);
        }
      }
    } catch {
      /* skip */
    }
    if (item.items?.length) await attachOutlinePages(item.items, ctx);
  }
}

function renderSearchList(hits, query, start = Math.max(0, viewer.hitIndex - 50), reveal = false) {
  searchHits = hits;
  const list = $("search-list");
  const previousScroll = list.scrollTop;
  let activeButton = null;
  const count = $("search-count");
  list.replaceChildren();
  $("search-prev").disabled = hits.length === 0;
  $("search-next").disabled = hits.length === 0;
  if (!query) {
    count.hidden = true;
    list.innerHTML = '<div class="empty-side">输入关键词后，这里会列出全部命中。</div>';
    return;
  }
  count.hidden = false;
  if (!hits.length) {
    count.textContent = "0 条";
    list.innerHTML = '<div class="empty-side">没有找到匹配。</div>';
    return;
  }
  count.textContent = `${viewer.hitIndex + 1} / ${hits.length}`;
  const end = Math.min(hits.length, start + 200);
  const moreButton = (label, nextStart) => {
    const button = document.createElement("button");
    button.className = "btn";
    button.textContent = label;
    button.addEventListener("click", () => renderSearchList(hits, query, nextStart));
    list.appendChild(button);
  };
  if (start > 0) moreButton("上一组结果", Math.max(0, start - 200));
  hits.slice(start, end).forEach((hit, localIndex) => {
    const index = start + localIndex;
    const btn = document.createElement("button");
    btn.className = `search-hit${index === viewer.hitIndex ? " active" : ""}`;
    if (index === viewer.hitIndex) activeButton = btn;
    btn.innerHTML = `<div class="meta">第 ${hit.pageNumber} 页 · ${index + 1}/${hits.length}</div>
      <div class="snippet">${highlightSnippet(hit.snippet, query)}</div>`;
    btn.addEventListener("click", async () => {
      try {
        await viewer.jumpToHit(index, { push: true });
        if (searchHits === hits && $("search-input").value === query) renderSearchList(hits, query, undefined, true);
      } catch (error) {
        if (searchHits === hits) list.textContent = `定位失败：${error.message || error}`;
      }
    });
    list.appendChild(btn);
  });
  if (end < hits.length) moreButton("下一组结果", end);
  list.scrollTop = previousScroll;
  if (reveal && activeButton && !isSidebarCollapsed() && sidebarMode === "search") {
    // Scroll only the results container; never move the PDF or keyboard focus.
    const bounds = list.getBoundingClientRect?.();
    const item = activeButton.getBoundingClientRect?.();
    if (bounds && item) {
      if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
      else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
    }
  }
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
    renderSearchList(unchanged ? searchHits : hits, query, undefined, jump);
    if (globalThis.__PDF_BENCH__) {
      globalThis.__pdfSearchBench.resultListVisibleMs = performance.now() - searchStarted;
    }
    if (query && jump) {
      selectSidebar("search");
      setSidebarCollapsed(false);
    }
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
        $("search-list").appendChild(warning);
      } else if (viewer.indexedPages < viewer.pageCount) {
        $("search-count").textContent += ` · 索引 ${viewer.indexedPages}/${viewer.pageCount}`;
      }
    }
  } catch (error) {
    if (current()) $("search-list").textContent = `搜索失败：${error.message || error}`;
  }
}

let sidebarMode = "outline";
function selectSidebar(name) {
  sidebarMode = name;
  $("outline-pane").classList.toggle("active", name === "outline");
  $("search-pane").classList.toggle("active", name === "search");
  $("sidebar-tab-outline")?.setAttribute("aria-selected", String(name === "outline"));
  $("sidebar-tab-search")?.setAttribute("aria-selected", String(name === "search"));
  $("sidebar-tab-outline")?.classList.toggle("active", name === "outline");
  $("sidebar-tab-search")?.classList.toggle("active", name === "search");
  syncSearchButton();
  syncOutlineTreeActions();
}

function isSidebarCollapsed() {
  return document.querySelector(".workspace").classList.contains("sidebar-collapsed");
}

function syncSearchButton() {
  const open = sidebarMode === "search" && !isSidebarCollapsed();
  $("btn-search-toggle")?.setAttribute("aria-expanded", String(open));
  $("btn-search-toggle")?.classList.toggle("active", open);
}

function openSearch() {
  selectSidebar("search");
  setSidebarCollapsed(false);
  $("search-input").focus();
}

let pageWidthReflowToken = 0;

function runPageWidthReflow() {
  if (!viewer.pdf || viewer.zoomMode !== "page-width") return;
  viewer.setZoom("page-width", { silent: true });
  syncZoom(viewer.zoomMode);
}

function schedulePageWidthReflow() {
  if (!viewer.pdf || viewer.zoomMode !== "page-width") return;
  const sidebar = $("sidebar");
  const token = ++pageWidthReflowToken;
  const finish = () => {
    if (token !== pageWidthReflowToken) return;
    pageWidthReflowToken += 1;
    runPageWidthReflow();
  };
  const onTransitionEnd = (event) => {
    if (event.target !== sidebar) return;
    if (event.propertyName !== "width" && event.propertyName !== "flex-basis") return;
    sidebar.removeEventListener("transitionend", onTransitionEnd);
    clearTimeout(fallbackTimer);
    finish();
  };
  sidebar.addEventListener("transitionend", onTransitionEnd);
  const fallbackTimer = setTimeout(() => {
    sidebar.removeEventListener("transitionend", onTransitionEnd);
    finish();
  }, 220);
}

function syncSidebarTabStops(collapsed) {
  const sidebar = $("sidebar");
  const focusables = sidebar.querySelectorAll(
    "button, input, select, textarea, a[href], [tabindex]",
  );
  for (const el of focusables) {
    if (collapsed) {
      if (el.dataset.sidebarTabindex == null) {
        el.dataset.sidebarTabindex = el.getAttribute("tabindex") ?? "";
      }
      el.tabIndex = -1;
      el.setAttribute("aria-hidden", "true");
    } else {
      const prev = el.dataset.sidebarTabindex;
      if (prev != null) {
        if (prev === "") el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", prev);
        delete el.dataset.sidebarTabindex;
      } else {
        el.removeAttribute("tabindex");
      }
      if (el.classList.contains("outline-toggle") && el.classList.contains("is-leaf")) {
        el.setAttribute("aria-hidden", "true");
      } else {
        el.removeAttribute("aria-hidden");
      }
    }
  }
}

function setSidebarCollapsed(collapsed) {
  document.querySelector(".workspace").classList.toggle("sidebar-collapsed", collapsed);
  const sidebar = $("sidebar");
  sidebar.setAttribute("aria-hidden", collapsed ? "true" : "false");
  // Collapsed sidebar leaves the tab order entirely.
  try {
    if (collapsed) sidebar.setAttribute("inert", "");
    else sidebar.removeAttribute("inert");
    sidebar.inert = collapsed;
  } catch {
    /* inert not supported: aria-hidden still hides it from AT */
  }
  syncSidebarTabStops(collapsed);
  $("btn-sidebar").classList.toggle("active", !collapsed);
  $("btn-sidebar").setAttribute("aria-pressed", collapsed ? "false" : "true");
  syncSearchButton();
  schedulePageWidthReflow();
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
$("btn-open-empty")?.addEventListener("click", pickFile);
$("viewer-status-action")?.addEventListener("click", pickFile);
// 目录 is always outline: open on outline, outline-open toggles shut,
// search-open flips back to outline without clearing the query.
$("btn-sidebar").addEventListener("click", () => {
  if (isSidebarCollapsed()) {
    selectSidebar("outline");
    setSidebarCollapsed(false);
  } else if (sidebarMode === "outline") {
    setSidebarCollapsed(true);
  } else {
    selectSidebar("outline");
  }
});
$("sidebar-tab-outline")?.addEventListener("click", () => {
  selectSidebar("outline");
  setSidebarCollapsed(false);
});
$("sidebar-tab-search")?.addEventListener("click", () => {
  openSearch();
});
const outlineExpandAllBtn = $("btn-outline-expand-all");
if (outlineExpandAllBtn) {
  outlineExpandAllBtn.title = "全部展开";
  outlineExpandAllBtn.setAttribute("aria-label", "全部展开");
  outlineExpandAllBtn.addEventListener("click", () => expandAllOutlineNodes());
}
const outlineCollapseAllBtn = $("btn-outline-collapse-all");
if (outlineCollapseAllBtn) {
  outlineCollapseAllBtn.title = "全部折叠";
  outlineCollapseAllBtn.setAttribute("aria-label", "全部折叠");
  outlineCollapseAllBtn.addEventListener("click", () => collapseAllOutlineNodes());
}
$("btn-sidebar-close").addEventListener("click", () => setSidebarCollapsed(true));
// 默认收起：空文档、无目录文档都是全宽页面，目录按需打开。
selectSidebar("outline");
setSidebarCollapsed(true);
$("btn-back").addEventListener("click", () => viewer.back());
$("btn-forward").addEventListener("click", () => viewer.forward());
$("btn-zoom-in").addEventListener("click", () => {
  markZoomTouched();
  $("zoom-select").value = viewer.bumpZoom(1);
});
$("btn-zoom-out").addEventListener("click", () => {
  markZoomTouched();
  $("zoom-select").value = viewer.bumpZoom(-1);
});
$("zoom-select").addEventListener("change", (event) => {
  markZoomTouched();
  viewer.setZoom(event.target.value);
});
// Search opens on demand, including through Ctrl+F.
$("btn-search-toggle")?.addEventListener("click", () => {
  if (sidebarMode === "search" && !isSidebarCollapsed()) setSidebarCollapsed(true);
  else openSearch();
});
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
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    if (event.target.disabled || !viewer.pageCount) return;
    event.preventDefault();
    event.stopPropagation();
    const current = viewer.currentPage || 1;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = Math.min(viewer.pageCount, Math.max(1, current + delta));
    event.target.value = String(next);
    if (next !== current) viewer.goToPage(next, { push: true });
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const page = pageInputValue(event.target.value);
    if (page) viewer.goToPage(page, { push: true });
  }
});

let searchTimer = 0;
$("search-input").addEventListener("input", (event) => {
  const query = event.target.value;
  const request = ++searchGeneration;
  $("search-clear").hidden = !query;
  clearTimeout(searchTimer);
  viewer.clearHits();
  if (!query) renderSearchList([], "");
  searchTimer = setTimeout(() => runSearch(query, request), 180);
});
$("search-clear").addEventListener("click", () => {
  searchGeneration += 1;
  clearTimeout(searchTimer);
  viewer.clearHits();
  $("search-input").value = "";
  $("search-clear").hidden = true;
  renderSearchList([], "");
  $("search-input").focus();
});
$("search-input").addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) await moveHit(-1);
    else await moveHit(1);
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    setSidebarCollapsed(true);
    $("btn-search-toggle")?.focus();
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
    if (searchHits === hits) renderSearchList(hits, $("search-input").value, undefined, true);
  } catch (error) {
    if (searchHits === hits) $("search-list").textContent = `定位失败：${error.message || error}`;
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
  const settingsOpen = !$("settings-modal").hidden;
  const passwordOpen = !$("pdf-password-modal").hidden;
  if (settingsOpen || passwordOpen) {
    // Modals own Escape/Tab; background reading shortcuts stay isolated.
    if (event.key === "Escape" && settingsOpen) {
      event.preventDefault();
      closeSettings();
    }
    return;
  }
  const typing = event.target?.matches?.("input, textarea, select");
  const inReaderChrome = event.target?.closest?.("#sidebar, #zoom-menu, #translate-bubble");
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    pickFile();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openSearch();
    $("search-input").select();
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === "=" || event.key === "+")) {
    event.preventDefault();
    markZoomTouched();
    $("zoom-select").value = viewer.bumpZoom(1);
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "-") {
    event.preventDefault();
    markZoomTouched();
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
  if (event.key === "Backspace" && !typing && !inReaderChrome) {
    event.preventDefault();
    viewer.back();
  }
  if (!typing && !inReaderChrome && (event.key === "ArrowDown" || event.key === "PageDown")) {
    event.preventDefault();
    stepPage(1);
  }
  if (!typing && !inReaderChrome && (event.key === "ArrowUp" || event.key === "PageUp")) {
    event.preventDefault();
    stepPage(-1);
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (!$("translate-bubble").hidden) {
      hideBubble();
      return;
    }
    if (!$("zoom-menu").hidden) {
      setZoomMenuOpen(false);
      return;
    }
    if (!isSidebarCollapsed() && sidebarMode === "search") {
      setSidebarCollapsed(true);
      $("btn-search-toggle")?.focus();
    }
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

function clearStreamingResult() {
  const result = $("translate-result");
  result.classList.remove("streaming");
  result.replaceChildren();
  result.hidden = true;
}

function cancelTranslate() {
  translateAbort?.abort();
  translateAbort = null;
  setBubbleStreaming(false);
  clearStreamingResult();
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
  updateSourceFold();
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

function updateSourceFold() {
  const source = $("translate-source");
  const toggle = $("btn-source-toggle");
  if (!source || !toggle) return;
  const long = (selectedText || "").length > 400;
  const expanded = toggle.dataset.expanded === "true";
  renderBubbleSource(source, selectedText, selectedTranslationMode, { full: expanded });
  source.classList.toggle("collapsed", long && !expanded);
  toggle.hidden = !long;
  toggle.textContent = expanded ? "收起原文" : "展开原文";
}

let translateAwaitingKey = false;

function isMissingKeyError(message) {
  try {
    if (!loadSettings().apiKey?.trim()) return true;
  } catch {
    /* fall through to message check */
  }
  return /API Key/.test(String(message || ""));
}

function setTranslateError(message, selectionId) {
  if (selectionId !== bubbleSelectionId) return;
  const result = $("translate-result");
  result.hidden = false;
  result.classList.remove("streaming");
  result.classList.add("error");
  result.replaceChildren();
  result.append(document.createTextNode(`${message} `));
  if (isMissingKeyError(message)) {
    translateAwaitingKey = true;
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "link-btn";
    settingsBtn.id = "btn-translate-settings";
    settingsBtn.textContent = "设置翻译";
    settingsBtn.addEventListener("click", () => openSettings());
    result.append(settingsBtn);
  } else {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "link-btn";
    retry.id = "btn-translate-retry";
    retry.textContent = "重试";
    retry.addEventListener("click", () => runTranslate(selectionId));
    translateAwaitingKey = false;
    result.append(retry);
  }
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
      clearStreamingResult();
      return;
    }
    setTranslateError(error.message || String(error), selectionId);
  }
}

// 划词气泡是选区延伸：点击外部 / Esc 直接关闭，不做迷你聊天。
document.addEventListener("pointerdown", (event) => {
  if (bubble.hidden) return;
  const target = event.target;
  if (bubble.contains(target) || translateChip.contains(target)) return;
  if (target.closest?.(".textLayer")) return;
  if (target.closest?.("#settings-modal, #pdf-password-modal")) return;
  hideBubble();
});

document.addEventListener("mouseup", (event) => {  if (bubble.contains(event.target) || translateChip.contains(event.target)) return;
  const selection = window.getSelection();
  const prepared = selection?.rangeCount ? prepareSelectionForTranslation(selection) : null;
  if (prepared?.tooLong) {
    const range = selection.getRangeAt(0);
    const anchor = getSelectionAnchorRect(range, wrap.getBoundingClientRect(), selection);
    selectedTranslationMode = "passage";
    const selectionId = openTranslatePanel(anchor, "", { startTranslate: false });
    setTranslateError(
      `选中文本过长（${prepared.charCount} 字），请缩短到 ${MAX_TRANSLATE_CHARS} 字以内。`,
      selectionId,
    );
    return;
  }
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
  const anchor = getSelectionAnchorRect(range, wrap.getBoundingClientRect(), selection);
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
$("btn-source-toggle")?.addEventListener("click", () => {
  const toggle = $("btn-source-toggle");
  toggle.dataset.expanded = toggle.dataset.expanded === "true" ? "false" : "true";
  updateSourceFold();
  scheduleRepositionBubble();
});
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

let lastSettingsTrigger = null;

function focusableIn(container) {
  const nodes = container?.querySelectorAll?.(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const list = nodes ? [...nodes] : [];
  return list.filter((el) => !el.hidden && el.getAttribute?.("aria-hidden") !== "true");
}

function trapModalTab(event, container) {
  if (event.key !== "Tab") return;
  const items = focusableIn(container);
  if (!items.length) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openSettings() {
  settings = loadSettings();
  $("setting-key").value = settings.apiKey;
  $("setting-base").value = settings.apiBaseUrl;
  $("setting-model").value = settings.model;
  $("setting-lang").value = settings.targetLang;
  $("setting-auto-translate").checked = settings.autoTranslateOnSelect !== false;
  lastSettingsTrigger = document.activeElement;
  $("settings-modal").hidden = false;
  try {
    document.getElementById("app")?.setAttribute("inert", "");
  } catch {
    /* ignore */
  }
  modelPicker.hideMenu();
  modelPicker.refresh();
  // Initial focus goes inside the dialog, not the background trigger.
  ($("setting-key") || $("settings-modal")).focus?.();
}

function closeSettings(restore = true) {
  modelPicker.hideMenu();
  $("settings-modal").hidden = true;
  try {
    document.getElementById("app")?.removeAttribute("inert");
  } catch {
    /* ignore */
  }
  if (restore && lastSettingsTrigger?.focus) {
    try {
      lastSettingsTrigger.focus({ preventScroll: true });
    } catch {
      lastSettingsTrigger.focus();
    }
  }
  lastSettingsTrigger = null;
}

$("btn-settings").addEventListener("click", openSettings);
$("settings-modal").addEventListener("keydown", (event) => {
  trapModalTab(event, $("settings-modal").querySelector(".modal-card") || $("settings-modal"));
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeSettings();
  }
  // Keep reading shortcuts from flipping the background PDF.
  event.stopPropagation();
});
$("pdf-password-modal")?.addEventListener("keydown", (event) => {
  trapModalTab(event, $("pdf-password-modal").querySelector(".modal-card") || $("pdf-password-modal"));
  if (event.key === "Escape") {
    event.preventDefault();
    dismissPassword?.();
  }
  event.stopPropagation();
});
$("btn-settings-cancel").addEventListener("click", () => {
  closeSettings();
});
$("btn-settings-save").addEventListener("click", () => {
  settings = saveSettings({
    apiKey: $("setting-key").value.trim(),
    apiBaseUrl: $("setting-base").value.trim(),
    model: $("setting-model").value.trim() || "openai/gpt-4o-mini",
    targetLang: $("setting-lang").value,
    autoTranslateOnSelect: $("setting-auto-translate").checked,
  });
  const retryTranslate = translateAwaitingKey && settings.apiKey?.trim();
  closeSettings();
  if (retryTranslate) {
    translateAwaitingKey = false;
    void runTranslate(bubbleSelectionId);
  }
});

function isAppleOs() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  const platformId = `${nav.userAgentData?.platform || ""} ${nav.platform || ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(platformId);
}

function shortcutChord(key) {
  return `${isAppleOs() ? "Cmd" : "Ctrl"}+${key}`;
}

function applyShortcutLabels() {
  const open = shortcutChord("O");
  const find = shortcutChord("F");
  $("btn-open").title = `打开 PDF (${open})`;
  const search = $("btn-search-toggle");
  if (search) {
    search.title = `搜索 (${find})`;
    search.setAttribute("aria-label", `搜索 (${find})`);
  }
  const zoomOut = $("btn-zoom-out");
  if (zoomOut) {
    zoomOut.title = `缩小 (${shortcutChord("-")})`;
    zoomOut.setAttribute("aria-label", `缩小 (${shortcutChord("-")})`);
  }
  const zoomIn = $("btn-zoom-in");
  if (zoomIn) {
    zoomIn.title = `放大 (${shortcutChord("=")})`;
    zoomIn.setAttribute("aria-label", `放大 (${shortcutChord("=")})`);
  }
  const hint = $("empty-shortcut");
  if (hint) hint.textContent = open;
}

async function boot() {
  applyShortcutLabels();
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
