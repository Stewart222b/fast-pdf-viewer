import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  setLayerDimensions,
} from "../vendor/pdfjs/build/pdf.mjs";
import { buildTextIndex, matchRects } from "./search.js";

GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/build/pdf.worker.mjs",
  import.meta.url,
).toString();

const CMAP_URL = new URL("../vendor/pdfjs/cmaps/", import.meta.url).toString();
const FONT_URL = new URL("../vendor/pdfjs/standard_fonts/", import.meta.url).toString();
const WASM_URL = new URL("../vendor/pdfjs/wasm/", import.meta.url).toString();
const ICC_URL = new URL("../vendor/pdfjs/iccs/", import.meta.url).toString();

function destTypeName(type) {
  if (type == null) return "";
  if (typeof type === "string") return type;
  return type.name || "";
}

export class PdfViewer {
  constructor({ pagesEl, wrapEl, history, onState, onIndex, onPassword }) {
    this.pagesEl = pagesEl;
    this.wrapEl = wrapEl;
    this.history = history;
    this.onState = onState;
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
    this.hitGeneration = 0;
    this.navigationGeneration = 0;
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
      loading.onPassword = (updatePassword, reason) => this.promptPassword(updatePassword, reason);
      this.loadingTask = loading;
      const pdf = await loading.promise;
      if (generation !== this.generation) return null;
      this.pdf = pdf;
      this.name = source.name || "文档";
      this.pageCount = pdf.numPages;
      await this.loadPageSizes(pdf, generation);
      if (generation !== this.generation) return null;
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
    this.renderJobs.clear();
    this.renderedPages.clear();
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

  async loadPageSizes(pdf, generation) {
    const sizes = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      if (generation !== this.generation) return;
      const page = await pdf.getPage(i);
      if (generation !== this.generation) return;
      const base = page.getViewport({ scale: 1 });
      sizes.push({ width: base.width, height: base.height });
      if (!this.renderJobs.has(i) && !this.renderedPages.has(i)) page.cleanup?.();
      if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.pageSizes = sizes;
    if (sizes.length) {
      this.baseWidth = sizes[0].width;
      this.baseHeight = sizes[0].height;
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
    const page = this.currentPage;
    this.zoomMode = String(mode);
    this.zoom = this.computeZoom();
    for (const el of this.pageEls) delete el.dataset.renderedZoom;
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
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const n = Number(entry.target.dataset.pageNumber);
            this.renderPage(n).catch((error) => console.error("PDF rendering failed", error));
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
    this.tasks.get(pageNumber)?.cancel();
    this.textLayers.get(pageNumber)?.cancel();
    this.renderJobs.set(pageNumber, job);
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
        const textContent = this.textContents.get(pageNumber) || await page.getTextContent();
        if (!current()) return;
        this.textContents.set(pageNumber, textContent);
        const container = el.querySelector(".textLayer");
        container.replaceChildren();
        container.style.setProperty("--scale-factor", String(cssViewport.scale));
        setLayerDimensions(container, cssViewport);
        const textLayer = new TextLayer({ textContentSource: textContent, container, viewport: cssViewport });
        this.textLayers.set(pageNumber, textLayer);
        await textLayer.render();
        if (!current()) return;
        await this.renderLinks(page, cssViewport, el.querySelector(".linkLayer"), current);
        if (!current()) return;
        await this.paintHighlights(pageNumber);
        if (current()) {
          el.dataset.renderedZoom = key;
          this.renderedPages.delete(pageNumber);
          this.renderedPages.set(pageNumber, page);
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
          this.textLayers.delete(pageNumber);
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
      const rect = viewport.convertToViewportRectangle(annotation.rect);
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
        if (rawZoom != null && Number.isFinite(rawZoom) && rawZoom > 0) {
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
          [, left] = viewport.convertToViewportPoint(rawLeft, rawTop ?? 0);
        }
        if (rawTop != null && Number.isFinite(rawTop)) {
          [, top] = viewport.convertToViewportPoint(rawLeft ?? 0, rawTop);
        }
        if (!this.renderJobs.has(pageNumber) && !this.renderedPages.has(pageNumber)) page.cleanup?.();
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
      scrollTop = Math.max(0, el.offsetTop + top - 64);
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
    this.applyingHistory = true;
    if (String(state.zoom) !== String(this.zoomMode)) {
      this.setZoom(state.zoom, { keepPage: false });
    }
    this.currentPage = state.page;
    this.wrapEl.scrollTo({
      top: state.scrollTop,
      left: state.scrollLeft,
      behavior: "auto",
    });
    this.notify();
    requestAnimationFrame(() => {
      this.applyingHistory = false;
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
        const textContent = await page.getTextContent();
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

  async paintHighlights(pageNumber) {
    const el = this.pageEls[pageNumber - 1];
    if (!el || !this.pdf) return;
    const layer = el.querySelector(".hlLayer");
    layer.replaceChildren();
    if (!this.hits.length || !this.query) return;
    const textContent = this.textContents.get(pageNumber);
    if (!textContent) return;
    const generation = this.generation;
    const hitGeneration = this.hitGeneration;
    const zoom = this.zoom;
    let page;
    try {
      page = await this.pdf.getPage(pageNumber);
    } catch (error) {
      if (generation !== this.generation || hitGeneration !== this.hitGeneration) return;
      throw error;
    }
    if (generation !== this.generation || hitGeneration !== this.hitGeneration || zoom !== this.zoom) return;
    layer.replaceChildren();
    const cssViewport = page.getViewport({ scale: this.zoom });
    this.hits.forEach((hit, index) => {
      if (hit.pageNumber !== pageNumber) return;
      const rects = matchRects(textContent, cssViewport, hit.offset, hit.length);
      for (const rect of rects) {
        const box = document.createElement("div");
        box.className = `hl${index === this.hitIndex ? " current" : ""}`;
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${Math.max(rect.height, 10)}px`;
        layer.appendChild(box);
      }
    });
  }

  async showHits(hits, query, index = 0, { jump = true } = {}) {
    const pages = new Set([...this.hits, ...hits].map((hit) => hit.pageNumber));
    // Progressive index refreshes must not cancel in-flight search/outline jumps.
    const generation = jump ? ++this.hitGeneration : this.hitGeneration;
    if (jump) this.navigationGeneration += 1;
    this.hits = hits;
    this.query = query;
    this.hitIndex = hits.length ? index : -1;
    await Promise.all([...pages].map((n) => this.paintHighlights(n)));
    if (jump && generation === this.hitGeneration && hits[index]) await this.jumpToHit(index, { push: true });
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
      await this.renderPage(hit.pageNumber);
      if (!current()) return;
      const page = await this.pdf.getPage(hit.pageNumber);
      if (!current()) return;
      const textContent = this.textContents.get(hit.pageNumber);
      const rect = textContent && matchRects(textContent, page.getViewport({ scale: this.zoom }), hit.offset, hit.length)[0];
      const el = this.pageEls[hit.pageNumber - 1];
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
      const pages = new Set(this.hits.map((item) => item.pageNumber));
      await Promise.all([...pages].map((n) => this.paintHighlights(n)));
    } catch (error) {
      if (current()) throw error;
    }
  }
}
