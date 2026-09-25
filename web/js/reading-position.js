const KEY_PREFIX = "fast-pdf-reader-position:";

export function readingFingerprint(source) {
  if (!source) return "";
  const name = source.name || "document";
  if (source.path) return `path:${source.path}`;
  if (source.size != null && source.lastModified != null) {
    return `file:${name}:${source.size}:${source.lastModified}`;
  }
  const url = source.url || "";
  if (!url.startsWith("blob:")) return `url:${url.split("?")[0]}`;
  return `blob:${name}:${source.size ?? 0}:${source.lastModified ?? 0}`;
}

export function loadReadingPosition(fingerprint) {
  if (!fingerprint) return null;
  try {
    const raw = localStorage.getItem(KEY_PREFIX + fingerprint);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

export function saveReadingPosition(fingerprint, state) {
  if (!fingerprint || !state) return;
  try {
    localStorage.setItem(
      KEY_PREFIX + fingerprint,
      JSON.stringify({
        page: state.page,
        zoom: state.zoom,
        scrollTop: state.scrollTop,
        scrollLeft: state.scrollLeft,
        anchor: state.anchor ? { ...state.anchor } : undefined,
        savedAt: Date.now(),
      }),
    );
  } catch {
    /* quota */
  }
}
