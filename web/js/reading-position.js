const KEY_PREFIX = "fast-pdf-reader-position:";

export function readingFingerprint(source) {
  if (!source) return "";
  const name = source.name || "document";
  const url = source.url || "";
  if (url.startsWith("blob:")) return `blob:${name}`;
  const idMatch = url.match(/\/opened\/([0-9a-f]{32})\.pdf/);
  if (idMatch) return `desktop:${idMatch[1]}:${name}`;
  return `url:${name}:${url.split("?")[0]}`;
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
        savedAt: Date.now(),
      }),
    );
  } catch {
    /* quota */
  }
}
