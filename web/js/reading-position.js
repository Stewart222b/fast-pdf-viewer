const KEY_PREFIX = "fast-pdf-reader-position:";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 100;

function hashValues(values) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const value of values) {
    a = Math.imul(a ^ value, 0x01000193);
    b = Math.imul(b ^ value, 0x85ebca6b);
  }
  return [a, b].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

function hashText(value) {
  const text = String(value);
  return hashValues([text.length, ...Array.from(text, (char) => char.codePointAt(0))]);
}

function hashDocumentBytes(data) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  a = Math.imul(a ^ data.byteLength, 0x01000193);
  b = Math.imul(b ^ data.byteLength, 0x85ebca6b);
  for (let i = 0; i < data.byteLength; i += 1) {
    const byte = data[i];
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x85ebca6b);
  }
  return [a, b].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

function legacyFingerprint(source) {
  const name = source.name || "document";
  if (source.path) return `path:${source.path}`;
  if (source.size != null && source.lastModified != null) {
    return `file:${name}:${source.size}:${source.lastModified}`;
  }
  const url = source.url || "";
  if (!url.startsWith("blob:")) return `url:${url.split("?")[0]}`;
  return `blob:${name}:${source.size ?? 0}:${source.lastModified ?? 0}`;
}

export function readingFingerprint(source) {
  if (!source) return "";
  if (source.data instanceof Uint8Array && source.data.byteLength) {
    return `content:${source.data.byteLength}:${hashDocumentBytes(source.data)}`;
  }
  if (source.path) return `path:${hashText(source.path)}`;
  if (source.size != null && source.lastModified != null) {
    return `file:${hashText(`${source.name || "document"}:${source.size}:${source.lastModified}`)}`;
  }
  if (source.url && !source.url.startsWith("blob:")) return `url:${hashText(source.url)}`;
  return `blob:${hashText(`${source.name || "document"}:${source.size ?? 0}:${source.lastModified ?? 0}`)}`;
}

function recordIsFresh(data) {
  return data && typeof data === "object" && Number.isFinite(data.savedAt) &&
    Date.now() - data.savedAt <= MAX_AGE_MS && data.savedAt <= Date.now();
}

function storedKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

function privateKeyForLegacy(key) {
  const fingerprint = key.slice(KEY_PREFIX.length);
  if (/^(?:path|url|file|blob):[a-f0-9]{16}$|^content:\d+:[a-f0-9]{16}$/.test(fingerprint)) return key;
  const separator = fingerprint.indexOf(":");
  const type = fingerprint.slice(0, separator);
  if (!["path", "url", "file", "blob"].includes(type)) return null;
  return `${KEY_PREFIX}${type}:${hashText(fingerprint.slice(separator + 1))}`;
}

export function pruneReadingPositions() {
  try {
    const retained = new Map();
    for (const key of storedKeys()) {
      let data;
      try { data = JSON.parse(localStorage.getItem(key)); } catch { /* stale record */ }
      const privateKey = privateKeyForLegacy(key);
      if (!recordIsFresh(data) || !privateKey) {
        localStorage.removeItem(key);
        continue;
      }
      if (privateKey !== key) {
        let existing;
        try { existing = JSON.parse(localStorage.getItem(privateKey) || "null"); } catch { /* replace bad record */ }
        if (recordIsFresh(existing) && existing.savedAt >= data.savedAt) data = existing;
        else {
          localStorage.setItem(privateKey, JSON.stringify(data));
        }
        localStorage.removeItem(key);
      }
      retained.set(privateKey, { key: privateKey, savedAt: data.savedAt, order: retained.size });
    }
    const sorted = [...retained.values()].sort((a, b) => b.savedAt - a.savedAt || b.order - a.order);
    for (const { key } of sorted.slice(MAX_RECORDS)) localStorage.removeItem(key);
  } catch {
    /* storage may be unavailable */
  }
}

export function clearReadingPositions() {
  try {
    for (const key of storedKeys()) localStorage.removeItem(key);
  } catch {
    /* storage may be unavailable */
  }
}

export function loadReadingPosition(fingerprint, source = null) {
  if (!fingerprint) return null;
  try {
    const key = KEY_PREFIX + fingerprint;
    let data = JSON.parse(localStorage.getItem(key) || "null");
    if (!data && source) {
      const fallbackKeys = [
        source.path && `${KEY_PREFIX}path:${hashText(source.path)}`,
        KEY_PREFIX + legacyFingerprint(source),
      ].filter((candidate) => candidate && candidate !== key);
      for (const oldKey of fallbackKeys) {
        data = JSON.parse(localStorage.getItem(oldKey) || "null");
        if (!data) continue;
        if (recordIsFresh(data)) localStorage.setItem(key, JSON.stringify(data));
        localStorage.removeItem(oldKey);
        break;
      }
    }
    if (!recordIsFresh(data)) {
      localStorage.removeItem(key);
      return null;
    }
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
    pruneReadingPositions();
  } catch {
    /* quota */
  }
}
