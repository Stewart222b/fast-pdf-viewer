import { ViewHistory } from "./history.js";
import { createPlatform } from "./platform/index.js";
import {
  clearReadingPositions,
  loadReadingPosition,
  pruneReadingPositions,
  readingFingerprint,
  saveReadingPosition,
} from "./reading-position.js";
import { askDocument } from "./ask-document.js";
import { renderThinking } from "./thinking-view.js";
import { highlightSnippet, searchDocument } from "./search.js";
import { loadSettings, saveSettings, initSettings } from "./settings.js";
import { applyDocumentTranslations, getLocale, setLocale, t } from "./i18n.js";
import { buildDocumentPropertyRows } from "./document-properties.js";
import { formatExtensionError, requestHostAccess, fallbackToBrowser } from "./platform/extension.js";
import { wireModelPicker } from "./model-picker.js";
import {
  readBubblePlainText,
  renderBubbleSource,
  renderBubbleTranslation,
  renderMarkdown,
} from "./bubble-text-render.js";
import { getSelectionAnchorFromSelection, getSelectionAnchorRect } from "./selection-anchor.js";
import { prepareSelectionForTranslation } from "./selection-text.js";
import { applyBubblePlacement } from "./translate-bubble-placement.js";
import { formatBubbleModelLabel, isAllowedApiBaseUrl } from "./translate-provider.js";
import { MAX_TRANSLATE_CHARS, translateText } from "./translate.js";
import { destPdfY, pickOutlineActive } from "./outline-active.js";
import { PasswordResponses } from "../vendor/pdfjs/build/pdf.mjs";
import { PdfViewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const platform = createPlatform();
setLocale(loadSettings().uiLanguage);
applyDocumentTranslations();

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
    event.stopPropagation();
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


const docTitleButton = $("doc-title");
const docTitleMenuButton = $("btn-doc-title-menu");
const docTitleButtons = [docTitleButton, docTitleMenuButton];
const docTitlePopover = $("doc-title-popover");
let docTitleAnchorRect = null;

/* The popover belongs under the filename, not under the middle of the window:
   anchor it on the trigger and keep it inside the viewport. */
function placeDocTitlePopover(anchorRect) {
  const container = docTitlePopover.closest?.(".toolbar") || docTitlePopover.parentElement || document.body;
  const containerRect = container.getBoundingClientRect();
  const half = (docTitlePopover.offsetWidth || 0) / 2;
  const margin = 8;
  const center = anchorRect
    ? anchorRect.left + anchorRect.width / 2
    : containerRect.left + containerRect.width / 2;
  const minCenter = margin + half;
  const maxCenter = Math.max(minCenter, window.innerWidth - margin - half);
  const clamped = Math.min(Math.max(center, minCenter), maxCenter);
  docTitlePopover.style.left = `${Math.round(clamped - containerRect.left)}px`;
}

function closeDocTitlePopover() {
  docTitlePopover.hidden = true;
  docTitleAnchorRect = null;
  for (const button of docTitleButtons) button.setAttribute("aria-expanded", "false");
}

function currentOutlinePath() {
  if (typeof outlineTreeApi === "undefined" || typeof pickOutlineActive !== "function") return [];
  if (typeof viewer === "undefined" || !outlineTreeApi?.entries?.length) return [];
  const view = viewer.getReadingPoint?.() || { page: viewer.currentPage || 1, pdfY: NaN };
  const active = pickOutlineActive(outlineTreeApi.entries, view);
  if (!active) return [];
  const path = [];
  for (let entry = active; entry; entry = entry.parent) path.unshift(entry);
  return path;
}

function fillDocTitlePopover() {
  const fileName = docTitleButton.textContent;
  const path = currentOutlinePath();
  docTitlePopover.replaceChildren();
  const file = document.createElement("div");
  file.className = "doc-title-file";
  file.textContent = fileName;
  docTitlePopover.append(file);
  if (!path.length) return;
  const location = document.createElement("div");
  location.className = "doc-title-location";
  const label = document.createElement("div");
  label.className = "doc-title-location-label";
  label.textContent = typeof t === "function" ? t("currentLocation") : "";
  location.append(label);
  path.forEach((entry, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "doc-title-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = " › ";
      location.append(sep);
    }
    const last = index === path.length - 1;
    const crumb = document.createElement(last ? "span" : "button");
    crumb.className = last ? "doc-title-crumb is-current" : "doc-title-crumb";
    if (!last) {
      crumb.type = "button";
      crumb.addEventListener("click", () => {
        for (let node = entry; node; node = node.parent) {
          if (node.hasChildren) outlineTreeApi?.setEntryExpanded?.(node, true);
        }
        if (entry.dest != null) viewer.goToDest(entry.dest, true);
        else if (Number.isFinite(entry.page) && entry.page > 0) viewer.goToPage(entry.page, { push: true });
        closeDocTitlePopover();
      });
    }
    crumb.textContent = entry.title || "";
    location.append(crumb);
  });
  docTitlePopover.append(location);
}

function openDocTitlePopover(button) {
  docTitleAnchorRect = button.getBoundingClientRect();
  fillDocTitlePopover();
  docTitlePopover.hidden = false;
  for (const titleButton of docTitleButtons) {
    titleButton.setAttribute("aria-expanded", String(titleButton === button));
  }
  placeDocTitlePopover(docTitleAnchorRect);
}

function repositionDocTitlePopover() {
  if (docTitlePopover.hidden) return;
  placeDocTitlePopover(docTitleAnchorRect);
}

function dismissToolbarMoreForDocTitle() {
  setToolbarMoreOpen(false);
  toolbarMoreButton.focus({ preventScroll: true });
  if (docTitlePopover.hidden) return;
  // The menu row just went away, so the popover follows the enduring 更多 seat.
  docTitleAnchorRect = toolbarMoreButton.getBoundingClientRect();
  placeDocTitlePopover(docTitleAnchorRect);
}

const toolbarMoreButton = $("btn-toolbar-more");
const toolbarMore = document.querySelector(".toolbar-more");
const toolbarMoreMenu = $("toolbar-more-menu");

/* 更多 is the single secondary entry at every width, so it always opens the
   same popover instead of turning into an inline strip on wide screens. */
function setToolbarMoreOpen(open, restoreFocus = false) {
  // One surface at a time: the menu and the filename popover share the same band.
  if (open) closeDocTitlePopover();
  toolbarMoreMenu.classList.toggle("is-open", open);
  toolbarMoreMenu.inert = !open;
  toolbarMoreMenu.setAttribute("aria-hidden", String(!open));
  toolbarMoreButton.setAttribute("aria-expanded", String(open));
  if (restoreFocus) toolbarMoreButton.focus({ preventScroll: true });
}

toolbarMoreButton.addEventListener("click", event => {
  const open = !toolbarMoreMenu.classList.contains("is-open");
  setToolbarMoreOpen(open);
  if (open && event.detail === 0) {
    // Keyboard entry lands on the first row that is actually rendered — the
    // filename row exists in the DOM even when the centered title is visible.
    const firstRow = [...toolbarMoreMenu.querySelectorAll("button:not(:disabled)")]
      .find(row => row.offsetParent !== null);
    firstRow?.focus({ preventScroll: true });
  }
});
toolbarMoreMenu.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button === docTitleMenuButton) {
    // The filename entry owns a popover, so the menu steps aside instead of
    // stacking a second surface underneath it.
    dismissToolbarMoreForDocTitle();
    return;
  }
  setToolbarMoreOpen(false);
});
document.addEventListener("pointerdown", event => {
  if (!toolbarMore.contains(event.target)) setToolbarMoreOpen(false);
});
toolbarMore.addEventListener("focusout", event => {
  if (!toolbarMore.contains(event.relatedTarget)) setToolbarMoreOpen(false);
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !toolbarMoreMenu.classList.contains("is-open")) return;
  event.preventDefault();
  event.stopPropagation();
  setToolbarMoreOpen(false, true);
});
setToolbarMoreOpen(false);

for (const button of docTitleButtons) {
  button.addEventListener("click", () => {
    if (docTitlePopover.hidden) openDocTitlePopover(button);
    else closeDocTitlePopover();
  });
}
document.addEventListener("focusin", event => {
  if (docTitlePopover.hidden) return;
  if (docTitlePopover.contains(event.target)) return;
  if (docTitleButtons.some(button => button.contains(event.target))) return;
  // Focus handed to the 更多 seat on purpose; the popover is still the target.
  if (toolbarMore.contains(event.target)) return;
  closeDocTitlePopover();
});
document.addEventListener("pointerdown", event => {
  if (!docTitlePopover.hidden
      && !docTitlePopover.contains(event.target)
      && !docTitleButtons.some(button => button.contains(event.target))
      && !toolbarMore.contains(event.target)) {
    closeDocTitlePopover();
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !docTitlePopover.hidden) closeDocTitlePopover();
});
window.addEventListener("resize", repositionDocTitlePopover);

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
      reject(new Error(t("passwordCancelled")));
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
    error.textContent = reason === PasswordResponses.INCORRECT_PASSWORD ? t("passwordIncorrect") : "";
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
const searchOptions = { matchCase: false, wholeWord: false };
let searchResultOptions = null;
let openGeneration = 0;
let searchGeneration = 0;
let indexRefreshTimer = 0;
let objectUrl = null;
let nativePdf = null;
let activeDocument = null;
let recoverableDocument = null;
let readingNoticeTimer = 0;
let currentFingerprint = "";
let positionSaveTimer = 0;
let clearedReadingPosition = null;
let translateAbort = null;
let translateRequestId = 0;
let bubbleSelectionId = 0;
let settingsSaveQueue = Promise.resolve();
let bubbleTargetLangRevision = 0;
let askHits = [];
let askCitationIndex = -1;
let askAbort = null;
let askGeneration = 0;
let askLastQuestion = "";
let outlineTitles = [];
let outlineEntries = [];

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

const APP_TITLE = "Fast PDF Viewer – AI Translation";

function syncTabTitle() {
  const name = viewer.name?.trim();
  document.title = viewer.pdf || name ? (name || APP_TITLE) : APP_TITLE;
}

function applyTabTitle(name) {
  const trimmed = String(name || "").trim();
  if (trimmed) document.title = trimmed;
  if (platform.id === "extension" && typeof platform.setTabTitle === "function") {
    void platform.setTabTitle(trimmed);
  }
}

function syncOriginalPdfButton() {
  $("btn-original-pdf").hidden = !(
    platform.canFallbackToBrowser?.() || nativePdf?.blob || nativePdf?.url || nativePdf?.path
  );
}

function nativePdfFromSource(source, recoveryBlob) {
  const next = {};
  if (recoveryBlob) next.blob = recoveryBlob;
  if (source?.path) next.path = source.path;
  const url = String(source?.url || "");
  if (/^https?:/i.test(url)) next.url = url;
  else if (url.startsWith("/")) {
    try {
      next.url = new URL(url, globalThis.location?.href || "http://127.0.0.1/").href;
    } catch {
      /* keep blob/path only */
    }
  }
  return next.blob || next.url || next.path ? next : null;
}

async function openInBrowserPdf() {
  if (platform.canFallbackToBrowser?.()) {
    await fallbackToBrowser();
    return;
  }
  if (nativePdf?.path && typeof globalThis.pywebview?.api?.open_native === "function") {
    if (await globalThis.pywebview.api.open_native()) return;
  }
  if (nativePdf?.blob) {
    const url = URL.createObjectURL(nativePdf.blob);
    const opened = window.open(url, "_blank");
    if (opened == null) {
      URL.revokeObjectURL(url);
      throw new Error(t("openOriginalFailed"));
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  if (nativePdf?.url) {
    if (window.open(nativePdf.url, "_blank") == null) throw new Error(t("openOriginalFailed"));
    return;
  }
  throw new Error(t("openOriginalFailed"));
}

function syncToolbar(state) {
  const hasDoc = Boolean(viewer.pdf);
  const documentTitle = viewer.name || t("noFile");
  $("page-controls").hidden = !hasDoc;
  $("page-divider").hidden = !hasDoc;
  $("page-input").value = hasDoc ? String(state.page || 1) : "—";
  $("page-input").disabled = !hasDoc;
  $("page-count").textContent = hasDoc ? String(viewer.pageCount || 0) : "—";
  $("doc-title").textContent = documentTitle;
  $("doc-title").title = documentTitle;
  $("doc-title").setAttribute("aria-label", documentTitle);
  $("doc-title-menu-label").textContent = documentTitle;
  $("btn-doc-title-menu").title = documentTitle;
  $("btn-doc-title-menu").setAttribute("aria-label", documentTitle);
  if (!docTitlePopover.hidden) fillDocTitlePopover();
  repositionDocTitlePopover();
  $("drop-hint").classList.toggle("hidden", hasDoc);
  // The central empty state owns the primary open action until a document exists.
  $("btn-open").hidden = !hasDoc;
  $("btn-doc-properties").hidden = !hasDoc;
  syncZoom(viewer.pinch ? viewer.pinch.target * 100 : state.zoom);
  $("btn-back").disabled = !history.canBack();
  $("btn-forward").disabled = !history.canForward();
  updateOutlineActive();
  scheduleSaveReadingPosition();
  syncTabTitle();
}

function stepPage(delta) {
  if (!viewer.pageCount) return;
  const next = Math.min(viewer.pageCount, Math.max(1, viewer.currentPage + delta));
  if (next === viewer.currentPage) return;
  viewer.goToPage(next, { push: true });
}

function readingStateToSave() {
  if (!currentFingerprint || !viewer.pdf) return null;
  const state = viewer.getState();
  if (clearedReadingPosition?.fingerprint === currentFingerprint) {
    const previous = clearedReadingPosition.state;
    if (state.page === previous.page && state.zoom === previous.zoom &&
        state.scrollTop === previous.scrollTop && state.scrollLeft === previous.scrollLeft) return null;
    clearedReadingPosition = null;
  }
  return state;
}

function scheduleSaveReadingPosition() {
  if (!readingStateToSave()) return;
  clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(() => {
    positionSaveTimer = 0;
    const state = readingStateToSave();
    if (state) saveReadingPosition(currentFingerprint, state);
  }, 400);
}

function flushReadingPosition() {
  clearTimeout(positionSaveTimer);
  positionSaveTimer = 0;
  const state = readingStateToSave();
  if (state) saveReadingPosition(currentFingerprint, state);
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
  // Dual-rail left pane is always outline; compact still gates on the outline tab.
  // Collapsed chrome uses inert/CSS — keep the same mode+branches rule as before.
  const show = (dualRailActive || sidebarMode === "outline") && hasBranches;
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

/** @type {{ key?: string, values?: Record<string, unknown>, error?: Error } | null} */
let viewerStatusDescriptor = null;

function localizedErrorMessage(error) {
  return formatExtensionError(error, t) || error?.message || String(error ?? "");
}

function viewerStatusText() {
  if (!viewerStatusDescriptor) return "";
  if (viewerStatusDescriptor.key) {
    const values = { ...viewerStatusDescriptor.values };
    if (values.error) values.message = localizedErrorMessage(values.error);
    return t(viewerStatusDescriptor.key, values);
  }
  return localizedErrorMessage(viewerStatusDescriptor.error);
}

function showViewerStatus(text, { action = false, descriptor = null } = {}) {
  const box = $("viewer-status");
  if (!box) return;
  viewerStatusDescriptor = descriptor;
  $("viewer-status-text").textContent = text;
  const btn = $("viewer-status-action");
  if (btn) btn.hidden = !action;
  box.hidden = false;
}

function hideViewerStatus() {
  const box = $("viewer-status");
  if (box) box.hidden = true;
  const text = $("viewer-status-text");
  if (text) text.textContent = "";
  const action = $("viewer-status-action");
  if (action) action.hidden = true;
  const restore = $("viewer-status-restore");
  if (restore) restore.hidden = true;
  viewerStatusDescriptor = null;
}

function refreshViewerStatus() {
  const box = $("viewer-status");
  if (!box || box.hidden || !viewerStatusDescriptor) return;
  const text = viewerStatusText();
  $("viewer-status-text").textContent = text;
  if (!viewer.pdf && viewerStatusDescriptor.key === "openFailed") {
    $("outline-pane").textContent = text;
  }
}

let userZoomTouched = false;
function markZoomTouched() {
  if (viewer.pdf) userZoomTouched = true;
}

function hideReadingNotice() {
  clearTimeout(readingNoticeTimer);
  $("reading-notice").hidden = true;
}

function showReadingNotice(page) {
  hideReadingNotice();
  $("reading-notice-text").textContent = t("readingRestored", { page });
  $("reading-notice").hidden = false;
  readingNoticeTimer = setTimeout(hideReadingNotice, 10000);
}

$("btn-reading-notice-close").addEventListener("click", hideReadingNotice);
$("btn-reading-start").addEventListener("click", () => {
  viewer.goToPage(1, { push: true });
  hideReadingNotice();
});
$("viewer-status-restore").addEventListener("click", async () => {
  const previous = recoverableDocument;
  if (previous) await openSource(previous.getSource, { restore: previous });
});

async function openSource(getSource, { restore = null } = {}) {
  const request = ++openGeneration;
  searchGeneration += 1;
  flushReadingPosition();
  if (!restore && viewer.pdf && activeDocument) {
    recoverableDocument = { ...activeDocument, state: viewer.getState() };
  }
  activeDocument = null;
  hideReadingNotice();
  $("viewer-status-restore").hidden = true;
  clearTimeout(indexRefreshTimer);
  indexRefreshTimer = 0;
  clearTimeout(searchTimer);
  cancelTranslate();
  cancelAsk();
  clearAskUi({ keepQuestion: false });
  viewer.close();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  nativePdf = null;
  syncOriginalPdfButton();
  currentFingerprint = "";
  clearedReadingPosition = null;
  $("search-input").value = "";
  $("search-clear").hidden = true;
  renderSearchList([], "");
  $("outline-pane").replaceChildren();
  outlineTreeApi = null;
  outlineTitles = [];
  outlineEntries = [];
  outlineAutoReveal = true;
  syncOutlineTreeActions();
  hideBubble({ force: true });
  showViewerStatus(t("opening"), { descriptor: { key: "opening" } });
  try {
    const source = await getSource();
    if (request !== openGeneration) return false;
    if (restore && platform.id === "desktop" && source.id) {
      if (!await platform.restoreFile(source.id)) throw new Error(t("openDocumentFailed"));
      if (request !== openGeneration) return false;
    }
    const fingerprint = restore?.fingerprint || readingFingerprint(source);
    // PDF.js can transfer MIME bytes to its worker. Retain a Blob source for
    // recovery, without keeping a second PDF rendering context alive.
    const recoveryBlob = source.data ? new Blob([source.data], { type: "application/pdf" }) : null;
    const reopen = recoveryBlob ? () => {
      objectUrl = URL.createObjectURL(recoveryBlob);
      return { ...source, data: undefined, url: objectUrl };
    } : getSource;
    const opened = await viewer.open(source);
    if (request !== openGeneration) return false;
    if (!opened) {
      // Closed mid-open without a newer open taking over the chrome.
      hideViewerStatus();
      return false;
    }
    // Drop the opening splash as soon as the PDF is ready — reading restore /
    // outline work can still take a beat and must not keep covering the page.
    hideViewerStatus();
    currentFingerprint = fingerprint;
    nativePdf = restore?.nativePdf || nativePdfFromSource(source, recoveryBlob);
    activeDocument = { getSource: reopen, fingerprint, name: source.name, nativePdf };
    syncOriginalPdfButton();
    const saved = restore?.state || loadReadingPosition(currentFingerprint, source);
    if (saved) {
      viewer.applyReadingPosition(saved);
      markZoomTouched();
      showReadingNotice(saved.page || saved.anchor?.page || viewer.currentPage || 1);
    } else if (!userZoomTouched) {
      // First open fits the full page; later opens respect the user's zoom.
      viewer.setZoom("page-fit", { silent: true });
    }
    await renderOutline(request);
    if (request !== openGeneration) return false;
    if ($("search-input").value.trim()) {
      await runSearch($("search-input").value);
    }
    if (request !== openGeneration) return false;
    recoverableDocument = null;
    return true;
  } catch (error) {
    if (request === openGeneration) {
      const message = t("openFailed", { message: localizedErrorMessage(error) });
      $("outline-pane").textContent = message;
      showViewerStatus(message, {
        action: true,
        descriptor: { key: "openFailed", values: { error } },
      });
      $("viewer-status-restore").hidden = !recoverableDocument;
    }
    return false;
  }
}

async function openFile(file) {
  applyTabTitle(file?.name);
  const opened = await openSource(() => {
    objectUrl = URL.createObjectURL(file);
    return {
      url: objectUrl,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
    };
  });
  if (opened) {
    if (platform.id === "extension") platform.clearBrowserFallback?.();
    nativePdf = { blob: file };
    activeDocument.nativePdf = nativePdf;
    syncOriginalPdfButton();
  }
  return opened;
}

async function openFromPlatform(meta) {
  applyTabTitle(meta?.name);
  return openSource(() => ({
    url: meta.url,
    data: meta.data,
    withCredentials: meta.withCredentials,
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
    outlineTitles = [];
    outlineEntries = [];
    outlineAutoReveal = true;
    syncOutlineTreeActions();
    pane.removeAttribute("role");
    pane.removeAttribute("aria-label");
    if (!outline?.length) {
      pane.innerHTML = `<div class="empty-side">${t("noOutline")}</div>`;
      // Late outline with no entries must not kick the user out of search/ask.
      // Dual-rail may keep the right pane open while the left outline stays empty.
      if (dualRailActive) {
        selectSidebar("outline");
      } else if (sidebarMode !== "search" && sidebarMode !== "ask") {
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
  pane.setAttribute("aria-label", t("documentOutline"));
  // Flat entries in mount order with parent links, so the active path can be
  // revealed without DOM tree-walking.
  const entries = [];
  const titles = [];
  const setEntryExpanded = (entry, expanded) => {
    entry.branch?.classList.toggle("expanded", expanded);
    entry.toggle?.setAttribute("aria-expanded", String(expanded));
    if (entry.hasChildren) entry.node?.setAttribute("aria-expanded", String(expanded));
  };
  const mount = (items, depth, container, parentEntry) => {
    for (const item of items) {
      const title = item.title || t("unnamed");
      if (item.title) titles.push(item.title);
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
        toggle.setAttribute("aria-label", `${t("toggleBranch")} ${title}`);
        toggle.title = t("toggleBranch");
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("class", "icon");
        icon.setAttribute("aria-hidden", "true");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", "#i-disclosure");
        icon.append(use);
        toggle.append(icon);
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
        btn.setAttribute("aria-description", t("pageDescription", { page }));
      }
      row.append(toggle, btn);
      node.append(row);
      const entry = { node, branch: null, toggle, btn, parent: parentEntry, hasChildren, title, page, pdfY: Number(item.pdfY), depth, dest: item.dest };
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
  outlineTitles = titles;
  outlineEntries = entries.map((entry) => ({
    title: entry.title,
    pageNumber: Number.isFinite(entry.page) && entry.page > 0 ? entry.page : 0,
    depth: entry.depth,
  }));
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
  const restoreHitFocus = list.contains(document.activeElement)
    && document.activeElement.classList.contains("search-hit");
  let activeButton = null;
  const count = $("search-count");
  list.replaceChildren();
  $("search-prev").disabled = hits.length === 0;
  $("search-next").disabled = hits.length === 0;
  if (!query) {
    count.hidden = true;
    list.innerHTML = `<div class="empty-side">${t("searchPrompt")}</div>`;
    return;
  }
  count.hidden = false;
  if (!hits.length) {
    count.textContent = t("zeroResults");
    list.innerHTML = `<div class="empty-side">${t("noMatches")}</div>`;
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
  if (start > 0) moreButton(t("previousResults"), Math.max(0, start - 200));
  hits.slice(start, end).forEach((hit, localIndex) => {
    const index = start + localIndex;
    const btn = document.createElement("button");
    btn.className = `search-hit${index === viewer.hitIndex ? " active" : ""}`;
    if (index === viewer.hitIndex) activeButton = btn;
    btn.innerHTML = `<div class="meta">${t("pageMeta", { page: hit.pageNumber, current: index + 1, total: hits.length })}</div>
      <div class="snippet">${highlightSnippet(hit.snippet, query, searchOptions)}</div>`;
    btn.addEventListener("click", async () => {
      try {
        await viewer.jumpToHit(index, { push: true });
        if (searchHits === hits && $("search-input").value === query) renderSearchList(hits, query, undefined, true);
      } catch (error) {
        if (searchHits === hits) list.textContent = t("locateFailed", { message: error.message || error });
      }
    });
    list.appendChild(btn);
  });
  if (end < hits.length) moreButton(t("nextResults"), end);
  list.scrollTop = previousScroll;
  if (restoreHitFocus) activeButton?.focus({ preventScroll: true });
  if (reveal && activeButton && !isSidebarCollapsed() && sidebarMode === "search") {
    // Scroll only the results container; keep keyboard navigation within the list.
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
    const options = { ...searchOptions };
    const hits = searchDocument(viewer.pageTexts, query, options);
    if (globalThis.__PDF_BENCH__) {
      globalThis.__pdfSearchBench = {
        searchDocumentMs: performance.now() - searchStarted,
        hitCount: hits.length,
        query,
      };
    }
    const unchanged = !jump && hits.length === searchHits.length && viewer.query === query
      && searchResultOptions?.matchCase === options.matchCase
      && searchResultOptions?.wholeWord === options.wholeWord;
    // Keep the result list independent of page rendering: showHits may await
    // jumpToHit → renderPage for the current target only.
    const shown = unchanged
      ? null
      : viewer.showHits(hits, query, jump ? 0 : Math.max(0, viewer.hitIndex), { jump, historyGroup: jump ? "search-input" : null });
    if (!current()) {
      await shown;
      return;
    }
    searchResultOptions = options;
    renderSearchList(unchanged ? searchHits : hits, query, undefined, jump);
    if (globalThis.__PDF_BENCH__) {
      globalThis.__pdfSearchBench.resultListVisibleMs = performance.now() - searchStarted;
    }
    if (query && jump) openSearch();
    if (shown) await shown;
    if (!current()) return;
    if (globalThis.__PDF_BENCH__) {
      globalThis.__pdfSearchBench.firstJumpMs = performance.now() - searchStarted;
    }
    if (query) {
      if (viewer.indexError) {
        const warning = document.createElement("div");
        warning.className = "empty-side";
        warning.textContent = t("partialIndex");
        $("search-list").appendChild(warning);
      } else if (viewer.indexedPages < viewer.pageCount) {
        $("search-count").textContent += ` · ${t("indexing", { current: viewer.indexedPages, total: viewer.pageCount })}`;
      }
    }
  } catch (error) {
    if (current()) $("search-list").textContent = t("searchFailed", { message: error.message || error });
  }
}

let sidebarMode = "outline";
let railMode = "search";
let dualRailActive = false;
const DUAL_RAIL_MIN = 1280;
const SIDEBAR_MIN_WIDTH = 272;
const SIDEBAR_MAX_WIDTH = 480;

/* Full-screen desktop displays get a wider outline by default; the compact
   bounds above stay authoritative below 1920px so existing behavior and
   saved widths are unchanged. */
function sidebarBounds() {
  const width = Number(window.innerWidth) || 0;
  if (width >= 3840) return { min: 420, max: 720 };
  if (width >= 2560) return { min: 360, max: 640 };
  if (width >= 1920) return { min: 320, max: 560 };
  return { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH };
}

const SIDEBAR_WIDTH_STORAGE_KEY = "fast-pdf-viewer-sidebar-width-v1";
const RAIL_WIDTH_STORAGE_KEY = "fast-pdf-viewer-rail-width-v1";
const sidebarResizeHandle = $("sidebar-resize-handle");
const railResizeHandle = $("rail-resize-handle");
sidebarResizeHandle?.setAttribute("role", "separator");
sidebarResizeHandle?.setAttribute("aria-orientation", "vertical");
sidebarResizeHandle?.setAttribute("aria-label", t("resizeSidebar"));
sidebarResizeHandle?.setAttribute("aria-valuemin", String(sidebarBounds().min));
railResizeHandle?.setAttribute("role", "separator");
railResizeHandle?.setAttribute("aria-orientation", "vertical");
railResizeHandle?.setAttribute("aria-label", t("resizeRail"));
railResizeHandle?.setAttribute("aria-valuemin", String(sidebarBounds().min));

function isDualRail() {
  return (Number(window.innerWidth) || 0) >= DUAL_RAIL_MIN;
}

function readSavedPanelWidth(key) {
  const bounds = sidebarBounds();
  try {
    const saved = Number(globalThis.localStorage?.getItem(key));
    return Number.isFinite(saved) && saved > 0
      ? Math.min(bounds.max, Math.max(bounds.min, Math.round(saved)))
      : bounds.min;
  } catch {
    return bounds.min;
  }
}

function getPanelWidthMax(otherOpenWidth = 0) {
  const workspace = document.querySelector(".workspace");
  const workspaceWidth = workspace?.getBoundingClientRect?.().width || 0;
  const viewportWidth = Number(window.innerWidth) || workspaceWidth || SIDEBAR_MAX_WIDTH;
  const bounds = sidebarBounds();
  const availableWidth = viewportWidth <= 900
    ? viewportWidth - 24
    : Math.max(bounds.min, workspaceWidth - 320 - otherOpenWidth);
  return Math.max(bounds.min, Math.min(bounds.max, availableWidth));
}

let sidebarWidth = readSavedPanelWidth(SIDEBAR_WIDTH_STORAGE_KEY);
let railWidth = readSavedPanelWidth(RAIL_WIDTH_STORAGE_KEY);

function setSidebarWidth(width) {
  const bounds = sidebarBounds();
  const other = dualRailActive && !isRailCollapsed() ? railWidth : 0;
  sidebarWidth = Math.min(getPanelWidthMax(other), Math.max(bounds.min, Math.round(width)));
  document.documentElement?.style?.setProperty("--sidebar-w", `${sidebarWidth}px`);
  sidebarResizeHandle?.setAttribute("aria-valuemin", String(bounds.min));
  sidebarResizeHandle?.setAttribute("aria-valuenow", String(sidebarWidth));
  sidebarResizeHandle?.setAttribute("aria-valuemax", String(getPanelWidthMax(other)));
}

function setRailWidth(width) {
  const bounds = sidebarBounds();
  const other = !isSidebarCollapsed() ? sidebarWidth : 0;
  railWidth = Math.min(getPanelWidthMax(other), Math.max(bounds.min, Math.round(width)));
  document.documentElement?.style?.setProperty("--rail-w", `${railWidth}px`);
  railResizeHandle?.setAttribute("aria-valuemin", String(bounds.min));
  railResizeHandle?.setAttribute("aria-valuenow", String(railWidth));
  railResizeHandle?.setAttribute("aria-valuemax", String(getPanelWidthMax(other)));
}

function saveSidebarWidth() {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  } catch {
    // The current session can still use the resized width when storage is unavailable.
  }
}

function saveRailWidth() {
  try {
    globalThis.localStorage?.setItem(RAIL_WIDTH_STORAGE_KEY, String(railWidth));
  } catch {
    // The current session can still use the resized width when storage is unavailable.
  }
}

function reflowAfterSidebarResize() {
  if (Number(window.innerWidth) > 900) runAutoZoomReflow();
}

function placeSearchAskPanes(dual) {
  const search = $("search-pane");
  const ask = $("ask-pane");
  if (!search || !ask) return;
  if (dual) {
    const host = $("rail-panes");
    if (host && search.parentElement !== host) {
      // Restore the source panel's saved tab stops before transferring ownership.
      syncSidebarTabStops(false);
      host.append(search, ask);
    }
    return;
  }
  const host = $("sidebar")?.querySelector(".sidebar-inner");
  const outline = $("outline-pane");
  if (!host || !outline || search.parentElement === host) return;
  syncRailTabStops(false);
  outline.after(search);
  search.after(ask);
}

function syncPaneVisibility() {
  const dual = dualRailActive;
  $("outline-pane")?.classList.toggle("active", dual || sidebarMode === "outline");
  $("search-pane")?.classList.toggle("active", dual ? railMode === "search" : sidebarMode === "search");
  $("ask-pane")?.classList.toggle("active", dual ? railMode === "ask" : sidebarMode === "ask");
  $("sidebar-tab-outline")?.setAttribute("aria-selected", String(sidebarMode === "outline"));
  $("sidebar-tab-search")?.setAttribute("aria-selected", String(sidebarMode === "search"));
  $("sidebar-tab-ask")?.setAttribute("aria-selected", String(sidebarMode === "ask"));
  $("sidebar-tab-outline")?.classList.toggle("active", sidebarMode === "outline");
  $("sidebar-tab-search")?.classList.toggle("active", sidebarMode === "search");
  $("sidebar-tab-ask")?.classList.toggle("active", sidebarMode === "ask");
  $("rail-tab-search")?.setAttribute("aria-selected", String(railMode === "search"));
  $("rail-tab-ask")?.setAttribute("aria-selected", String(railMode === "ask"));
  $("rail-tab-search")?.classList.toggle("active", railMode === "search");
  $("rail-tab-ask")?.classList.toggle("active", railMode === "ask");
}

function selectSidebar(name) {
  sidebarMode = name;
  if (!dualRailActive) syncPaneVisibility();
  else {
    $("outline-pane")?.classList.toggle("active", true);
    $("sidebar-tab-outline")?.setAttribute("aria-selected", "true");
    $("sidebar-tab-search")?.setAttribute("aria-selected", "false");
    $("sidebar-tab-ask")?.setAttribute("aria-selected", "false");
  }
  syncSearchButton();
  syncAskButton();
  syncOutlineTreeActions();
}

function selectRail(name) {
  railMode = name === "ask" ? "ask" : "search";
  if (dualRailActive) syncPaneVisibility();
  syncSearchButton();
  syncAskButton();
}

function isSidebarCollapsed() {
  return document.querySelector(".workspace").classList.contains("sidebar-collapsed");
}

function isRailCollapsed() {
  return document.querySelector(".workspace").classList.contains("rail-collapsed");
}

function syncSearchButton() {
  const open = dualRailActive
    ? !isRailCollapsed() && railMode === "search"
    : sidebarMode === "search" && !isSidebarCollapsed();
  $("btn-search-toggle")?.setAttribute("aria-expanded", String(open));
  $("btn-search-toggle")?.classList.toggle("active", open);
}

function syncAskButton() {
  const open = dualRailActive
    ? !isRailCollapsed() && railMode === "ask"
    : sidebarMode === "ask" && !isSidebarCollapsed();
  $("btn-ask-toggle")?.setAttribute("aria-expanded", String(open));
  $("btn-ask-toggle")?.classList.toggle("active", open);
}

function openSearch() {
  if (dualRailActive) {
    selectRail("search");
    setRailCollapsed(false);
  } else {
    selectSidebar("search");
    setSidebarCollapsed(false);
  }
  $("search-input").focus();
}

function openAsk() {
  if (dualRailActive) {
    selectRail("ask");
    setRailCollapsed(false);
  } else {
    selectSidebar("ask");
    setSidebarCollapsed(false);
  }
  $("ask-input")?.focus();
}

function applyDualRailLayout(dual, { crossing = false } = {}) {
  const wasDual = dualRailActive;
  // Flip before open/close so setRailCollapsed/selectSidebar see the target layout.
  dualRailActive = dual;
  placeSearchAskPanes(dual);
  document.querySelector(".workspace")?.classList.toggle("dual-rail", dual);
  const leftTabs = $("sidebar")?.querySelector(".sidebar-tabs");
  if (leftTabs) leftTabs.hidden = dual;

  if (dual && !wasDual) {
    // Entering desktop dual-rail.
    if (crossing && (sidebarMode === "search" || sidebarMode === "ask")) {
      railMode = sidebarMode;
      selectSidebar("outline");
      setSidebarCollapsed(true);
      setRailCollapsed(false);
      selectRail(railMode);
    } else {
      selectSidebar("outline");
      setRailCollapsed(true);
      syncPaneVisibility();
    }
  } else if (!dual && wasDual) {
    // Leaving dual-rail: prefer the open right pane when collapsing to one column.
    if (crossing && !isRailCollapsed()) {
      sidebarMode = railMode;
      setRailCollapsed(true);
      setSidebarCollapsed(false);
      selectSidebar(sidebarMode);
    } else {
      setRailCollapsed(true);
      if (sidebarMode !== "outline" && sidebarMode !== "search" && sidebarMode !== "ask") {
        sidebarMode = "outline";
      }
      syncPaneVisibility();
    }
  } else {
    syncPaneVisibility();
  }

  syncSidebarTabStops(isSidebarCollapsed());
  syncRailTabStops(isRailCollapsed() || !dualRailActive);
  setSidebarWidth(sidebarWidth);
  setRailWidth(railWidth);
  syncSearchButton();
  syncAskButton();
  syncOutlineTreeActions();
}

setSidebarWidth(sidebarWidth);
setRailWidth(railWidth);
applyDualRailLayout(isDualRail());

function cancelAsk() {
  askAbort?.abort();
  askAbort = null;
}

function setAskStatus(message, { error = false } = {}) {
  const status = $("ask-status");
  if (!status) return;
  if (!message) {
    status.hidden = true;
    status.textContent = "";
    status.classList.remove("is-error");
    return;
  }
  status.hidden = false;
  status.textContent = message;
  status.classList.toggle("is-error", error);
}

function setThinkingFold(wrapId, bodyId, text, enabled, streaming = false) {
  renderThinking({ wrap: $(wrapId), body: $(bodyId), preview: $(`${bodyId}-preview`), status: $(`${bodyId}-status`) }, text, {
    enabled, streaming, label: (active, seconds) => active ? t("thinkingActive") : t("thinkingDone", { seconds }),
  });
}

function clearAskUi({ keepQuestion = true } = {}) {
  askHits = [];
  askCitationIndex = -1;
  askGeneration += 1;
  if (!keepQuestion) {
    askLastQuestion = "";
    if ($("ask-input")) $("ask-input").value = "";
  }
  setAskStatus("");
  $("ask-empty").hidden = false;
  $("ask-result").hidden = true;
  $("ask-answer").textContent = "";
  $("ask-answer").classList.remove("is-streaming");
  setThinkingFold("ask-thinking-wrap", "ask-thinking", "", false);
  $("ask-citations").replaceChildren();
  $("ask-citations-wrap").hidden = true;
  $("ask-citations-wrap").open = false;
  $("ask-result-actions").hidden = true;
  $("ask-retry").hidden = true;
  $("ask-setup").hidden = true;
  $("ask-stop").hidden = true;
  $("ask-submit").disabled = false;
  $("ask-reading-log").replaceChildren();
  $("ask-reading-wrap").hidden = true;
}

function recordAskProgress(event) {
  const labels = {
    search: () => t("askSearchStep", { query: event.query, count: event.total }),
    read: () => t("askReadStep", { start: event.start, end: event.end }),
    image: () => t("askImageStep", { page: event.page }),
    full: () => t("askFullStep", { count: event.pages.length }),
    retrieval: () => t("askInitialStep", { pages: event.pages.join(", ") }),
    compatibility: () => t("askCompatibility"),
  };
  const text = labels[event.type]?.();
  if (!text) return;
  const row = document.createElement("li");
  row.textContent = text;
  $("ask-reading-log").appendChild(row);
  $("ask-reading-wrap").hidden = false;
  setAskStatus(text);
}

async function waitForAskIndex(signal) {
  const pending = viewer.indexPromise;
  if (!pending) return;
  let abort;
  try {
    await Promise.race([pending, new Promise((_, reject) => {
      abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function renderAskCitations(hits) {
  askHits = hits;
  const list = $("ask-citations");
  const wrap = $("ask-citations-wrap");
  list.replaceChildren();
  if (!hits.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  hits.forEach((hit, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `search-hit${index === askCitationIndex ? " active" : ""}`;
    const snippet = hit.snippet || hit.quote || t("pageDescription", { page: hit.pageNumber });
    btn.innerHTML = `<div class="meta">${t("pageDescription", { page: hit.pageNumber })}</div>
      <div class="snippet">${highlightSnippet(snippet, hit.quote || "")}</div>`;
    btn.addEventListener("click", async () => {
      try {
        await jumpToAskCitation(index);
        renderAskCitations(askHits);
      } catch (error) {
        setAskStatus(t("locateFailed", { message: error.message || error }), { error: true });
      }
    });
    list.appendChild(btn);
  });
}

function renderAskAnswer(text, hits = []) {
  renderMarkdown($("ask-answer"), text, { renderReference({ pageNumber, label }) {
    const index = hits.findIndex(hit => (hit.sourcePageNumber || hit.pageNumber) === pageNumber);
    if (index < 0) return document.createTextNode(label);
    const hit = hits[index];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ask-page-reference";
    button.textContent = hit.pageNumber === pageNumber ? label : t("pageDescription", { page: hit.pageNumber });
    button.title = t(hit.kind === "quote" ? "askJumpQuote" : "askJumpPage", { page: hit.pageNumber });
    button.addEventListener("click", async () => {
      try {
        await jumpToAskCitation(index);
        renderAskCitations(askHits);
      } catch (error) {
        setAskStatus(t("locateFailed", { message: error.message || error }), { error: true });
      }
    });
    return button;
  } });
}

async function jumpToAskCitation(index) {
  const hit = askHits[index];
  if (!hit) return;
  askCitationIndex = index;
  if (hit.kind === "quote" && hit.length > 0) {
    await viewer.showHits(askHits, hit.quote || " ", index, {
      jump: true,
      historyGroup: "ask-citation",
    });
    return;
  }
  viewer.clearHits();
  viewer.goToPage(hit.pageNumber, { push: true });
}

async function runAsk(question = $("ask-input")?.value || "") {
  const trimmed = String(question || "").trim();
  if (!trimmed) {
    setAskStatus(t("askEmptyQuestion"), { error: true });
    return;
  }
  if (!viewer.pdf) {
    setAskStatus(t("noFile"), { error: true });
    return;
  }
  askLastQuestion = trimmed;
  if ($("ask-input")) $("ask-input").value = trimmed;
  cancelAsk();
  const request = ++askGeneration;
  const controller = new AbortController();
  askAbort = controller;
  askHits = [];
  askCitationIndex = -1;
  $("ask-empty").hidden = true;
  $("ask-result").hidden = false;
  $("ask-answer").textContent = "";
  $("ask-answer").classList.add("is-streaming");
  setThinkingFold("ask-thinking-wrap", "ask-thinking", "", false);
  $("ask-citations").replaceChildren();
  $("ask-citations-wrap").hidden = true;
  $("ask-citations-wrap").open = false;
  $("ask-result-actions").hidden = true;
  $("ask-retry").hidden = true;
  $("ask-setup").hidden = true;
  $("ask-stop").hidden = false;
  $("ask-submit").disabled = true;
  setAskStatus(t("askAnswering"));
  $("ask-reading-log").replaceChildren();
  $("ask-reading-wrap").hidden = true;

  try {
    if (viewer.indexedPages < viewer.pageCount) setAskStatus(t("askIndexing", { current: viewer.indexedPages, total: viewer.pageCount }));
    await waitForAskIndex(controller.signal);
    if (request !== askGeneration || controller.signal.aborted) return;
    setAskStatus(t("askAnswering"));
    const result = await askDocument({
      pageTexts: viewer.pageTexts,
      outlineTitles: outlineEntries.length ? outlineEntries : outlineTitles,
      question: trimmed,
      currentPage: viewer.currentPage || 1,
      settings: loadSettings(),
      signal: controller.signal,
      pageCount: viewer.pageCount,
      readPageImage: (page, signal) => viewer.getPageImage(page, signal),
      onProgress: event => { if (request === askGeneration) recordAskProgress(event); },
      onDelta: (preview, _raw, extras) => {
        if (request !== askGeneration) return;
        renderAskAnswer(preview);
        setThinkingFold("ask-thinking-wrap", "ask-thinking", extras?.reasoning, loadSettings().showThinking === true, true);
      },
    });
    if (request !== askGeneration) return;
    $("ask-answer").classList.remove("is-streaming");
    renderAskAnswer(result.answer, result.hits);
    setThinkingFold("ask-thinking-wrap", "ask-thinking", result.reasoning, loadSettings().showThinking === true);
    renderAskCitations(result.hits);
    const notes = [];
    if (result.scope?.chapter) {
      notes.push(t("askChapterNote", {
        chapter: result.scope.chapter,
        start: result.scope.start,
        end: result.scope.end,
      }));
    }
    notes.push(result.mode === "full" ? t("askFullStep", { count: result.readPages.length })
      : t("askCoverage", { searches: result.searches.length, pages: result.readPages.join(", ") }));
    if (result.budgetReached) notes.push(t("askBudgetReached"));
    if (viewer.indexedPages < viewer.pageCount) {
      notes.push(t("askIndexing", { current: viewer.indexedPages, total: viewer.pageCount }));
    }
    setAskStatus(notes.join(" · "));
    $("ask-result-actions").hidden = false;
    $("ask-retry").hidden = false;
  } catch (error) {
    if (request !== askGeneration) return;
    $("ask-answer").classList.remove("is-streaming");
    const message = error?.message || String(error);
    const missingKey = /API Key|api key/i.test(message) || message === t("apiKeyRequired");
    if (!$("ask-answer").textContent.trim()) {
      $("ask-empty").hidden = true;
      $("ask-result").hidden = false;
      $("ask-answer").textContent = "";
    }
    setAskStatus(controller.signal.aborted ? t("askCancelled") : missingKey ? t("apiKeyRequired") : t("askFailed", { message }), { error: !controller.signal.aborted });
    $("ask-result-actions").hidden = false;
    $("ask-retry").hidden = missingKey;
    $("ask-setup").hidden = !missingKey;
  } finally {
    if (request === askGeneration) {
      setThinkingFold("ask-thinking-wrap", "ask-thinking", $("ask-thinking").textContent, loadSettings().showThinking === true);
      askAbort = null;
      $("ask-stop").hidden = true;
      $("ask-submit").disabled = false;
    }
  }
}

let autoZoomReflowToken = 0;

function runAutoZoomReflow() {
  if (!viewer.pdf || !["page-width", "page-fit"].includes(viewer.zoomMode)) return;
  viewer.setZoom(viewer.zoomMode, { silent: true });
  syncZoom(viewer.zoomMode);
}

function scheduleAutoZoomReflow() {
  if (!viewer.pdf || !["page-width", "page-fit"].includes(viewer.zoomMode)) return;
  const sidebar = $("sidebar");
  const token = ++autoZoomReflowToken;
  const finish = () => {
    if (token !== autoZoomReflowToken) return;
    autoZoomReflowToken += 1;
    runAutoZoomReflow();
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

function setPanelInert(panel, collapsed) {
  if (!panel) return;
  panel.setAttribute("aria-hidden", collapsed ? "true" : "false");
  try {
    if (collapsed) panel.setAttribute("inert", "");
    else panel.removeAttribute("inert");
    panel.inert = collapsed;
  } catch {
    /* inert not supported: aria-hidden still hides it from AT */
  }
}

function setSidebarCollapsed(collapsed) {
  if (collapsed) history.endGroup?.();
  document.querySelector(".workspace").classList.toggle("sidebar-collapsed", collapsed);
  setPanelInert($("sidebar"), collapsed);
  syncSidebarTabStops(collapsed);
  $("btn-sidebar").classList.toggle("active", !collapsed);
  $("btn-sidebar").setAttribute("aria-pressed", collapsed ? "false" : "true");
  syncSearchButton();
  syncAskButton();
  syncOutlineTreeActions();
  scheduleAutoZoomReflow();
}

function syncRailTabStops(collapsed) {
  const rail = $("rail");
  if (!rail) return;
  const focusables = rail.querySelectorAll(
    "button, input, select, textarea, a[href], [tabindex]",
  );
  for (const el of focusables) {
    if (collapsed) {
      if (el.dataset.railTabindex == null) {
        el.dataset.railTabindex = el.getAttribute("tabindex") ?? "";
      }
      el.tabIndex = -1;
      el.setAttribute("aria-hidden", "true");
    } else {
      const prev = el.dataset.railTabindex;
      if (prev != null) {
        if (prev === "") el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", prev);
        delete el.dataset.railTabindex;
      } else {
        el.removeAttribute("tabindex");
      }
      el.removeAttribute("aria-hidden");
    }
  }
}

function setRailCollapsed(collapsed) {
  document.querySelector(".workspace").classList.toggle("rail-collapsed", collapsed);
  setPanelInert($("rail"), collapsed || !dualRailActive);
  syncRailTabStops(collapsed || !dualRailActive);
  syncSearchButton();
  syncAskButton();
  scheduleAutoZoomReflow();
}

let sidebarResizeDrag = null;
sidebarResizeHandle?.addEventListener("pointerdown", (event) => {
  if (event.isPrimary === false || (event.button != null && event.button !== 0) || isSidebarCollapsed()) return;
  event.preventDefault();
  sidebarResizeDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: sidebarWidth,
    changed: false,
  };
  document.querySelector(".workspace").classList.toggle("is-sidebar-resizing", true);
  try {
    sidebarResizeHandle.setPointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture may be unavailable in older embedded browsers.
  }
});

sidebarResizeHandle?.addEventListener("pointermove", (event) => {
  if (!sidebarResizeDrag || event.pointerId !== sidebarResizeDrag.pointerId) return;
  const previousWidth = sidebarWidth;
  setSidebarWidth(sidebarResizeDrag.startWidth + event.clientX - sidebarResizeDrag.startX);
  sidebarResizeDrag.changed ||= sidebarWidth !== previousWidth;
});

function finishSidebarResize(event) {
  if (!sidebarResizeDrag || (event?.pointerId != null && event.pointerId !== sidebarResizeDrag.pointerId)) return;
  const changed = sidebarResizeDrag.changed;
  try {
    sidebarResizeHandle?.releasePointerCapture?.(sidebarResizeDrag.pointerId);
  } catch {
    // The pointer may already have been released by the browser.
  }
  sidebarResizeDrag = null;
  document.querySelector(".workspace").classList.toggle("is-sidebar-resizing", false);
  if (changed) {
    saveSidebarWidth();
    reflowAfterSidebarResize();
  }
}

sidebarResizeHandle?.addEventListener("pointerup", finishSidebarResize);
sidebarResizeHandle?.addEventListener("pointercancel", finishSidebarResize);
sidebarResizeHandle?.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 48 : 16;
  let nextWidth;
  if (event.key === "ArrowRight") nextWidth = sidebarWidth + step;
  else if (event.key === "ArrowLeft") nextWidth = sidebarWidth - step;
  else if (event.key === "Home") nextWidth = sidebarBounds().min;
  else if (event.key === "End") nextWidth = getPanelWidthMax(dualRailActive && !isRailCollapsed() ? railWidth : 0);
  else return;
  event.preventDefault();
  const previousWidth = sidebarWidth;
  setSidebarWidth(nextWidth);
  if (sidebarWidth !== previousWidth) {
    saveSidebarWidth();
    reflowAfterSidebarResize();
  }
});

let railResizeDrag = null;
railResizeHandle?.addEventListener("pointerdown", (event) => {
  if (event.isPrimary === false || (event.button != null && event.button !== 0) || isRailCollapsed() || !dualRailActive) return;
  event.preventDefault();
  railResizeDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: railWidth,
    changed: false,
  };
  document.querySelector(".workspace").classList.toggle("is-rail-resizing", true);
  try {
    railResizeHandle.setPointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture may be unavailable in older embedded browsers.
  }
});

railResizeHandle?.addEventListener("pointermove", (event) => {
  if (!railResizeDrag || event.pointerId !== railResizeDrag.pointerId) return;
  const previousWidth = railWidth;
  // Dragging the left edge of the right rail: moving left grows the rail.
  setRailWidth(railResizeDrag.startWidth + (railResizeDrag.startX - event.clientX));
  railResizeDrag.changed ||= railWidth !== previousWidth;
});

function finishRailResize(event) {
  if (!railResizeDrag || (event?.pointerId != null && event.pointerId !== railResizeDrag.pointerId)) return;
  const changed = railResizeDrag.changed;
  try {
    railResizeHandle?.releasePointerCapture?.(railResizeDrag.pointerId);
  } catch {
    // The pointer may already have been released by the browser.
  }
  railResizeDrag = null;
  document.querySelector(".workspace").classList.toggle("is-rail-resizing", false);
  if (changed) {
    saveRailWidth();
    reflowAfterSidebarResize();
  }
}

railResizeHandle?.addEventListener("pointerup", finishRailResize);
railResizeHandle?.addEventListener("pointercancel", finishRailResize);
railResizeHandle?.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 48 : 16;
  let nextWidth;
  if (event.key === "ArrowLeft") nextWidth = railWidth + step;
  else if (event.key === "ArrowRight") nextWidth = railWidth - step;
  else if (event.key === "Home") nextWidth = sidebarBounds().min;
  else if (event.key === "End") nextWidth = getPanelWidthMax(!isSidebarCollapsed() ? sidebarWidth : 0);
  else return;
  event.preventDefault();
  const previousWidth = railWidth;
  setRailWidth(nextWidth);
  if (railWidth !== previousWidth) {
    saveRailWidth();
    reflowAfterSidebarResize();
  }
});

let viewportReflowTimer = 0;
window.addEventListener("resize", () => {
  const nextDual = isDualRail();
  if (nextDual !== dualRailActive) applyDualRailLayout(nextDual, { crossing: true });
  if (!sidebarResizeDrag) setSidebarWidth(readSavedPanelWidth(SIDEBAR_WIDTH_STORAGE_KEY));
  if (!railResizeDrag) setRailWidth(readSavedPanelWidth(RAIL_WIDTH_STORAGE_KEY));
  clearTimeout(viewportReflowTimer);
  viewportReflowTimer = setTimeout(() => {
    viewportReflowTimer = 0;
    runAutoZoomReflow();
  }, 120);
});

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
// 目录: dual-rail only toggles the left outline; compact mode keeps the old
// outline/search/ask mutual-exclusion behavior.
$("btn-sidebar").addEventListener("click", () => {
  if (dualRailActive) {
    setSidebarCollapsed(!isSidebarCollapsed());
    if (!isSidebarCollapsed()) selectSidebar("outline");
    return;
  }
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
$("sidebar-tab-ask")?.addEventListener("click", () => {
  openAsk();
});
$("rail-tab-search")?.addEventListener("click", () => {
  openSearch();
});
$("rail-tab-ask")?.addEventListener("click", () => {
  openAsk();
});
$("btn-rail-close")?.addEventListener("click", () => setRailCollapsed(true));
$("ask-submit")?.addEventListener("click", () => {
  runAsk();
});
$("ask-stop")?.addEventListener("click", () => {
  cancelAsk();
});
$("ask-retry")?.addEventListener("click", () => {
  runAsk(askLastQuestion || $("ask-input")?.value || "");
});
$("ask-setup")?.addEventListener("click", () => {
  openSettings();
});
$("ask-input")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    runAsk();
  } else if (event.key === "Escape") {
    event.preventDefault();
    if (askAbort) cancelAsk();
    else if (dualRailActive) {
      setRailCollapsed(true);
      $("btn-ask-toggle")?.focus();
    } else {
      setSidebarCollapsed(true);
      $("btn-sidebar")?.focus();
    }
  }
});
const outlineExpandAllBtn = $("btn-outline-expand-all");
if (outlineExpandAllBtn) {
  outlineExpandAllBtn.title = t("expandAll");
  outlineExpandAllBtn.setAttribute("aria-label", t("expandAll"));
  outlineExpandAllBtn.addEventListener("click", () => expandAllOutlineNodes());
}
const outlineCollapseAllBtn = $("btn-outline-collapse-all");
if (outlineCollapseAllBtn) {
  outlineCollapseAllBtn.title = t("collapseAll");
  outlineCollapseAllBtn.setAttribute("aria-label", t("collapseAll"));
  outlineCollapseAllBtn.addEventListener("click", () => collapseAllOutlineNodes());
}
$("btn-sidebar-close").addEventListener("click", () => setSidebarCollapsed(true));
// 默认收起：空文档、无目录文档都是全宽页面，目录按需打开。
selectSidebar("outline");
setSidebarCollapsed(true);
setRailCollapsed(true);
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
  if (dualRailActive) {
    if (!isRailCollapsed() && railMode === "search") setRailCollapsed(true);
    else openSearch();
    return;
  }
  if (sidebarMode === "search" && !isSidebarCollapsed()) setSidebarCollapsed(true);
  else openSearch();
});
$("btn-ask-toggle")?.addEventListener("click", () => {
  if (dualRailActive) {
    if (!isRailCollapsed() && railMode === "ask") setRailCollapsed(true);
    else openAsk();
    return;
  }
  openAsk();
});
function pageInputValue(raw) {
  const digits = String(raw || "").trim();
  if (!/^\d+$/.test(digits)) return null;
  const page = Number(digits);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
}

function commitPageInput(input) {
  if (input.disabled || !viewer.pageCount) return;
  const page = pageInputValue(input.value);
  const next = Math.min(viewer.pageCount, page || viewer.currentPage || 1);
  input.value = String(next);
  if (page) viewer.goToPage(next, { push: true });
}

$("page-input").addEventListener("change", (event) => {
  commitPageInput(event.target);
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
    commitPageInput(event.target);
  }
});

let searchTimer = 0;
for (const [id, key] of [["search-match-case", "matchCase"], ["search-whole-word", "wholeWord"]]) {
  const button = $(id);
  button.setAttribute("aria-pressed", String(searchOptions[key]));
  button.addEventListener("click", () => {
    searchOptions[key] = !searchOptions[key];
    button.setAttribute("aria-pressed", String(searchOptions[key]));
    const request = ++searchGeneration;
    clearTimeout(searchTimer);
    clearTimeout(indexRefreshTimer);
    indexRefreshTimer = 0;
    viewer.clearHits();
    const query = $("search-input").value;
    if (query) runSearch(query, request);
    else renderSearchList([], "");
  });
}
$("search-input").addEventListener("input", (event) => {
  const query = event.target.value;
  const request = ++searchGeneration;
  $("search-clear").hidden = !query;
  clearTimeout(searchTimer);
  viewer.clearHits();
  if (!query) {
    history.endGroup?.();
    renderSearchList([], "");
  }
  searchTimer = setTimeout(() => runSearch(query, request), 180);
});
$("search-clear").addEventListener("click", () => {
  history.endGroup?.();
  searchGeneration += 1;
  clearTimeout(searchTimer);
  viewer.clearHits();
  $("search-input").value = "";
  $("search-clear").hidden = true;
  renderSearchList([], "");
  $("search-input").focus();
});
$("search-input").addEventListener("keydown", async (event) => {
  if (searchHits.length && (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    if (event.shiftKey || event.key === "ArrowUp") await moveHit(-1);
    else await moveHit(1);
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (dualRailActive) setRailCollapsed(true);
    else setSidebarCollapsed(true);
    $("btn-search-toggle")?.focus();
  }
});
$("search-list").addEventListener("keydown", async (event) => {
  if (!event.target?.closest?.(".search-hit") || !searchHits.length) return;
  if (event.key !== "Enter" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  if (event.shiftKey || event.key === "ArrowUp") await moveHit(-1);
  else await moveHit(1);
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
    if (searchHits === hits) $("search-list").textContent = t("locateFailed", { message: error.message || error });
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
    scaleFactor: event.scale / nativeGestureScale,
    clientX: event.clientX, clientY: event.clientY,
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
  const propertiesOpen = !$("doc-properties-modal").hidden;
  if (settingsOpen || passwordOpen || propertiesOpen) {
    // Modals own Escape/Tab; background reading shortcuts stay isolated.
    if (event.key === "Escape" && settingsOpen) {
      event.preventDefault();
      closeSettings();
    }
    if (event.key === "Escape" && propertiesOpen) {
      event.preventDefault();
      closeDocumentProperties();
    }
    return;
  }
  const typing = event.target?.matches?.("input, textarea, select, [contenteditable]") || event.target?.isContentEditable;
  const inReaderChrome = event.target?.closest?.(".toolbar, #sidebar, #zoom-menu, #translate-bubble, #translate-chip");
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    pickFile();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openSearch();
    $("search-input").select();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.shiftKey && !typing && !inReaderChrome) {
    if (showPdfSelection({ explicit: true, dismissEmpty: false })) event.preventDefault();
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
  if (viewer.pdf && !typing && !inReaderChrome && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    const direction = event.key === "ArrowDown" || event.key === "PageDown" ? 1
      : event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 0;
    if (direction && event.altKey && event.key.startsWith("Page")) {
      event.preventDefault();
      stepPage(direction);
    } else if (direction && !event.altKey) {
      event.preventDefault();
      const distance = event.key.startsWith("Page") ? Math.max(80, wrap.clientHeight * 0.9) : 48;
      wrap.scrollTop = Math.max(0, wrap.scrollTop + direction * distance);
    }
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (!$("translate-bubble").hidden) {
      hideBubble({ force: true });
      return;
    }
    if (!$("zoom-menu").hidden) {
      setZoomMenuOpen(false);
      return;
    }
    if (dualRailActive && !isRailCollapsed()) {
      setRailCollapsed(true);
      if (railMode === "search") $("btn-search-toggle")?.focus();
      else $("btn-ask-toggle")?.focus();
      return;
    }
    if (!isSidebarCollapsed() && (sidebarMode === "search" || sidebarMode === "ask")) {
      setSidebarCollapsed(true);
      if (sidebarMode === "search") $("btn-search-toggle")?.focus();
      else $("btn-sidebar")?.focus();
    }
  }
});

const bubble = $("translate-bubble");
const translateChip = $("translate-chip");
const bubblePinButton = $("btn-bubble-pin");
const bubbleHeader = $("bubble-header");
const bubbleDragHandle = $("bubble-drag-handle");
const bubbleResizeHandle = $("bubble-resize-handle");
let selectedText = "";
let translateChipText = "";
let selectedTranslationMode = "passage";
let bubbleSelectionRect = null;
let isBubblePinned = false;
let isBubbleManuallyPositioned = false;
let bubbleDrag = null;
let bubblePositionRevision = 0;
let bubbleResize = null;
let bubbleRequestedWidth = null;
let bubbleRequestedHeight = null;

function isAutoTranslateOn() {
  return loadSettings().autoTranslateOnSelect !== false;
}

function syncBubbleModel() {
  const modelLabel = $("bubble-model");
  if (!modelLabel) return;
  const label = formatBubbleModelLabel(loadSettings());
  modelLabel.textContent = label;
  modelLabel.title = label;
}

function syncBubbleTargetLanguage(targetLang = loadSettings().targetLang) {
  const picker = $("bubble-target-lang");
  if (picker) picker.value = targetLang;
  const settingsPicker = $("setting-lang");
  if (settingsPicker) settingsPicker.value = targetLang;
}

function queueSettingsSave(next) {
  const save = () => saveSettings(next);
  const pending = settingsSaveQueue.then(save, save);
  settingsSaveQueue = pending.catch(() => {});
  return pending;
}

function currentSelectionRect() {
  const viewport = wrap.getBoundingClientRect();
  const anchored = getSelectionAnchorFromSelection(window.getSelection(), viewport);
  return anchored || bubbleSelectionRect;
}

function syncBubblePinButton() {
  const label = isBubblePinned ? t("unpinTranslation") : t("pinTranslation");
  bubblePinButton.title = label;
  bubblePinButton.setAttribute("aria-label", label);
  bubblePinButton.setAttribute("aria-pressed", String(isBubblePinned));
  bubblePinButton.classList.toggle("is-pinned", isBubblePinned);
  bubble.classList.toggle("is-pinned", isBubblePinned);
}

function setBubblePinned(pinned) {
  const wasPinned = isBubblePinned;
  isBubblePinned = Boolean(pinned);
  syncBubblePinButton();
  if (bubble.hidden) return;
  if (wasPinned && !isBubblePinned) {
    // Keep the current screen position when unpinning; discard any older
    // scroll/resize reposition that was queued while the bubble was pinned.
    bubblePositionRevision += 1;
    return;
  }
  repositionBubble();
}

function finishBubbleDrag(event) {
  if (!bubbleDrag) return;
  if (event?.pointerId != null && bubbleDrag.pointerId != null && event.pointerId !== bubbleDrag.pointerId) return;
  const pointerId = bubbleDrag.pointerId;
  bubbleDrag = null;
  bubble.classList.toggle("is-dragging", false);
  if (pointerId != null && bubbleHeader.hasPointerCapture?.(pointerId)) {
    bubbleHeader.releasePointerCapture(pointerId);
  }
}

function bubbleSizeLimits(viewport, top = viewport.top + 8) {
  const margin = 8;
  const availableWidth = Math.max(1, viewport.right - viewport.left - margin * 2);
  const maxHeight = Math.max(72, Math.min(viewport.height * 0.7, viewport.bottom - margin - top));
  return { minWidth: Math.min(320, availableWidth), maxWidth: Math.min(720, availableWidth), maxHeight };
}

function applyBubbleRequestedSize(viewport, top = viewport.top + 8) {
  const limits = bubbleSizeLimits(viewport, top);
  const width = Math.min(limits.maxWidth, Math.max(limits.minWidth, bubbleRequestedWidth ?? 420));
  bubble.style.width = `${width}px`;
  bubble.style.maxWidth = `${limits.maxWidth}px`;
  if (bubbleRequestedHeight == null) {
    bubble.style.height = "";
  } else {
    bubble.style.height = `${Math.min(limits.maxHeight, Math.max(160, bubbleRequestedHeight))}px`;
  }
  bubble.style.maxHeight = `${limits.maxHeight}px`;
  return { ...limits, width };
}

function finishBubbleResize(event) {
  if (!bubbleResize) return;
  if (event?.pointerId != null && bubbleResize.pointerId != null && event.pointerId !== bubbleResize.pointerId) return;
  const pointerId = bubbleResize.pointerId;
  bubbleResize = null;
  bubble.classList.toggle("is-resizing", false);
  syncBubbleEdgeCursor(null);
  if (pointerId != null && bubble.hasPointerCapture?.(pointerId)) {
    bubble.releasePointerCapture(pointerId);
  }
}

function bubbleResizeEdges(event, rect) {
  const edge = 9;
  const x = event.clientX;
  const y = event.clientY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < rect.left - edge || x > rect.right + edge || y < rect.top - edge || y > rect.bottom + edge) return null;
  if (x > rect.left + edge && x < rect.right - edge && y > rect.top + edge && y < rect.bottom - edge) return null;
  const left = x <= rect.left + edge;
  const right = x >= rect.right - edge;
  const top = y <= rect.top + edge;
  const bottom = y >= rect.bottom - edge;
  if (!left && !right && !top && !bottom) return null;
  return { left, right, top, bottom };
}

function bubbleResizeCursor(edges) {
  if (!edges) return "";
  if ((edges.left && edges.top) || (edges.right && edges.bottom)) return "nwse-resize";
  if ((edges.right && edges.top) || (edges.left && edges.bottom)) return "nesw-resize";
  if (edges.left || edges.right) return "ew-resize";
  return "ns-resize";
}

function bubblePointerOnControl(event) {
  const closest = event.target?.closest?.bind?.(event.target);
  if (!closest) return false;
  return Boolean(
    closest("button")
    || closest("select, option")
    || closest("input, textarea, label, a")
  );
}

function syncBubbleEdgeCursor(edges) {
  const cursor = bubbleResizeCursor(edges);
  const root = document.documentElement;
  bubble.classList.toggle("is-edge-resize", Boolean(cursor));
  bubble.style.cursor = cursor;
  root?.classList?.toggle("bubble-edge-resize", Boolean(cursor));
  root?.style?.setProperty?.("--bubble-edge-cursor", cursor || "");
}

function updateBubbleResize(event) {
  if (!bubbleResize || (event.pointerId != null && bubbleResize.pointerId != null && event.pointerId !== bubbleResize.pointerId)) return;
  event.preventDefault();
  event.stopPropagation();
  const viewport = wrap.getBoundingClientRect();
  const edge = bubbleResize.edges;
  const dx = event.clientX - bubbleResize.x;
  const dy = event.clientY - bubbleResize.y;
  const margin = 8;
  const minLeft = viewport.left + margin;
  const maxRight = viewport.right - margin;
  const minTop = viewport.top + margin;
  const maxBottom = viewport.bottom - margin;
  let left = bubbleResize.rect.left;
  let top = bubbleResize.rect.top;
  let right = bubbleResize.rect.right;
  let bottom = bubbleResize.rect.bottom;
  if (edge.left) left = Math.min(right - 1, Math.max(minLeft, bubbleResize.rect.left + dx));
  if (edge.right) right = Math.max(left + 1, Math.min(maxRight, bubbleResize.rect.right + dx));
  if (edge.top) top = Math.min(bottom - 1, Math.max(minTop, bubbleResize.rect.top + dy));
  if (edge.bottom) bottom = Math.max(top + 1, Math.min(maxBottom, bubbleResize.rect.bottom + dy));
  const limits = bubbleSizeLimits(viewport, top);
  const widthSpace = edge.left ? right - minLeft : edge.right ? maxRight - left : limits.maxWidth;
  const maxWidth = Math.min(limits.maxWidth, Math.max(1, widthSpace));
  const minWidth = Math.min(limits.minWidth, maxWidth);
  const width = Math.min(maxWidth, Math.max(minWidth, right - left));
  const heightSpace = edge.top ? bottom - minTop : edge.bottom ? maxBottom - top : limits.maxHeight;
  const maxHeight = Math.min(limits.maxHeight, Math.max(1, heightSpace));
  const minHeight = Math.min(160, maxHeight);
  const height = Math.min(maxHeight, Math.max(minHeight, bottom - top));
  if (edge.left) left = right - width;
  else right = left + width;
  if (edge.top) top = bottom - height;
  else bottom = top + height;
  bubbleRequestedWidth = width;
  bubbleRequestedHeight = height;
  isBubbleManuallyPositioned = true;
  $("btn-bubble-reset-size").hidden = false;
  applyBubbleRequestedSize(viewport, top);
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

function startBubbleResize(event) {
  if (bubble.hidden || bubbleResize) return;
  if (bubblePointerOnControl(event)) return;
  if (event.isPrimary === false || (event.button != null && event.button !== 0)) return;
  const rect = bubble.getBoundingClientRect();
  const edges = bubbleResizeEdges(event, rect);
  if (!edges) return;
  event.preventDefault();
  event.stopPropagation();
  bubbleResize = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, edges };
  bubble.classList.toggle("is-resizing", true);
  syncBubbleEdgeCursor(edges);
  try { bubble.setPointerCapture?.(event.pointerId); } catch { /* capture may be unavailable */ }
}

// Document capture runs before the header drag and before an outside click
// closes the bubble. Rounded corners otherwise let the top corners hit the
// page underneath.
document.addEventListener("pointerdown", startBubbleResize, true);
bubble.addEventListener("pointerdown", startBubbleResize, true);
document.addEventListener("pointermove", (event) => {
  if (bubble.hidden || bubbleResize || bubbleDrag) return;
  if (bubblePointerOnControl(event)) {
    syncBubbleEdgeCursor(null);
    return;
  }
  syncBubbleEdgeCursor(bubbleResizeEdges(event, bubble.getBoundingClientRect()));
}, true);
bubble.addEventListener("pointermove", (event) => {
  if (bubbleResize) {
    updateBubbleResize(event);
    return;
  }
  if (bubbleDrag) return;
  syncBubbleEdgeCursor(bubbleResizeEdges(event, bubble.getBoundingClientRect()));
});
bubble.addEventListener("pointerup", finishBubbleResize);
bubble.addEventListener("pointercancel", finishBubbleResize);
bubble.addEventListener("lostpointercapture", finishBubbleResize);
bubble.addEventListener("pointerleave", () => {
  if (bubbleResize) return;
  syncBubbleEdgeCursor(null);
});

bubbleHeader.addEventListener("pointerdown", (event) => {
  if (bubblePointerOnControl(event)) return;
  if (event.isPrimary === false || (event.button != null && event.button !== 0)) return;
  if (bubbleResize || bubbleResizeEdges(event, bubble.getBoundingClientRect())) return;
  event.preventDefault();
  isBubbleManuallyPositioned = true;
  keepPinnedBubbleInView();
  const rect = bubble.getBoundingClientRect();
  const left = Number.parseFloat(bubble.style.left);
  const top = Number.parseFloat(bubble.style.top);
  bubbleDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - (Number.isFinite(left) ? left : rect.left),
    offsetY: event.clientY - (Number.isFinite(top) ? top : rect.top),
  };
  bubble.classList.toggle("is-dragging", true);
  if (event.pointerId != null) {
    try { bubbleHeader.setPointerCapture?.(event.pointerId); } catch { /* capture may be unavailable */ }
  }
  event.stopPropagation();
});

bubbleHeader.addEventListener("pointermove", (event) => {
  if (!bubbleDrag || (event.pointerId != null && bubbleDrag.pointerId != null && event.pointerId !== bubbleDrag.pointerId)) return;
  event.preventDefault();
  bubble.style.left = `${event.clientX - bubbleDrag.offsetX}px`;
  bubble.style.top = `${event.clientY - bubbleDrag.offsetY}px`;
  keepPinnedBubbleInView();
  event.stopPropagation();
});

bubbleHeader.addEventListener("pointerup", finishBubbleDrag);
bubbleHeader.addEventListener("pointercancel", finishBubbleDrag);
bubbleHeader.addEventListener("lostpointercapture", finishBubbleDrag);
bubbleResizeHandle.addEventListener("keydown", (event) => {
  const amount = event.shiftKey ? 48 : 16;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const viewport = wrap.getBoundingClientRect();
  const limits = bubbleSizeLimits(viewport, Number.parseFloat(bubble.style.top) || viewport.top + 8);
  bubbleRequestedWidth = Math.min(limits.maxWidth, Math.max(limits.minWidth, (bubbleRequestedWidth ?? bubble.offsetWidth) + (event.key === "ArrowRight" ? amount : event.key === "ArrowLeft" ? -amount : 0)));
  bubbleRequestedHeight = Math.min(limits.maxHeight, Math.max(160, (bubbleRequestedHeight ?? bubble.offsetHeight) + (event.key === "ArrowDown" ? amount : event.key === "ArrowUp" ? -amount : 0)));
  $("btn-bubble-reset-size").hidden = false;
  applyBubbleRequestedSize(viewport);
  repositionBubble();
});
bubbleDragHandle.addEventListener("keydown", (event) => {
  const distance = event.shiftKey ? 48 : 16;
  const movement = {
    ArrowLeft: [-distance, 0],
    ArrowRight: [distance, 0],
    ArrowUp: [0, -distance],
    ArrowDown: [0, distance],
  }[event.key];
  if (!movement) return;
  event.preventDefault();
  isBubbleManuallyPositioned = true;
  keepPinnedBubbleInView();
  const rect = bubble.getBoundingClientRect();
  const left = Number.parseFloat(bubble.style.left);
  const top = Number.parseFloat(bubble.style.top);
  bubble.style.left = `${(Number.isFinite(left) ? left : rect.left) + movement[0]}px`;
  bubble.style.top = `${(Number.isFinite(top) ? top : rect.top) + movement[1]}px`;
  keepPinnedBubbleInView();
});

function keepPinnedBubbleInView() {
  const viewport = wrap.getBoundingClientRect();
  const margin = 8;
  applyBubbleRequestedSize(viewport);

  const minLeft = viewport.left + margin;
  const maxLeft = Math.max(minLeft, viewport.right - margin - bubble.offsetWidth);
  const minTop = viewport.top + margin;
  const maxTop = Math.max(minTop, viewport.bottom - margin - 72);
  const currentLeft = Number.parseFloat(bubble.style.left);
  const currentTop = Number.parseFloat(bubble.style.top);
  const left = Math.min(Math.max(Number.isFinite(currentLeft) ? currentLeft : minLeft, minLeft), maxLeft);
  const top = Math.min(Math.max(Number.isFinite(currentTop) ? currentTop : minTop, minTop), maxTop);
  bubble.style.left = left + "px";
  bubble.style.top = top + "px";
  const limits = bubbleSizeLimits(viewport, top);
  bubble.style.maxHeight = `${limits.maxHeight}px`;
  if (bubbleRequestedHeight != null) bubble.style.height = `${Math.min(limits.maxHeight, Math.max(160, bubbleRequestedHeight))}px`;
}

function repositionBubble() {
  if (bubble.hidden) return;
  if (isBubblePinned || isBubbleManuallyPositioned) {
    keepPinnedBubbleInView();
    return;
  }
  const rect = currentSelectionRect();
  if (!rect) return;
  const viewport = wrap.getBoundingClientRect();
  const size = applyBubbleRequestedSize(viewport);
  applyBubblePlacement(bubble, rect, viewport, { absoluteMax: 720, preferredWidth: size.width });
  const maxHeight = Math.max(72, Math.min(viewport.height * 0.7, Number.parseFloat(bubble.style.maxHeight) || viewport.height));
  bubble.style.maxHeight = `${maxHeight}px`;
  if (bubbleRequestedHeight != null) bubble.style.height = `${Math.min(maxHeight, Math.max(160, bubbleRequestedHeight))}px`;
}

function scheduleRepositionBubble() {
  const positionRevision = bubblePositionRevision;
  requestAnimationFrame(() => {
    repositionTranslateChip();
    if (positionRevision !== bubblePositionRevision) return;
    repositionBubble();
  });
}

function clearStreamingResult() {
  $("btn-copy").disabled = true;
  $("btn-copy").hidden = true;
  $("btn-translate-stop").hidden = true;
  const result = $("translate-result");
  result.classList.remove("streaming");
  result.replaceChildren();
  result.hidden = true;
}

function cancelTranslate() {
  translateAbort?.abort();
  translateAbort = null;
  clearStreamingResult();
}

function hideTranslateChip() {
  translateChip.hidden = true;
  translateChipText = "";
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

function hideBubble({ force = false } = {}) {
  if (isBubblePinned && !force) return;
  isBubblePinned = false;
  isBubbleManuallyPositioned = false;
  syncBubblePinButton();
  bubbleSelectionRect = null;
  hideTranslateChip();
  invalidateBubbleCopy();
  bubble.hidden = true;
  const result = $("translate-result");
  result.hidden = true;
  result.classList.remove("error", "setup-required", "streaming");
  result.textContent = "";
  setThinkingFold("bubble-thinking-wrap", "bubble-thinking", "", false);
  cancelTranslate();
}

function showTranslateChip(selectionRect, text) {
  translateChipText = text;
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
  invalidateBubbleCopy();
  const selectionId = ++bubbleSelectionId;
  selectedText = text;
  bubbleSelectionRect = selectionRect;
  isBubbleManuallyPositioned = false;
  syncBubbleModel();
  syncBubbleTargetLanguage();
  const source = $("translate-source");
  renderBubbleSource(source, text, selectedTranslationMode);
  updateSourceFold();
  const result = $("translate-result");
  $("btn-copy").hidden = true;
  $("btn-translate-stop").hidden = true;
  result.hidden = true;
  result.classList.remove("error", "streaming");
  result.replaceChildren();
  bubble.hidden = false;
  repositionBubble();
  if (startTranslate) void runTranslate(selectionId);
  return selectionId;
}

$("bubble-target-lang").addEventListener("change", async (event) => {
  const targetLang = event.target.value;
  const revision = ++bubbleTargetLangRevision;
  syncBubbleTargetLanguage(targetLang);
  // Invalidate callbacks immediately so an in-flight response cannot paint in
  // the previous language while the setting is being persisted.
  translateRequestId += 1;
  cancelTranslate();
  try {
    settings = await queueSettingsSave({ targetLang });
    if (revision !== bubbleTargetLangRevision) return;
    syncBubbleTargetLanguage(settings.targetLang);
    if (!bubble.hidden && selectedText) void runTranslate(bubbleSelectionId);
  } catch {
    if (revision !== bubbleTargetLangRevision) return;
    syncBubbleTargetLanguage(loadSettings().targetLang);
  }
});

function updateSourceFold() {
  const source = $("translate-source");
  const toggle = $("btn-source-toggle");
  if (!source || !toggle) return;
  const long = (selectedText || "").length > 120;
  const expanded = toggle.dataset.expanded === "true";
  renderBubbleSource(source, selectedText, selectedTranslationMode, { full: expanded });
  source.classList.toggle("collapsed", long && !expanded);
  toggle.hidden = !long;
  toggle.textContent = expanded ? t("collapseSource") : t("expandSource");
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
  $("btn-copy").disabled = true;
  $("btn-copy").hidden = true;
  $("btn-translate-stop").hidden = true;
  result.hidden = false;
  result.classList.remove("error", "setup-required", "streaming");
  result.replaceChildren();
  if (isMissingKeyError(message)) {
    result.classList.add("setup-required");
    translateAwaitingKey = true;
    result.append(document.createTextNode(`${t("translateKeyRequired")} `));
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "link-btn";
    settingsBtn.id = "btn-translate-settings";
    settingsBtn.textContent = t("setupTranslation");
    settingsBtn.addEventListener("click", () => openSettings());
    result.append(settingsBtn);
  } else {
    result.classList.add("error");
    result.append(document.createTextNode(`${message} `));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "link-btn";
    retry.id = "btn-translate-retry";
    retry.textContent = t("retry");
    retry.addEventListener("click", () => runTranslate(selectionId));
    translateAwaitingKey = false;
    result.append(retry);
  }
}

function setTranslateStopped(selectionId) {
  setThinkingFold("bubble-thinking-wrap", "bubble-thinking", $("bubble-thinking").textContent, loadSettings().showThinking === true);
  const result = $("translate-result");
  result.hidden = false;
  result.classList.remove("error", "setup-required", "streaming");
  result.replaceChildren();
  result.append(document.createTextNode(`${t("translationStopped")} `));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "link-btn";
  retry.id = "btn-translate-retry";
  retry.textContent = t("retry");
  retry.addEventListener("click", () => runTranslate(selectionId));
  result.append(retry);
}

async function runTranslate(selectionId = bubbleSelectionId) {
  if (selectionId !== bubbleSelectionId) return;
  invalidateBubbleCopy();
  cancelTranslate();
  const text = selectedText;
  if (!text) return;
  if (text.length > MAX_TRANSLATE_CHARS) {
    setTranslateError(t("textTooLong", { count: text.length, max: MAX_TRANSLATE_CHARS }), selectionId);
    return;
  }
  const result = $("translate-result");
  result.classList.remove("error", "setup-required");
  showStreamingCaret(result);
  $("btn-translate-stop").hidden = false;
  setThinkingFold("bubble-thinking-wrap", "bubble-thinking", "", false);
  scheduleRepositionBubble();

  const controller = new AbortController();
  translateAbort = controller;
  const requestId = ++translateRequestId;
  let lastReasoning = "";

  try {
    const translated = await translateText(text, loadSettings(), {
      signal: controller.signal,
      mode: selectedTranslationMode,
      onDelta: (partial, extras) => {
        if (requestId !== translateRequestId || selectionId !== bubbleSelectionId) return;
        if (extras?.reasoning) lastReasoning = extras.reasoning;
        renderBubbleTranslation(result, partial, selectedTranslationMode, { streaming: true });
        setThinkingFold("bubble-thinking-wrap", "bubble-thinking", extras?.reasoning, loadSettings().showThinking === true, true);
        scheduleRepositionBubble();
      },
    });
    if (requestId !== translateRequestId || selectionId !== bubbleSelectionId) return;
    result.classList.remove("streaming");
    renderBubbleTranslation(result, translated, selectedTranslationMode);
    setThinkingFold("bubble-thinking-wrap", "bubble-thinking", lastReasoning, loadSettings().showThinking === true);
    const hasTranslation = Boolean(readBubblePlainText(result));
    $("btn-copy").disabled = !hasTranslation;
    $("btn-copy").hidden = !hasTranslation;
    $("btn-translate-stop").hidden = true;
    translateAbort = null;
    scheduleRepositionBubble();
  } catch (error) {
    if (requestId !== translateRequestId || selectionId !== bubbleSelectionId) return;
    if (controller.signal.aborted) {
      clearStreamingResult();
      result.hidden = true;
      return;
    }
    setTranslateError(error.message || String(error), selectionId);
  }
}

// 划词气泡是选区延伸：点击外部 / Esc 关闭；固定后忽略外部点击。
let selectionStartedInTextLayer = false;
document.addEventListener("pointerdown", (event) => {
  selectionStartedInTextLayer = event.button === 0 && Boolean(event.target?.closest?.(".textLayer"));
  if (bubble.hidden) return;
  if (isBubblePinned) return;
  const target = event.target;
  if (bubble.contains(target) || translateChip.contains(target)) return;
  if (target.closest?.(".textLayer")) return;
  if (target.closest?.("#settings-modal, #pdf-password-modal, #doc-properties-modal")) return;
  hideBubble();
});

document.addEventListener("pointercancel", () => {
  selectionStartedInTextLayer = false;
});

document.addEventListener("mouseup", (event) => {
  const selectionDrag = selectionStartedInTextLayer;
  selectionStartedInTextLayer = false;
  if (translateChip.contains(event.target)) return;
  if (bubble.contains(event.target)) {
    hideTranslateChip();
    return;
  }
  // A valid PDF selection may end on the page canvas or in a line gap.
  // Ordinary outside clicks still close the bubble, even if a stale range remains.
  if (!selectionDrag && !event.target?.closest?.(".textLayer")) {
    hideTranslateChip();
    hideBubble();
    return;
  }
  showPdfSelection();
});

function showPdfSelection({ explicit = false, dismissEmpty = true } = {}) {
  const selection = window.getSelection();
  const prepared = selection?.rangeCount ? prepareSelectionForTranslation(selection) : null;
  if (prepared?.tooLong) {
    const range = selection.getRangeAt(0);
    const anchor = getSelectionAnchorRect(range, wrap.getBoundingClientRect(), selection);
    selectedTranslationMode = "passage";
    const selectionId = openTranslatePanel(anchor, "", { startTranslate: false });
    setTranslateError(
      t("textTooLong", { count: prepared.charCount, max: MAX_TRANSLATE_CHARS }),
      selectionId,
    );
    return true;
  }
  const text = prepared?.text || "";
  if (!text || !selection?.rangeCount) {
    if (dismissEmpty) {
      hideTranslateChip();
      hideBubble();
    }
    return false;
  }
  const range = selection.getRangeAt(0);
  const inTextLayer =
    range.endContainer.parentElement?.closest(".textLayer") ||
    range.startContainer.parentElement?.closest(".textLayer");
  if (!inTextLayer) {
    if (dismissEmpty) hideBubble();
    return false;
  }
  selectedTranslationMode = prepared.mode;
  const anchor = getSelectionAnchorRect(range, wrap.getBoundingClientRect(), selection);
  if (explicit || isAutoTranslateOn()) {
    openTranslatePanel(anchor, text);
  } else if (isBubblePinned) {
    showTranslateChip(anchor, text);
  } else {
    bubble.hidden = true;
    cancelTranslate();
    showTranslateChip(anchor, text);
  }
  return true;
}

wrap.addEventListener("scroll", scheduleRepositionBubble, { passive: true });
window.addEventListener("resize", scheduleRepositionBubble);

translateChip.addEventListener("click", (event) => {
  event.stopPropagation();
  const rect = currentSelectionRect() || bubbleSelectionRect;
  if (!rect || !translateChipText) return;
  openTranslatePanel(rect, translateChipText);
});

$("btn-bubble-pin").addEventListener("click", (event) => {
  event.stopPropagation();
  setBubblePinned(!isBubblePinned);
});
syncBubblePinButton();
$("btn-bubble-close").addEventListener("click", () => hideBubble({ force: true }));
$("btn-translate-stop").addEventListener("click", () => {
  translateRequestId += 1;
  translateAwaitingKey = false;
  cancelTranslate();
  setTranslateStopped(bubbleSelectionId);
});
$("btn-bubble-reset-size").addEventListener("click", () => {
  bubbleRequestedWidth = null;
  bubbleRequestedHeight = null;
  $("btn-bubble-reset-size").hidden = true;
  bubble.style.height = "";
  applyBubbleRequestedSize(wrap.getBoundingClientRect());
  repositionBubble();
});
$("btn-source-toggle")?.addEventListener("click", () => {
  const toggle = $("btn-source-toggle");
  toggle.dataset.expanded = toggle.dataset.expanded === "true" ? "false" : "true";
  updateSourceFold();
  scheduleRepositionBubble();
});
const bubbleCopyButton = $("btn-copy");
const bubbleCopyStatus = $("copy-status");
let bubbleCopyFeedbackTimer = 0;
let bubbleCopyRequestId = 0;

function invalidateBubbleCopy() {
  bubbleCopyRequestId += 1;
  syncBubbleCopyFeedback("idle");
}

function syncBubbleCopyFeedback(state, announcement = "") {
  clearTimeout(bubbleCopyFeedbackTimer);
  bubbleCopyFeedbackTimer = 0;

  const labels = {
    idle: t("copyResult"),
    success: t("copied"),
    error: t("copyFailed"),
  };
  bubbleCopyButton.dataset.copyState = state;
  bubbleCopyButton.title = labels[state];
  bubbleCopyButton.setAttribute("aria-label", labels[state]);
  bubbleCopyStatus.textContent = announcement;

  if (state !== "idle") {
    const requestId = bubbleCopyRequestId;
    bubbleCopyFeedbackTimer = setTimeout(() => {
      if (requestId === bubbleCopyRequestId) syncBubbleCopyFeedback("idle");
    }, 2000);
  }
}

bubbleCopyButton.addEventListener("click", async () => {
  const requestId = ++bubbleCopyRequestId;
  const result = $("translate-result");
  if (result.classList.contains("error") || result.classList.contains("streaming")) return;
  const copy = readBubblePlainText(result);
  if (!copy) {
    syncBubbleCopyFeedback("error", t("nothingToCopy"));
    return;
  }

  syncBubbleCopyFeedback("idle");
  try {
    await navigator.clipboard.writeText(copy);
    if (requestId === bubbleCopyRequestId) {
      syncBubbleCopyFeedback("success", t("copySuccessAnnouncement"));
    }
  } catch {
    if (requestId === bubbleCopyRequestId) {
      syncBubbleCopyFeedback("error", t("copyFailureAnnouncement"));
    }
  }
});

const modelPicker = wireModelPicker({
  input: $("setting-model"),
  menu: $("setting-model-menu"),
  status: $("setting-model-status"),
  getCredentials: () => ({
    apiKey: $("setting-key").value.trim(),
    apiBaseUrl: $("setting-base").value.trim(),
    model: $("setting-model").value.trim(),
  }),
});
let initialSettingsApiBase = "";
let settingsEndpointChanged = false;
let uiLanguageSelectionExplicit = false;
const onCredentialInput = () => {
  modelPicker.invalidatePending();
};
$("setting-key").addEventListener("input", onCredentialInput);
$("setting-base").addEventListener("input", () => {
  if (!settingsEndpointChanged && $("setting-base").value.trim() !== initialSettingsApiBase) {
    settingsEndpointChanged = true;
    $("setting-key").value = "";
  }
  onCredentialInput();
  updateApiBaseHost();
});
$("setting-ui-language").addEventListener("change", () => {
  uiLanguageSelectionExplicit = true;
});

function updateApiBaseHost() {
  let host = "";
  try {
    host = new URL($("setting-base").value.trim()).hostname;
  } catch {
    /* show the localized invalid URL hint below */
  }
  const status = $("setting-base-host");
  status.hidden = false;
  status.textContent = host ? t("apiHost", { host }) : t("apiHostInvalid");
}

$("btn-check-models").addEventListener("click", () => {
  void modelPicker.refresh({ focusInput: true });
});

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

let lastDocPropertiesTrigger = null;
let docPropertiesGeneration = 0;

function renderDocumentPropertyRows(rows) {
  const list = $("doc-properties-list");
  if (!list) return;
  list.replaceChildren();
  for (const row of rows) {
    const dt = document.createElement("dt");
    dt.textContent = row.label;
    const dd = document.createElement("dd");
    dd.textContent = row.value;
    list.append(dt, dd);
  }
}

async function openDocumentProperties() {
  if (!viewer.pdf) return;
  lastDocPropertiesTrigger = document.activeElement;
  const request = ++docPropertiesGeneration;
  renderDocumentPropertyRows(buildDocumentPropertyRows({
    fileName: viewer.name,
    pageCount: viewer.pageCount,
  }, t, getLocale()));
  $("doc-properties-modal").hidden = false;
  try {
    document.getElementById("app")?.setAttribute("inert", "");
  } catch {
    /* ignore */
  }
  $("btn-doc-properties-close")?.focus?.();
  try {
    const snapshot = await viewer.getDocumentInfo?.();
    if (request !== docPropertiesGeneration || $("doc-properties-modal").hidden) return;
    renderDocumentPropertyRows(buildDocumentPropertyRows(snapshot || {
      fileName: viewer.name,
      pageCount: viewer.pageCount,
    }, t, getLocale()));
  } catch {
    if (request !== docPropertiesGeneration) return;
  }
}

function closeDocumentProperties(restore = true) {
  docPropertiesGeneration += 1;
  $("doc-properties-modal").hidden = true;
  try {
    document.getElementById("app")?.removeAttribute("inert");
  } catch {
    /* ignore */
  }
  if (restore && lastDocPropertiesTrigger?.focus) {
    try {
      lastDocPropertiesTrigger.focus({ preventScroll: true });
    } catch {
      lastDocPropertiesTrigger.focus();
    }
  }
  lastDocPropertiesTrigger = null;
}

function openSettings() {
  $("settings-error").hidden = true;
  settings = loadSettings();
  uiLanguageSelectionExplicit = settings.uiLanguageSelected === true;
  $("setting-key").value = settings.apiKey;
  $("setting-base").value = settings.apiBaseUrl;
  initialSettingsApiBase = settings.apiBaseUrl.trim();
  settingsEndpointChanged = false;
  updateApiBaseHost();
  $("setting-model").value = settings.model;
  syncBubbleTargetLanguage(settings.targetLang);
  $("setting-ui-language").value = settings.uiLanguage || "zh-CN";
  $("setting-auto-translate").checked = settings.autoTranslateOnSelect !== false;
  if ($("setting-reasoning-effort")) $("setting-reasoning-effort").value = settings.reasoningEffort || "default";
  if ($("setting-show-thinking")) $("setting-show-thinking").checked = settings.showThinking === true;
  if ($("setting-ask-vision")) $("setting-ask-vision").checked = settings.askVisionEnabled === true;
  lastSettingsTrigger = document.activeElement;
  $("settings-modal").hidden = false;
  try {
    document.getElementById("app")?.setAttribute("inert", "");
  } catch {
    /* ignore */
  }
  modelPicker.showPrompt?.();
  // Initial focus goes inside the dialog, not the background trigger.
  ($("setting-key") || $("settings-modal")).focus?.();
}

function closeSettings(restore = true) {
  modelPicker.invalidatePending();
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

$("btn-doc-properties").addEventListener("click", () => {
  void openDocumentProperties();
});
$("btn-doc-properties-close")?.addEventListener("click", () => closeDocumentProperties());
$("doc-properties-modal")?.addEventListener("keydown", (event) => {
  trapModalTab(event, $("doc-properties-modal").querySelector(".modal-card") || $("doc-properties-modal"));
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeDocumentProperties();
  }
  event.stopPropagation();
});
$("doc-properties-modal")?.addEventListener("pointerdown", (event) => {
  if (event.target === $("doc-properties-modal")) closeDocumentProperties();
});
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
$("btn-clear-reading-positions").addEventListener("click", () => {
  clearTimeout(positionSaveTimer);
  positionSaveTimer = 0;
  clearedReadingPosition = currentFingerprint && viewer.pdf
    ? { fingerprint: currentFingerprint, state: viewer.getState() }
    : null;
  clearReadingPositions();
  const status = $("reading-positions-status");
  status.textContent = t("readingPositionsCleared");
  status.hidden = false;
});
$("btn-settings-save").addEventListener("click", async () => {
  const button = $("btn-settings-save");
  const error = $("settings-error");
  const next = {
    apiKey: $("setting-key").value.trim(),
    apiBaseUrl: $("setting-base").value.trim() || "https://openrouter.ai/api/v1",
    model: $("setting-model").value.trim() || "openai/gpt-4o-mini",
    targetLang: $("setting-lang").value,
    uiLanguage: $("setting-ui-language").value,
    uiLanguageSelected: uiLanguageSelectionExplicit,
    autoTranslateOnSelect: $("setting-auto-translate").checked,
    reasoningEffort: $("setting-reasoning-effort")?.value || "default",
    showThinking: $("setting-show-thinking")?.checked === true,
    askVisionEnabled: $("setting-ask-vision")?.checked === true,
  };
  const previousTargetLang = loadSettings().targetLang;
  try {
    if (!isAllowedApiBaseUrl(next.apiBaseUrl)) throw new Error(t("modelEndpointInvalid"));
    // Request from the click handler, before yielding the user gesture.
    const permission = next.apiKey ? requestHostAccess(next.apiBaseUrl) : true;
    button.disabled = true;
    if (!await permission) throw new Error(t("permissionDenied"));
    settings = await queueSettingsSave(next);
    applyInterfaceLanguage(settings.uiLanguage);
    syncBubbleModel();
    syncBubbleTargetLanguage(settings.targetLang);
    const retryTranslate = translateAwaitingKey && settings.apiKey?.trim();
    closeSettings();
    if (retryTranslate || (settings.targetLang !== previousTargetLang && !bubble.hidden && selectedText)) {
      translateAwaitingKey = false;
      void runTranslate(bubbleSelectionId);
    }
  } catch (reason) {
    error.textContent = reason.message || t("saveFailed");
    error.hidden = false;
  } finally {
    button.disabled = false;
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
  $("btn-open").title = `${t("openPdf")} (${open})`;
  const search = $("btn-search-toggle");
  if (search) {
    search.title = `${t("search")} (${find})`;
    search.setAttribute("aria-label", `${t("search")} (${find})`);
  }
  const zoomOut = $("btn-zoom-out");
  if (zoomOut) {
    zoomOut.title = `${t("zoomOut")} (${shortcutChord("-")})`;
    zoomOut.setAttribute("aria-label", `${t("zoomOut")} (${shortcutChord("-")})`);
  }
  const zoomIn = $("btn-zoom-in");
  if (zoomIn) {
    zoomIn.title = `${t("zoomIn")} (${shortcutChord("=")})`;
    zoomIn.setAttribute("aria-label", `${t("zoomIn")} (${shortcutChord("=")})`);
  }
  const hint = $("empty-shortcut");
  if (hint) hint.textContent = open;
}

function applyInterfaceLanguage(locale) {
  setLocale(locale);
  applyDocumentTranslations();
  applyShortcutLabels();

  const options = [...$("zoom-select").options];
  for (let index = 0; index < zoomMenuItems.length; index += 1) {
    zoomMenuItems[index].textContent = options[index]?.textContent || zoomMenuItems[index].textContent;
  }
  const state = viewer.getState?.() || { page: viewer.currentPage || 1, zoom: "page-fit" };
  syncZoom(state.zoom);
  syncToolbar(state);
  syncBubblePinButton();
  updateSourceFold();
  syncBubbleCopyFeedback(bubbleCopyButton.dataset.copyState || "idle");

  for (const toggle of document.querySelectorAll?.(".outline-toggle") || []) {
    toggle.title = t("toggleBranch");
    toggle.setAttribute("aria-label", t("toggleBranch"));
  }
  const searchList = $("search-list");
  if (searchList.childNodes?.length) {
    renderSearchList(searchHits, $("search-input").value, undefined, false);
  }
  refreshViewerStatus();
  if (viewer.pdf || viewerStatusDescriptor?.key === "openFailed") {
    void renderOutline(openGeneration);
  }
  if (!$("doc-properties-modal")?.hidden && viewer.pdf) {
    void viewer.getDocumentInfo?.().then((snapshot) => {
      if ($("doc-properties-modal")?.hidden) return;
      renderDocumentPropertyRows(buildDocumentPropertyRows(snapshot || {
        fileName: viewer.name,
        pageCount: viewer.pageCount,
      }, t, getLocale()));
    });
  }
}

async function boot() {
  pruneReadingPositions();
  applyInterfaceLanguage(settings.uiLanguage);
  document.body.dataset.platform = platform.id;
  $("btn-original-pdf").addEventListener("click", async () => {
    try { await openInBrowserPdf(); }
    catch (error) {
      const message = localizedErrorMessage(error) || t("openOriginalFailed");
      showViewerStatus(message, {
        action: true,
        descriptor: error?.code ? { error } : { key: "openOriginalFailed" },
      });
    }
  });
  if (platform.id === "extension") {
    $("btn-extension-options").hidden = false;
    $("btn-extension-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
  const request = openGeneration;
  try {
    await initSettings();
    settings = loadSettings();
    syncBubbleTargetLanguage(settings.targetLang);
    applyInterfaceLanguage(settings.uiLanguage);
    const startup = await platform.startupOpen();
    if (startup && request === openGeneration) {
      applyTabTitle(startup.name);
      if (platform.canFallbackToBrowser?.()) $("btn-original-pdf").hidden = false;
      await openFromPlatform(startup);
    }
  } catch (error) {
    const message = localizedErrorMessage(error) || t("openDocumentFailed");
    showViewerStatus(message, {
      action: true,
      descriptor: error?.code ? { error } : { key: "openDocumentFailed" },
    });
    if (platform.canFallbackToBrowser?.()) $("btn-original-pdf").hidden = false;
  }
}

window.addEventListener("pagehide", flushReadingPosition);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushReadingPosition();
});

boot();
