export class ViewHistory {
  constructor() {
    this.stack = [];
    this.index = -1;
    this.listeners = new Set();
  }

  snapshot(state) {
    return {
      page: state.page,
      zoom: state.zoom,
      scrollTop: state.scrollTop,
      scrollLeft: state.scrollLeft,
      anchor: state.anchor ? { ...state.anchor } : null,
    };
  }

  canBack() {
    return this.index > 0;
  }

  canForward() {
    return this.index >= 0 && this.index < this.stack.length - 1;
  }

  current() {
    return this.stack[this.index] || null;
  }

  reset(state) {
    this.stack = [this.snapshot(state)];
    this.index = 0;
    this.emit();
  }

  commit(state) {
    if (this.index >= 0 && this.stack[this.index]) {
      this.stack[this.index] = this.snapshot(state);
    }
  }

  push(state) {
    const next = this.snapshot(state);
    const cur = this.current();
    if (cur && same(cur, next)) return;
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(next);
    if (this.stack.length > 80) {
      this.stack.shift();
    } else {
      this.index += 1;
    }
    this.emit();
  }

  back() {
    if (!this.canBack()) return null;
    this.index -= 1;
    this.emit();
    return this.current();
  }

  forward() {
    if (!this.canForward()) return null;
    this.index += 1;
    this.emit();
    return this.current();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }
}

function same(a, b) {
  const aa = a.anchor;
  const ba = b.anchor;
  if (
    aa && ba &&
    Number.isFinite(aa.pdfX) && Number.isFinite(aa.pdfY) &&
    Number.isFinite(ba.pdfX) && Number.isFinite(ba.pdfY)
  ) {
    return (
      a.page === b.page &&
      aa.page === ba.page &&
      Math.abs((aa.pdfX ?? 0) - (ba.pdfX ?? 0)) < 2 &&
      Math.abs((aa.pdfY ?? 0) - (ba.pdfY ?? 0)) < 2 &&
      a.zoom === b.zoom
    );
  }
  return (
    a.page === b.page &&
    a.zoom === b.zoom &&
    Math.abs(a.scrollTop - b.scrollTop) < 8 &&
    Math.abs(a.scrollLeft - b.scrollLeft) < 8
  );
}
