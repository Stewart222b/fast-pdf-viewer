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
    const loading = getDocument({
      url: source.url,
      data: source.data,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
      wasmUrl: WASM_URL,
    });
    this.pdf = await loading.promise;
    this.name = source.name || "文档";
    this.pageCount = this.pdf.numPages;
    const first = await this.pdf.getPage(1);
    const base = first.getViewport({ scale: 1 });
    this.baseWidth = base.width;
    this.baseHeight = base.height;
    this.buildPlaceholders();
    this.setZoom(this.zoomMode, { silent: true });
    this.history.reset(this.getState());
    this.observe();
    this.wrapEl.addEventListener("scroll", this.onScroll, { passive: true });
    this.indexPromise = this.indexText();
    this.notify();
    return this;
  }

  close() {
    this.wrapEl.removeEventListener("scroll", this.onScroll);
    this.observer?.disconnect();
    for (const task of this.tasks.values()) {
      try {
        task.cancel();
      } catch {
        /* ignore */
      }
    }
    this.tasks.clear();
    this.pagesEl.replaceChildren();
    this.pageEls = [];
    this.pageTexts = [];
    this.textContents.clear();
    this.hits = [];
    this.hitIndex = -1;
    this.query = "";
    this.pdf = null;
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
            this.renderPage(n);
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

  async renderPage(pageNumber, force = false) {
    const el = this.pageEls[pageNumber - 1];
    if (!el || !this.pdf) return;
    const key = this.zoom.toFixed(3);
    if (!force && el.dataset.renderedZoom === key) return;
    el.dataset.renderedZoom = key;

    const page = await this.pdf.getPage(pageNumber);
    const outputScale = window.devicePixelRatio || 1;
    const cssViewport = page.getViewport({ scale: this.zoom });
    const viewport = page.getViewport({ scale: this.zoom * outputScale });
    el.style.width = `${cssViewport.width}px`;
    el.style.height = `${cssViewport.height}px`;

    const canvas = el.querySelector("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${cssViewport.width}px`;
    canvas.style.height = `${cssViewport.height}px`;

    this.tasks.get(pageNumber)?.cancel();
    const task = page.render({
      canvasContext: ctx,
      canvas,
      viewport,
      intent: "display",
    });
    this.tasks.set(pageNumber, task);
    try {
      await task.promise;
    } catch (error) {
      if (error?.name === "RenderingCancelledException") return;
      throw error;
    }

    const textContent = await page.getTextContent();
    this.textContents.set(pageNumber, textContent);
    const textLayerDiv = el.querySelector(".textLayer");
    textLayerDiv.replaceChildren();
    textLayerDiv.style.setProperty("--scale-factor", String(cssViewport.scale));
    setLayerDimensions(textLayerDiv, cssViewport);
    const textLayer = new TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport: cssViewport,
    });
    await textLayer.render();

    await this.renderLinks(page, cssViewport, el.querySelector(".linkLayer"));
    await this.paintHighlights(pageNumber);
  }

  async renderLinks(page, viewport, layer) {
    layer.replaceChildren();
    const annotations = await page.getAnnotations();
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
    let explicit = dest;
    if (typeof dest === "string") explicit = await this.pdf.getDestination(dest);
    if (!explicit) return;
    const ref = explicit[0];
    const pageIndex =
      typeof ref === "object" ? await this.pdf.getPageIndex(ref) : Number(ref);
    this.goToPage(pageIndex + 1, { push });
  }

  async getOutline() {
    return this.pdf ? this.pdf.getOutline() : null;
  }

  goToPage(pageNumber, { push = false, instant = false } = {}) {
    const n = Math.min(this.pageCount, Math.max(1, pageNumber));
    if (push) this.history.commit(this.getState());
    this.currentPage = n;
    this.scrollToPage(n, { instant });
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
    if (!this.history.canBack()) return;
    this.history.commit(this.getState());
    this.restore(this.history.back());
  }

  forward() {
    if (!this.history.canForward()) return;
    this.history.commit(this.getState());
    this.restore(this.history.forward());
  }

  async indexText() {
    const pages = [];
    for (let i = 1; i <= this.pageCount; i += 1) {
      if (!this.pdf) return [];
      const page = await this.pdf.getPage(i);
      const textContent = await page.getTextContent();
      this.textContents.set(i, textContent);
      pages.push({
        pageNumber: i,
        text: textContent.items.map((item) => item.str || "").join(""),
        textContent,
      });
    }
    this.pageTexts = pages;
    return pages;
  }

  async paintHighlights(pageNumber) {
    const el = this.pageEls[pageNumber - 1];
    if (!el || !this.pdf) return;
    const layer = el.querySelector(".hlLayer");
    layer.replaceChildren();
    if (!this.hits.length || !this.query) return;
    const textContent = this.textContents.get(pageNumber);
    if (!textContent) return;
    const page = await this.pdf.getPage(pageNumber);
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
    this.hits = hits;
    this.query = query;
    this.hitIndex = hits.length ? index : -1;
    const pages = new Set(this.hits.map((hit) => hit.pageNumber));
    await Promise.all([...pages].map((n) => this.paintHighlights(n)));
    if (hits[index]) await this.jumpToHit(index, { push: true });
  }

  async jumpToHit(index, { push = false } = {}) {
    if (!this.hits[index]) return;
    this.hitIndex = index;
    const hit = this.hits[index];
    this.goToPage(hit.pageNumber, { push, instant: true });
    await this.renderPage(hit.pageNumber, true);
    const pages = new Set(this.hits.map((item) => item.pageNumber));
    await Promise.all([...pages].map((n) => this.paintHighlights(n)));
  }
}
