import { ViewHistory } from "./history.js";
import { highlightSnippet, searchDocument } from "./search.js";
import { loadSettings, saveSettings } from "./settings.js";
import { translateText } from "./translate.js";
import { PdfViewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);

const history = new ViewHistory();
const viewer = new PdfViewer({
  pagesEl: $("pages"),
  wrapEl: $("viewer-wrap"),
  history,
  onState: syncToolbar,
  onIndex: refreshIndexedSearch,
});

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
}

async function openSource(getSource) {
  const request = ++openGeneration;
  searchGeneration += 1;
  clearTimeout(indexRefreshTimer);
  indexRefreshTimer = 0;
  clearTimeout(searchTimer);
  viewer.close();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  $("search-input").value = "";
  renderSearchList([], "");
  $("outline-pane").replaceChildren();
  hideBubble();
  try {
    const source = await getSource();
    if (request !== openGeneration) return;
    const opened = await viewer.open(source);
    if (!opened || request !== openGeneration) return;
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
    return { url: objectUrl, name: file.name };
  });
}

async function openUrl(name, id) {
  return openSource(() => ({ url: `/opened.pdf?${id ? `id=${encodeURIComponent(id)}` : `t=${Date.now()}`}`, name }));
}

async function renderOutline(request) {
  const pane = $("outline-pane");
  const outline = await viewer.getOutline();
  if (request !== openGeneration) return;
  pane.replaceChildren();
  if (!outline?.length) {
    pane.innerHTML = '<div class="empty-side">这份 PDF 没有目录。</div>';
    return;
  }
  const walk = (items, depth) => {
    for (const item of items) {
      const btn = document.createElement("button");
      btn.className = "outline-item";
      btn.style.paddingLeft = `${10 + depth * 14}px`;
      btn.textContent = item.title || "未命名";
      btn.addEventListener("click", () => viewer.goToDest(item.dest, true));
      pane.appendChild(btn);
      if (item.items?.length) walk(item.items, depth + 1);
    }
  };
  walk(outline, 0);
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
    const hits = searchDocument(viewer.pageTexts, query);
    const unchanged = !jump && hits.length === searchHits.length && viewer.query === query;
    if (!unchanged) await viewer.showHits(hits, query, jump ? 0 : Math.max(0, viewer.hitIndex), { jump });
    if (!current()) return;
    renderSearchList(unchanged ? searchHits : hits, query);
    if (query) {
      selectSidebar("search");
      if (viewer.indexError) {
        const warning = document.createElement("div");
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

async function pickFile() {
  try {
    if (window.pywebview?.api?.pick) {
      const result = await window.pywebview.api.pick();
      if (result?.name) {
        await openUrl(result.name, result.id);
        return;
      }
    }
  } catch {
    /* fall through to file input */
  }
  fileInput.click();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) await openFile(file);
});

$("btn-open").addEventListener("click", pickFile);
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
$("page-input").addEventListener("change", (event) => {
  viewer.goToPage(Number(event.target.value), { push: true });
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectSidebar(tab.dataset.tab));
});

let searchTimer = 0;
$("search-input").addEventListener("input", (event) => {
  const query = event.target.value;
  const request = ++searchGeneration;
  clearTimeout(searchTimer);
  viewer.showHits([], "").catch(console.error);
  renderSearchList([], "");
  searchTimer = setTimeout(() => runSearch(query, request), 180);
});
$("search-input").addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) await moveHit(-1);
    else await moveHit(1);
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
      // Suppress browser navigation for every side-button event, but act once.
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
});

const bubble = $("translate-bubble");
let selectedText = "";

function hideBubble() {
  bubble.hidden = true;
  $("translate-result").hidden = true;
  $("translate-result").textContent = "";
}

function showBubble(x, y, text) {
  selectedText = text;
  $("translate-source").textContent = text;
  $("translate-result").hidden = true;
  bubble.hidden = false;
  const left = Math.min(x, window.innerWidth - bubble.offsetWidth - 12);
  const top = Math.min(y, window.innerHeight - 12);
  bubble.style.left = `${Math.max(12, left)}px`;
  bubble.style.top = `${Math.max(12, top)}px`;
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
$("btn-copy").addEventListener("click", async () => {
  if (selectedText) await navigator.clipboard.writeText(selectedText);
});
$("btn-translate").addEventListener("click", async () => {
  const result = $("translate-result");
  result.hidden = false;
  result.textContent = "翻译中…";
  try {
    result.textContent = await translateText(selectedText, loadSettings());
  } catch (error) {
    result.textContent = error.message || String(error);
  }
});

$("btn-settings").addEventListener("click", () => {
  settings = loadSettings();
  $("setting-key").value = settings.apiKey;
  $("setting-model").value = settings.model;
  $("setting-lang").value = settings.targetLang;
  $("settings-modal").hidden = false;
});
$("btn-settings-cancel").addEventListener("click", () => {
  $("settings-modal").hidden = true;
});
$("btn-settings-save").addEventListener("click", () => {
  settings = saveSettings({
    apiKey: $("setting-key").value.trim(),
    model: $("setting-model").value.trim() || "openai/gpt-4o-mini",
    targetLang: $("setting-lang").value,
  });
  $("settings-modal").hidden = true;
});

async function boot() {
  const request = openGeneration;
  try {
    const res = await fetch("/api/startup");
    if (res.ok) {
      const data = await res.json();
      if (data.hasFile && request === openGeneration) await openUrl(data.name, data.id);
    }
  } catch {
    /* opened as a static file */
  }
}

boot();
