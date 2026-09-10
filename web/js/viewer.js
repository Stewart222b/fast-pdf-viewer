import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  setLayerDimensions,
} from "../vendor/pdfjs/build/pdf.mjs";
import { matchRects } from "./search.js";

GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/build/pdf.worker.mjs",
  import.meta.url,
).toString();

const CMAP_URL = new URL("../vendor/pdfjs/cmaps/", import.meta.url).toString();
const FONT_URL = new URL("../vendor/pdfjs/standard_fonts/", import.meta.url).toString();
const WASM_URL = new URL("../vendor/pdfjs/wasm/", import.meta.url).toString();

export class PdfViewer {
  constructor({ pagesEl, wrapEl, history, onState }) {
    this.pagesEl = pagesEl;
    this.wrapEl = wrapEl;
    this.history = history;
    this.onState = onState;
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
    this.renderJobs.clear();
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
    return Number.isFinite(n) ? n / 100 : 1.5;
  }

  setZoom(mode, { silent = false, keepPage = true } = {}) {
    const page = this.currentPage;
    this.zoomMode = String(mode);
    this.zoom = this.computeZoom();
    const cssW = this.baseWidth * this.zoom;
    const cssH = this.baseHeight * this.zoom;
    for (const el of this.pageEls) {
      el.style.width = `${cssW}px`;
      el.style.height = `${cssH}px`;
      el.style.setProperty("--scale-factor", String(this.zoom));
      delete el.dataset.renderedZoom;
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
        const outputScale = window.devicePixelRatio || 1;
        const cssViewport = page.getViewport({ scale: zoom });
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
        if (current()) el.dataset.renderedZoom = key;
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
        }
      }
    })();
    return job.promise;
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
    try {
      for (let i = 1; i <= pdf.numPages; i += 1) {
        if (generation !== this.generation) return [];
        const page = await pdf.getPage(i);
        if (generation !== this.generation) return [];
        const textContent = await page.getTextContent();
        if (generation !== this.generation) return [];
        this.textContents.set(i, textContent);
        pages.push({
          pageNumber: i,
          text: textContent.items.map((item) => item.str || "").join(""),
          textContent,
        });
      }
      this.pageTexts = pages;
      return pages;
    } catch (error) {
      if (generation !== this.generation) return [];
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

  async showHits(hits, query, index = 0) {
    const pages = new Set([...this.hits, ...hits].map((hit) => hit.pageNumber));
    const generation = ++this.hitGeneration;
    this.navigationGeneration += 1;
    this.hits = hits;
    this.query = query;
    this.hitIndex = hits.length ? index : -1;
    await Promise.all([...pages].map((n) => this.paintHighlights(n)));
    if (generation === this.hitGeneration && hits[index]) await this.jumpToHit(index, { push: true });
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
