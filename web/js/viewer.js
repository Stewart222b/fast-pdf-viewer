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

function destTypeName(type) {
  if (type == null) return "";
  if (typeof type === "string") return type;
  return type.name || "";
}

const DEST_SCROLL_OFFSET = 64;

export class PdfViewer {
  constructor({ pagesEl, wrapEl, history, onState, onZoomPreview, onPinchCommit, onScrollPosition, onIndex, onPassword }) {
    this.pagesEl = pagesEl;
    this.wrapEl = wrapEl;
    this.history = history;
    this.onState = onState;
    this.onZoomPreview = onZoomPreview;
    this.onPinchCommit = onPinchCommit;
    this.onScrollPosition = onScrollPosition;
    this.onIndex = onIndex;
    this.onPassword = onPassword;
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
    this.pageSizes = [];
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

  /** Viewport reading point in PDF user space, aligned with dest jumps. */
  getReadingPoint() {
    const pageCount = this.pageCount || this.pageEls.length;
    const fallbackPage = Math.min(Math.max(1, this.currentPage || 1), pageCount || 1);
    if (!this.pageEls.length) return { page: fallbackPage, pdfY: NaN };
    const probe = (this.wrapEl?.scrollTop || 0) + DEST_SCROLL_OFFSET;
    let page = 1;
    let el = this.pageEls[0];
    for (const pageEl of this.pageEls) {
      if (pageEl.offsetTop <= probe) {
        page = Number(pageEl.dataset.pageNumber) || page;
        el = pageEl;
      } else break;
    }
    const { height } = this.pageLayout(page);
    const zoom = this.zoom || 1;
    const cssY = probe - (el?.offsetTop || 0);
    const pdfY = height > 0 && zoom > 0 ? height - cssY / zoom : NaN;
    return { page, pdfY };
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
      loading.onPassword = (updatePassword, reason) => this.promptPassword(updatePassword, reason);
      this.loadingTask = loading;
      const pdf = await loading.promise;
      if (generation !== this.generation) return null;
      this.pdf = pdf;
      this.name = source.name || "文档";
      this.pageCount = pdf.numPages;
      await this.loadFirstPageSize(pdf, generation);
      if (generation !== this.generation) return null;
      this.buildPlaceholders();
      this.setZoom(this.zoomMode, { silent: true });
      this.history.reset(this.getState());
      this.observe();
      this.wrapEl.addEventListener("scroll", this.onScroll, { passive: true });
      this.prefetchPageSizes(pdf, generation);
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
    this.cancelPinch();
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
    this.pageSizes = [];
    this.wrapEl.scrollTo({ top: 0, left: 0, behavior: "auto" });
    this.history.reset(this.getState());
    this.notify();
  }

  async loadFirstPageSize(pdf, generation) {
    this.pageSizes = new Array(pdf.numPages);
    const page = await pdf.getPage(1);
    if (generation !== this.generation) return;
    const base = page.getViewport({ scale: 1 });
    this.pageSizes[0] = { width: base.width, height: base.height };
    this.baseWidth = base.width;
    this.baseHeight = base.height;
    if (!this.renderJobs.has(1) && !this.renderedPages.has(1)) page.cleanup?.();
  }

  prefetchPageSizes(pdf, generation) {
    if (pdf.numPages <= 1) return;
    (async () => {
      for (let i = 2; i <= pdf.numPages; i += 1) {
        if (generation !== this.generation) return;
        const page = await pdf.getPage(i);
        if (generation !== this.generation) return;
        const base = page.getViewport({ scale: 1 });
        this.setPageSize(i - 1, { width: base.width, height: base.height });
        if (!this.renderJobs.has(i) && !this.renderedPages.has(i)) page.cleanup?.();
        if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })().catch((error) => {
      if (generation === this.generation) console.error("PDF page layout prefetch failed", error);
    });
  }

  setPageSize(pageIndex, size) {
    const el = this.pageEls[pageIndex];
    const previous = this.pageSizes[pageIndex];
    const zoom = this.zoom;
    const oldHeight = el?.offsetHeight || (previous ? previous.height * zoom : this.baseHeight * zoom);
    const pageTop = el?.offsetTop ?? 0;
    const scrollTop = this.wrapEl.scrollTop;
    this.pageSizes[pageIndex] = size;
    if (!el) return;
    const newHeight = size.height * zoom;
    el.style.width = `${size.width * zoom}px`;
    el.style.height = `${newHeight}px`;
    delete el.dataset.renderedZoom;
    const delta = newHeight - oldHeight;
    if (delta !== 0 && scrollTop > pageTop) {
      this.wrapEl.scrollTop = scrollTop + delta;
      if (!this.applyingHistory) this.history.commit(this.getState());
    }
  }

  pageLayout(pageNumber) {
    const size = this.pageSizes[pageNumber - 1];
    return size || { width: this.baseWidth, height: this.baseHeight };
  }

  applyPageLayout() {
    for (let i = 0; i < this.pageEls.length; i += 1) {
      const el = this.pageEls[i];
      const { width, height } = this.pageLayout(i + 1);
      el.style.width = `${width * this.zoom}px`;
      el.style.height = `${height * this.zoom}px`;
      el.style.setProperty("--scale-factor", String(this.zoom));
    }
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
    this.applyPageLayout();
  }

  async promptPassword(updatePassword, reason) {
    if (!this.onPassword) {
      updatePassword(new Error("需要 PDF 密码"));
      return;
    }
    try {
      const password = await this.onPassword(reason);
      updatePassword(password);
    } catch (error) {
      updatePassword(error instanceof Error ? error : new Error(String(error)));
    }
  }

  computeZoom() {
    const pad = 48;
    const { width, height } = this.pageLayout(this.currentPage);
    if (this.zoomMode === "page-width") {
      return Math.max(0.25, (this.wrapEl.clientWidth - pad) / width);
    }
    if (this.zoomMode === "page-fit") {
      const sx = (this.wrapEl.clientWidth - pad) / width;
      const sy = (this.wrapEl.clientHeight - pad) / height;
      return Math.max(0.25, Math.min(sx, sy));
    }
    const n = Number(this.zoomMode);
    return Number.isFinite(n) ? Math.min(5, Math.max(0.25, n / 100)) : 1.5;
  }

  setZoom(mode, { silent = false, keepPage = true } = {}) {
    this.cancelPinch();
    const page = this.currentPage;
    this.zoomMode = String(mode);
    this.zoom = this.computeZoom();
    this.textMappings.clear();
    this.highlightedPages.clear();
    for (const layer of this.textLayers.values()) layer.hide();
    for (const el of this.pageEls) {
      delete el.dataset.renderedZoom;
      el.querySelector(".hlLayer").replaceChildren();
    }
    this.applyPageLayout();
    if (keepPage) this.scrollToPage(page, { instant: true });
    if (!silent) {
      clearTimeout(this.zoomTimer);
      this.zoomTimer = setTimeout(() => this.renderVisible(true), 80);
    } else {
      this.renderVisible(true);
    }
    this.notify();
  }

  // Keep the raster and text together on the compositor during a gesture.
  // Layout and PDF rendering happen only once the input stream settles.
  pinchZoom(event) {
    if (!this.pdf || !this.pageEls.length || !Number.isFinite(event.deltaY) || !event.deltaY) return;
    if (!this.pinch) {
      const rect = this.wrapEl.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const contentY = this.wrapEl.scrollTop + y;
      const page = this.pageEls.find(el => el.offsetTop + el.offsetHeight >= contentY)
        || this.pageEls[this.pageEls.length - 1];
      this.pinch = {
        zoom: this.zoom, target: this.zoom, x, y, page,
        pageX: (this.wrapEl.scrollLeft + x - page.offsetLeft) / this.zoom,
        pageY: (contentY - page.offsetTop) / this.zoom,
      };
      clearTimeout(this.zoomTimer);
      for (const task of this.tasks.values()) task.cancel();
      this.pagesEl.style.transformOrigin = `${this.wrapEl.scrollLeft + x}px ${contentY}px`;
      this.pagesEl.style.willChange = "transform";
    }
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.wrapEl.clientHeight : 1);
    this.pinch.target = Math.min(5, Math.max(0.25, this.pinch.target * Math.exp(-delta / 100)));
    if (!this.pinchFrame) {
      this.pinchFrame = requestAnimationFrame(() => {
        this.pinchFrame = null;
        if (this.pinch) {
          this.pagesEl.style.transform = `scale(${this.pinch.target / this.pinch.zoom})`;
          this.onZoomPreview?.(this.pinch.target * 100);
        }
      });
    }
    clearTimeout(this.pinchTimer);
    this.pinchTimer = setTimeout(() => this.finishPinch(), 160);
  }

  cancelPinch() {
    clearTimeout(this.pinchTimer);
    if (this.pinchFrame) cancelAnimationFrame(this.pinchFrame);
    this.pinchFrame = null;
    if (!this.pinch) return;
    this.pinch = null;
    this.pagesEl.style.transform = "";
    this.pagesEl.style.transformOrigin = "";
    this.pagesEl.style.willChange = "";
    this.onZoomPreview?.(this.zoomMode);
  }

  finishPinch() {
    const pinch = this.pinch;
    if (!pinch) return;
    this.cancelPinch();
    this.setZoom(String(pinch.target * 100), { keepPage: false });
    this.wrapEl.scrollLeft = pinch.page.offsetLeft + pinch.pageX * this.zoom - pinch.x;
    this.wrapEl.scrollTop = pinch.page.offsetTop + pinch.pageY * this.zoom - pinch.y;
    this.onPinchCommit?.();
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
    this.onScrollPosition?.();
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
    if (this.pinch) return Promise.resolve();
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
      this.renderJobs.get(pageNumber) === job && this.zoom === zoom && !this.pinch;
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
        // Let the previous job settle before replacing its layers.
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
        const previousCanvas = el.querySelector("canvas");
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { alpha: false });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        const task = page.render({ canvasContext: ctx, canvas, viewport, intent: "display" });
        this.tasks.set(pageNumber, task);
        await task.promise;
        if (!current()) return;
        // Keep the scaled old bitmap visible until its replacement is complete.
        previousCanvas.replaceWith(canvas);
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
      if (!current()) return;
      const pageNumber = pageIndex + 1;
      const type = destTypeName(explicit[1]);
      let left = null;
      let top = null;
      if (type === "XYZ") {
        const [, , rawLeft, rawTop, rawZoom] = explicit;
        const zoomChange = rawZoom != null && Number.isFinite(rawZoom) && rawZoom > 0;
        if (push && zoomChange) this.history.commit(this.getState());
        if (zoomChange) {
          this.setZoom(String(Math.min(500, Math.max(25, Math.round(rawZoom * 100)))), {
            keepPage: false,
            silent: true,
          });
        }
        if (!current()) return;
        const page = await pdf.getPage(pageNumber);
        if (!current()) return;
        const viewport = page.getViewport({ scale: this.zoom });
        if (rawLeft != null && Number.isFinite(rawLeft)) {
          [left] = viewport.convertToViewportPoint(rawLeft, rawTop ?? 0);
        }
        if (rawTop != null && Number.isFinite(rawTop)) {
          [, top] = viewport.convertToViewportPoint(rawLeft ?? 0, rawTop);
        }
        if (!this.renderJobs.has(pageNumber) && !this.renderedPages.has(pageNumber)) page.cleanup?.();
        if (current()) {
          this.goToPage(pageNumber, { push: push && !zoomChange, instant: true, left, top });
          if (push && zoomChange) this.history.push(this.getState());
        }
        return;
      } else if (type === "FitH" || type === "FitBH") {
        const y = explicit[2];
        if (y != null && Number.isFinite(y)) {
          const page = await pdf.getPage(pageNumber);
          if (!current()) return;
          [, top] = page.getViewport({ scale: this.zoom }).convertToViewportPoint(0, y);
          if (!this.renderJobs.has(pageNumber) && !this.renderedPages.has(pageNumber)) page.cleanup?.();
        }
      } else if (type === "FitV" || type === "FitBV") {
        const x = explicit[2];
        if (x != null && Number.isFinite(x)) {
          const page = await pdf.getPage(pageNumber);
          if (!current()) return;
          [left] = page.getViewport({ scale: this.zoom }).convertToViewportPoint(x, 0);
          if (!this.renderJobs.has(pageNumber) && !this.renderedPages.has(pageNumber)) page.cleanup?.();
        }
      }
      if (current()) this.goToPage(pageNumber, { push, instant: true, left, top });
    } catch (error) {
      if (current()) console.error("PDF destination failed", error);
    }
  }

  async getOutline() {
    return this.pdf ? this.pdf.getOutline() : null;
  }

  goToPage(pageNumber, { push = false, instant = false, left = null, top = null } = {}) {
    if (!this.pageCount || !Number.isFinite(pageNumber)) return;
    this.navigationGeneration += 1;
    const n = Math.min(this.pageCount, Math.max(1, Math.trunc(pageNumber)));
    if (push) this.history.commit(this.getState());
    this.currentPage = n;
    // History must capture the completed destination, not a smooth-scroll frame.
    this.scrollToPage(n, { instant: instant || push, left, top });
    if (push) this.history.push(this.getState());
    this.notify();
  }

  scrollToPage(pageNumber, { instant = false, left = null, top = null } = {}) {
    const el = this.pageEls[pageNumber - 1];
    if (!el) return;
    let scrollTop = el.offsetTop - 16;
    let scrollLeft = this.wrapEl.scrollLeft;
    if (top != null && Number.isFinite(top)) {
      scrollTop = Math.max(0, el.offsetTop + top - DEST_SCROLL_OFFSET);
    }
    if (left != null && Number.isFinite(left)) {
      scrollLeft = Math.max(0, el.offsetLeft + left - 32);
    }
    this.wrapEl.scrollTo({
      top: scrollTop,
      left: scrollLeft,
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
