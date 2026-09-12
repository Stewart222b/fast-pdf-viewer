import {
  getDocument,
  GlobalWorkerOptions,
  setLayerDimensions,
} from "../vendor/pdfjs/build/pdf.mjs";
import { TextLayerBuilder } from "../vendor/pdfjs/web/pdf_viewer.mjs";
import { buildTextIndex, buildTextMapping, matchRects } from "./search.js";

GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/build/pdf.worker.mjs",
  import.meta.url,
).toString();

const CMAP_URL = new URL("../vendor/pdfjs/cmaps/", import.meta.url).toString();
const FONT_URL = new URL("../vendor/pdfjs/standard_fonts/", import.meta.url).toString();
const WASM_URL = new URL("../vendor/pdfjs/wasm/", import.meta.url).toString();
const ICC_URL = new URL("../vendor/pdfjs/iccs/", import.meta.url).toString();

function viewportRect(viewport, pdfRect) {
  const [x1, y1, x2, y2] = pdfRect;
  const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1);
  const [vx2, vy2] = viewport.convertToViewportPoint(x2, y2);
  return [vx1, vy1, vx2, vy2];
}

export class PdfViewer {
  constructor({ pagesEl, wrapEl, history, onState, onIndex }) {
    this.pagesEl = pagesEl;
    this.wrapEl = wrapEl;
    this.history = history;
    this.onState = onState;
    this.onIndex = onIndex;
    this.renderedPages = new Map();
    this.maxCachedPages = 8;
    this.indexedPages = 0;
    this.indexError = null;
    this.pdf = null;
    this.pageCount = 0;
    this.currentPage = 1;
    this.zoomMode = "150";
    this.zoom = 1.5;
    this.baseWidth = 612;
    this.baseHeight = 792;
    this.pageEls = [];
    this.tasks = new Map();
    this.pageTexts = [];
    this.textContents = new Map();
    this.hits = [];
    this.hitIndex = -1;
    this.query = "";
    this.applyingHistory = false;
    this.observer = null;
    this.indexPromise = null;
    this.name = "";
    this.generation = 0;
    this.loadingTask = null;
    this.renderJobs = new Map();
    this.textLayers = new Map();
    this.textMappings = new Map();
    this.visiblePages = new Set();
    this.highlightedPages = new Set();
    this.hitGeneration = 0;
    this.navigationGeneration = 0;
    if (globalThis.__PDF_BENCH__) {
      this.bench = {
        renderPageCalls: 0,
        renderVisibleCalls: 0,
        observerRenderCalls: 0,
        renderTaskCancels: 0,
        trimEvictions: 0,
        renderJobsPeak: 0,
        canvasPeak: 0,
        textLayerPeak: 0,
      };
      const origRenderVisible = this.renderVisible.bind(this);
      this.renderVisible = async (...args) => {
        this.bench.renderVisibleCalls += 1;
        return origRenderVisible(...args);
      };
      const origTrim = this.trimCache.bind(this);
      this.trimCache = () => {
        const before = this.renderedPages.size;
        origTrim();
        this.bench.trimEvictions += Math.max(0, before - this.renderedPages.size);
      };
    }
  }

  getState() {
    return {
      page: this.currentPage,
      zoom: this.zoomMode,
      scrollTop: this.wrapEl.scrollTop,
      scrollLeft: this.wrapEl.scrollLeft,
    };
  }

  notify() {
    this.onState?.(this.getState());
  }

  async open(source) {
    this.close();
    const generation = this.generation;
    try {
      const loading = getDocument({
        url: source.url,
        data: source.data,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: FONT_URL,
        wasmUrl: WASM_URL,
        iccUrl: ICC_URL,
        disableAutoFetch: true,
        disableStream: true,
      });
      this.loadingTask = loading;
      const pdf = await loading.promise;
      if (generation !== this.generation) return null;
      this.pdf = pdf;
      const first = await pdf.getPage(1);
      if (generation !== this.generation) return null;
      this.name = source.name || "文档";
      this.pageCount = pdf.numPages;
      const base = first.getViewport({ scale: 1 });
      this.baseWidth = base.width;
      this.baseHeight = base.height;
      this.buildPlaceholders();
      this.setZoom(this.zoomMode, { silent: true });
      this.history.reset(this.getState());
      this.observe();
      this.wrapEl.addEventListener("scroll", this.onScroll, { passive: true });
      this.indexPromise = this.indexText();
      // Search still receives the rejection; background indexing has a handler too.
      this.indexPromise.catch((error) => {
        if (generation === this.generation) console.error("PDF indexing failed", error);
      });
      this.notify();
      return this;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.close();
      throw error;
    }
  }

  close() {
    this.generation += 1;
    this.hitGeneration += 1;
    this.navigationGeneration += 1;
    clearTimeout(this.zoomTimer);
    this.wrapEl.removeEventListener("scroll", this.onScroll);
    this.observer?.disconnect();
    for (const task of this.tasks.values()) task.cancel();
    for (const layer of this.textLayers.values()) layer.cancel();
    this.tasks.clear();
    this.textLayers.clear();
    this.textMappings.clear();
    this.renderJobs.clear();
    this.renderedPages.clear();
    this.visiblePages.clear();
    this.highlightedPages.clear();
    clearTimeout(this.scrollTimer);
    this.indexedPages = 0;
    this.indexError = null;
    const resource = this.loadingTask || this.pdf;
    this.loadingTask = null;
    if (resource) {
      Promise.resolve().then(() => resource.destroy()).catch((error) => {
        console.error("PDF cleanup failed", error);
      });
    }
    this.pagesEl.replaceChildren();
    this.pageEls = [];
    this.pageTexts = [];
    this.textContents.clear();
    this.hits = [];
    this.hitIndex = -1;
    this.query = "";
    this.pdf = null;
    this.indexPromise = null;
    this.currentPage = 1;
    this.pageCount = 0;
    this.name = "";
    this.wrapEl.scrollTo({ top: 0, left: 0, behavior: "auto" });
    this.history.reset(this.getState());
    this.notify();
  }

  buildPlaceholders() {
    this.pagesEl.replaceChildren();
    this.pageEls = [];
    for (let i = 1; i <= this.pageCount; i += 1) {
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.pageNumber = String(i);
      el.innerHTML =
        '<canvas></canvas><div class="textLayer"></div><div class="linkLayer"></div><div class="hlLayer"></div>';
      this.pagesEl.appendChild(el);
      this.pageEls.push(el);
    }
  }

  computeZoom() {
    const pad = 48;
    if (this.zoomMode === "page-width") {
      return Math.max(0.25, (this.wrapEl.clientWidth - pad) / this.baseWidth);
    }
    if (this.zoomMode === "page-fit") {
      const sx = (this.wrapEl.clientWidth - pad) / this.baseWidth;
      const sy = (this.wrapEl.clientHeight - pad) / this.baseHeight;
      return Math.max(0.25, Math.min(sx, sy));
    }
    const n = Number(this.zoomMode);
    return Number.isFinite(n) ? Math.min(5, Math.max(0.25, n / 100)) : 1.5;
  }

  setZoom(mode, { silent = false, keepPage = true } = {}) {
    const page = this.currentPage;
    this.zoomMode = String(mode);
    this.zoom = this.computeZoom();
    const cssW = this.baseWidth * this.zoom;
    const cssH = this.baseHeight * this.zoom;
    this.textMappings.clear();
    this.highlightedPages.clear();
    for (const layer of this.textLayers.values()) layer.hide();
    for (const el of this.pageEls) {
      el.style.width = `${cssW}px`;
      el.style.height = `${cssH}px`;
      el.style.setProperty("--scale-factor", String(this.zoom));
      delete el.dataset.renderedZoom;
      el.querySelector(".hlLayer").replaceChildren();
    }
    if (keepPage) this.scrollToPage(page, { instant: true });
    if (!silent) {
      clearTimeout(this.zoomTimer);
      this.zoomTimer = setTimeout(() => this.renderVisible(true), 80);
    } else {
      this.renderVisible(true);
    }
    this.notify();
  }

  bumpZoom(delta) {
    const presets = [50, 75, 100, 125, 150, 175, 200, 250, 300];
    const current = Math.round(this.zoom * 100);
    let next;
    if (delta > 0) {
      next = presets.find((v) => v > current) ?? current + 25;
    } else {
      next = [...presets].reverse().find((v) => v < current) ?? Math.max(25, current - 25);
    }
    next = Math.min(500, Math.max(25, next));
    this.setZoom(String(next));
    return String(next);
  }

  observe() {
    this.observer?.disconnect();
    this.visiblePages.clear();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number(entry.target.dataset.pageNumber);
          if (entry.isIntersecting) {
            this.visiblePages.add(n);
            if (this.bench) this.bench.observerRenderCalls += 1;
            this.renderPage(n).catch((error) => console.error("PDF rendering failed", error));
          } else {
            this.visiblePages.delete(n);
          }
        }
      },
      { root: this.wrapEl, rootMargin: "1200px 0px", threshold: 0.01 },
    );
    for (const el of this.pageEls) this.observer.observe(el);
  }

  onScroll = () => {
    if (!this.pageEls.length) return;
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.renderVisible();
      this.trimCache();
    }, 50);
    const top = this.wrapEl.scrollTop + 80;
    let page = 1;
    for (const el of this.pageEls) {
      if (el.offsetTop <= top) page = Number(el.dataset.pageNumber);
      else break;
    }
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.notify();
    }
  };

  async renderVisible(force = false) {
    if (!this.pageEls.length) return;
    const viewTop = this.wrapEl.scrollTop - 800;
    const viewBottom = this.wrapEl.scrollTop + this.wrapEl.clientHeight + 800;
    const jobs = [];
    for (const el of this.pageEls) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (bottom >= viewTop && top <= viewBottom) {
        jobs.push(this.renderPage(Number(el.dataset.pageNumber), force));
      }
    }
    await Promise.allSettled(jobs);
  }

  renderPage(pageNumber, force = false) {
    if (this.bench) this.bench.renderPageCalls += 1;
    const el = this.pageEls[pageNumber - 1];
    const pdf = this.pdf;
    if (!el || !pdf) return Promise.resolve();
    const zoom = this.zoom;
    const key = zoom.toFixed(3);
    if (this.renderedPages.has(pageNumber)) {
      const cached = this.renderedPages.get(pageNumber);
      this.renderedPages.delete(pageNumber);
      this.renderedPages.set(pageNumber, cached);
    }
    const previous = this.renderJobs.get(pageNumber);
    if (previous?.key === key) return previous.promise;
    if (!force && el.dataset.renderedZoom === key) return Promise.resolve();
    const generation = this.generation;
    const job = { key };
    const current = () => generation === this.generation &&
      this.renderJobs.get(pageNumber) === job && this.zoom === zoom;
    const prevTask = this.tasks.get(pageNumber);
    if (prevTask) {
      if (this.bench) this.bench.renderTaskCancels += 1;
      prevTask.cancel();
    }
    this.textLayers.get(pageNumber)?.cancel();
    this.textMappings.delete(pageNumber);
    this.renderJobs.set(pageNumber, job);
    if (this.bench) this.bench.renderJobsPeak = Math.max(this.bench.renderJobsPeak, this.renderJobs.size);
    job.promise = (async () => {
      try {
        // A canvas cannot be used by two pdf.js render tasks concurrently.
        await previous?.promise.catch(() => {});
        if (!current()) return;
        const page = await pdf.getPage(pageNumber);
        if (!current()) return;
        const cssViewport = page.getViewport({ scale: zoom });
        const outputScale = Math.min(window.devicePixelRatio || 1,
          Math.sqrt(8_000_000 / (cssViewport.width * cssViewport.height)),
          4096 / cssViewport.width, 4096 / cssViewport.height);
        const viewport = page.getViewport({ scale: zoom * outputScale });
        el.style.width = `${cssViewport.width}px`;
        el.style.height = `${cssViewport.height}px`;
        const canvas = el.querySelector("canvas");
        const ctx = canvas.getContext("2d", { alpha: false });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;
        const task = page.render({ canvasContext: ctx, canvas, viewport, intent: "display" });
        this.tasks.set(pageNumber, task);
        await task.promise;
        if (!current()) return;
        const textContent = this.textContents.get(pageNumber) || await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
        if (!current()) return;
        this.textContents.set(pageNumber, textContent);
        let mapping;
        const textLayer = new TextLayerBuilder({
          pdfPage: page,
          highlighter: {
            setTextMapping(textDivs, textContentItemsStr) {
              mapping = { textDivs, textContentItemsStr };
            },
            enable() {},
            disable() {},
          },
        });
        const container = textLayer.div;
        el.querySelector(".textLayer").replaceWith(container);
        container.style.setProperty("--scale-factor", String(cssViewport.scale));
        setLayerDimensions(container, cssViewport);
        this.textLayers.set(pageNumber, textLayer);
        await textLayer.render({ viewport: cssViewport });
        if (!current()) return;
        this.textMappings.set(pageNumber, buildTextMapping(mapping.textDivs, mapping.textContentItemsStr));
        await this.renderLinks(page, cssViewport, el.querySelector(".linkLayer"), current);
        if (!current()) return;
        await this.paintHighlights(pageNumber);
        if (current()) {
          el.dataset.renderedZoom = key;
          this.renderedPages.delete(pageNumber);
          this.renderedPages.set(pageNumber, page);
          if (this.bench) {
            this.bench.canvasPeak = Math.max(this.bench.canvasPeak, this.renderedPages.size);
            this.bench.textLayerPeak = Math.max(this.bench.textLayerPeak, this.textLayers.size);
          }
        }
      } catch (error) {
        if (current() && error?.name !== "RenderingCancelledException" && error?.name !== "AbortException") {
          delete el.dataset.renderedZoom;
          throw error;
        }
      } finally {
        if (this.renderJobs.get(pageNumber) === job) {
          this.renderJobs.delete(pageNumber);
          this.tasks.delete(pageNumber);
          this.trimCache();
        }
      }
    })();
    return job.promise;
  }

  trimCache() {
    if (this.renderedPages.size <= this.maxCachedPages) return;
    const top = this.wrapEl.scrollTop, bottom = top + this.wrapEl.clientHeight;
    for (const [number, page] of this.renderedPages) {
      if (this.renderedPages.size <= this.maxCachedPages) break;
      const el = this.pageEls[number - 1];
      if (!el || this.renderJobs.has(number)) continue;
      if (el.offsetTop + el.offsetHeight >= top && el.offsetTop <= bottom) continue;
      this.textLayers.get(number)?.cancel();
      this.textLayers.delete(number);
      this.textMappings.delete(number);
      this.highlightedPages.delete(number);
      const canvas = el.querySelector("canvas");
      canvas.width = canvas.height = 0;
      for (const selector of [".textLayer", ".linkLayer", ".hlLayer"]) el.querySelector(selector).replaceChildren();
      delete el.dataset.renderedZoom;
      this.textContents.delete(number);
      this.renderedPages.delete(number);
      page.cleanup?.();
    }
  }

  async renderLinks(page, viewport, layer, current = () => true) {
    const annotations = await page.getAnnotations();
    if (!current()) return;
    layer.replaceChildren();
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link") continue;
      const rect = viewportRect(viewport, annotation.rect);
      const left = Math.min(rect[0], rect[2]);
      const top = Math.min(rect[1], rect[3]);
      const width = Math.abs(rect[2] - rect[0]);
      const height = Math.abs(rect[3] - rect[1]);
      const a = document.createElement("a");
      a.href = annotation.url || "#";
      a.title = annotation.url || "跳转";
      a.style.left = `${left}px`;
      a.style.top = `${top}px`;
      a.style.width = `${width}px`;
      a.style.height = `${height}px`;
      a.addEventListener("click", (event) => {
        event.preventDefault();
        if (annotation.url) {
          window.open(annotation.url, "_blank", "noopener,noreferrer");
          return;
        }
        if (annotation.dest) this.goToDest(annotation.dest, true);
      });
      layer.appendChild(a);
    }
  }

  async goToDest(dest, push = false) {
    if (!this.pdf || dest == null) return;
    const pdf = this.pdf;
    const generation = this.generation;
    const navigation = ++this.navigationGeneration;
    const current = () => generation === this.generation && navigation === this.navigationGeneration;
    try {
      let explicit = dest;
      if (typeof dest === "string") explicit = await pdf.getDestination(dest);
      if (!explicit || !current()) return;
      const ref = explicit[0];
      const pageIndex = typeof ref === "object" ? await pdf.getPageIndex(ref) : Number(ref);
      if (current()) this.goToPage(pageIndex + 1, { push });
    } catch (error) {
      if (current()) console.error("PDF destination failed", error);
    }
  }

  async getOutline() {
    return this.pdf ? this.pdf.getOutline() : null;
  }

  goToPage(pageNumber, { push = false, instant = false } = {}) {
    if (!this.pageCount || !Number.isFinite(pageNumber)) return;
    this.navigationGeneration += 1;
    const n = Math.min(this.pageCount, Math.max(1, Math.trunc(pageNumber)));
    if (push) this.history.commit(this.getState());
    this.currentPage = n;
    // History must capture the completed destination, not a smooth-scroll frame.
    this.scrollToPage(n, { instant: instant || push });
    if (push) this.history.push(this.getState());
    this.notify();
  }

  scrollToPage(pageNumber, { instant = false } = {}) {
    const el = this.pageEls[pageNumber - 1];
    if (!el) return;
    this.wrapEl.scrollTo({
      top: el.offsetTop - 16,
      behavior: instant ? "auto" : "smooth",
    });
  }

  restore(state) {
    if (!state) return;
    this.applyReadingPosition(state, { fromHistory: true });
  }

  applyReadingPosition(state, { fromHistory = false } = {}) {
    if (!state) return;
    if (fromHistory) this.applyingHistory = true;
    if (String(state.zoom) !== String(this.zoomMode)) {
      this.setZoom(state.zoom, { keepPage: false });
    }
    if (state.page) this.currentPage = state.page;
    this.wrapEl.scrollTo({
      top: state.scrollTop ?? 0,
      left: state.scrollLeft ?? 0,
      behavior: "auto",
    });
    this.notify();
    requestAnimationFrame(() => {
      if (fromHistory) this.applyingHistory = false;
      this.renderVisible(true).catch((error) => console.error("PDF rendering failed", error));
    });
  }

  back() {
    this.navigationGeneration += 1;
    if (!this.history.canBack()) return;
    this.history.commit(this.getState());
    this.restore(this.history.back());
  }

  forward() {
    this.navigationGeneration += 1;
    if (!this.history.canForward()) return;
    this.history.commit(this.getState());
    this.restore(this.history.forward());
  }

  async indexText() {
    const pdf = this.pdf;
    const generation = this.generation;
    const pages = [];
    if (!pdf) return pages;
    this.pageTexts = pages;
    try {
      for (let i = 1; i <= pdf.numPages; i += 1) {
        if (generation !== this.generation) return [];
        const page = await pdf.getPage(i);
        if (generation !== this.generation) return [];
        const textContent = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
        if (generation !== this.generation) return [];
        pages.push({
          pageNumber: i,
          ...buildTextIndex(textContent),
        });
        this.indexedPages = i;
        if (!this.renderJobs.has(i) && !this.renderedPages.has(i)) page.cleanup?.();
        if (i === 1 || i % 10 === 0 || i === pdf.numPages) this.onIndex?.();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (generation !== this.generation) return [];
      this.pageTexts = pages;
      return pages;
    } catch (error) {
      if (generation !== this.generation) return [];
      this.indexError = error;
      this.onIndex?.();
      throw error;
    }
  }

  highlightCount(layer) {
    if (!layer) return 0;
    if (typeof layer.childElementCount === "number") return layer.childElementCount;
    return layer.children?.length ?? 0;
  }

  liveHighlightPages(...extra) {
    const pages = new Set();
    for (const n of this.renderedPages.keys()) pages.add(n);
    for (const n of this.visiblePages) pages.add(n);
    for (const n of extra) {
      const page = Number(n);
      if (Number.isInteger(page) && page > 0) pages.add(page);
    }
    return pages;
  }

  refreshLiveHighlights(...extra) {
    for (const n of this.liveHighlightPages(...extra)) this.paintHighlights(n);
  }

  clearRenderedHighlights() {
    const pages = this.highlightedPages.size ? [...this.highlightedPages] : [...this.liveHighlightPages()];
    for (const n of pages) {
      const layer = this.pageEls[n - 1]?.querySelector(".hlLayer");
      if (this.highlightCount(layer)) layer.replaceChildren();
    }
    this.highlightedPages.clear();
  }

  clearHits() {
    this.hitGeneration += 1;
    this.navigationGeneration += 1;
    this.hits = [];
    this.query = "";
    this.hitIndex = -1;
    this.clearRenderedHighlights();
  }

  async paintHighlights(pageNumber) {
    const el = this.pageEls[pageNumber - 1];
    if (!el || !this.pdf) return;
    const layer = el.querySelector(".hlLayer");
    if (!this.hits.length || !this.query) {
      if (this.highlightCount(layer)) layer.replaceChildren();
      this.highlightedPages.delete(pageNumber);
      return;
    }
    const mapping = this.textMappings.get(pageNumber);
    if (!mapping) return;
    layer.replaceChildren();
    let painted = false;
    this.hits.forEach((hit, index) => {
      if (hit.pageNumber !== pageNumber) return;
      const rects = matchRects(mapping, layer, hit.offset, hit.length);
      for (const rect of rects) {
        const box = document.createElement("div");
        box.className = `hl${index === this.hitIndex ? " current" : ""}`;
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        layer.appendChild(box);
        painted = true;
      }
    });
    if (painted) this.highlightedPages.add(pageNumber);
    else this.highlightedPages.delete(pageNumber);
  }

  async showHits(hits, query, index = 0, { jump = true } = {}) {
    // Progressive index refreshes must not cancel in-flight search/outline jumps.
    const generation = jump ? ++this.hitGeneration : this.hitGeneration;
    if (jump) this.navigationGeneration += 1;
    const prevPage = this.hits[this.hitIndex]?.pageNumber;
    this.hits = hits;
    this.query = query;
    this.hitIndex = hits.length ? index : -1;
    if (!hits.length || !query) {
      this.clearRenderedHighlights();
      return;
    }
    this.refreshLiveHighlights(prevPage, hits[this.hitIndex]?.pageNumber);
    if (jump && generation === this.hitGeneration && hits[index]) {
      await this.jumpToHit(index, { push: true });
    }
  }

  async jumpToHit(index, { push = false } = {}) {
    const hit = this.hits[index];
    if (!hit) return;
    const generation = this.generation;
    const hitGeneration = this.hitGeneration;
    const navigation = ++this.navigationGeneration;
    const current = () => generation === this.generation && hitGeneration === this.hitGeneration &&
      navigation === this.navigationGeneration;
    try {
      const origin = this.getState();
      const prevPage = this.hits[this.hitIndex]?.pageNumber;
      await this.renderPage(hit.pageNumber);
      if (!current()) return;
      const el = this.pageEls[hit.pageNumber - 1];
      const rect = matchRects(this.textMappings.get(hit.pageNumber), el.querySelector(".hlLayer"), hit.offset, hit.length)[0];
      if (push) this.history.commit(origin);
      this.hitIndex = index;
      this.currentPage = hit.pageNumber;
      this.wrapEl.scrollTo({
        top: Math.max(0, el.offsetTop + (rect?.top || 0) - 64),
        left: rect ? Math.max(0, el.offsetLeft + rect.left - 32) : this.wrapEl.scrollLeft,
        behavior: "auto",
      });
      if (push) this.history.push(this.getState());
      this.notify();
      this.refreshLiveHighlights(prevPage, hit.pageNumber);
    } catch (error) {
      if (current()) throw error;
    }
  }
}
