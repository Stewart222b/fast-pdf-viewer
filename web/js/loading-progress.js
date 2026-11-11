export function formatLoadingBytes(value, locale = "en") {
  const number = Number(value);
  const bytes = Number.isFinite(number) ? Math.max(0, number) : 0;
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(3, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index ? 1 : 0 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

export function createLoadingProgress({ wrap, track, fill, detail }, { translate, locale }) {
  let active = false;
  let phase = "download";
  let loaded = 0;
  let total = 0;
  function render() {
    wrap.hidden = !active;
    if (!active) return;
    const known = phase !== "prepare" && total > 0 && loaded <= total;
    const percent = known ? Math.floor(loaded / total * 100) : null;
    wrap.dataset.mode = known ? "determinate" : "indeterminate";
    fill.style.width = known ? `${percent}%` : "35%";
    track.setAttribute("aria-label", translate("pdfLoadingProgress"));
    if (known) track.setAttribute("aria-valuenow", String(percent));
    else track.removeAttribute("aria-valuenow");
    const bytes = value => formatLoadingBytes(value, locale());
    detail.textContent = phase === "prepare" ? translate("pdfLoadingPrepare")
      : known ? translate("pdfLoadingBytes", { loaded: bytes(loaded), total: bytes(total), percent })
      : loaded ? translate("pdfLoadingReceived", { loaded: bytes(loaded) })
      : translate("pdfLoadingWaiting");
    track.setAttribute("aria-valuetext", detail.textContent);
  }
  return {
    start() { active = true; phase = "download"; loaded = 0; total = 0; render(); },
    update(event = {}) {
      if (!active) return;
      if (event.phase) phase = event.phase;
      else if (phase !== "prepare") phase = "download";
      if (phase !== "prepare") {
        const next = Number(event.loaded);
        loaded = Math.max(loaded, Number.isFinite(next) ? next : 0);
        const size = Number(event.total);
        if (Number.isFinite(size) && size > 0) total = size;
      }
      render();
    },
    stop() { active = false; wrap.hidden = true; detail.textContent = ""; track.removeAttribute("aria-valuenow"); },
    refresh: render,
  };
}
