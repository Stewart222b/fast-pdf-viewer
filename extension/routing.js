export const AUTO_OPEN_STORAGE_KEY = "autoOpenPdf";
export const OPEN_ORIGINAL_MESSAGE = "open-original";
export const VIEWER_PATH = "web/index.html";
export const PDF_BYPASS_PREFIX = "pdfOriginalBypass:";

export function parseHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function normalizeHttpUrl(value) {
  return parseHttpUrl(value)?.href ?? null;
}

export function permissionOriginFor(value) {
  const url = parseHttpUrl(value);
  return url ? `${url.protocol}//${url.hostname}/*` : null;
}

export function isPdfUrl(value) {
  const url = parseHttpUrl(value);
  return Boolean(url && url.pathname.toLowerCase().endsWith(".pdf"));
}

export function buildViewerUrl(getURL, originalUrl) {
  const safeUrl = normalizeHttpUrl(originalUrl);
  if (!safeUrl || typeof getURL !== "function") return null;
  const viewerUrl = new URL(getURL(VIEWER_PATH));
  viewerUrl.searchParams.set("file", safeUrl);
  return viewerUrl.href;
}

export function contentTypeFromHeaders(headers = []) {
  const header = headers.find(
    candidate => typeof candidate?.name === "string" && candidate.name.toLowerCase() === "content-type",
  );
  return typeof header?.value === "string" ? header.value : "";
}

export function isPdfContentType(headers) {
  return contentTypeFromHeaders(headers).split(";", 1)[0].trim().toLowerCase() === "application/pdf";
}

export function isLegacyPdfNavigation(details) {
  return (
    details?.type === "main_frame" &&
    details?.method === "GET" &&
    Number.isInteger(details?.tabId) &&
    details.tabId >= 0 &&
    Boolean(normalizeHttpUrl(details?.url)) &&
    isPdfContentType(details?.responseHeaders)
  );
}

export function bypassStorageKey(tabId) {
  return `${PDF_BYPASS_PREFIX}${tabId}`;
}

export function authorizedOpenOriginal(message, sender, getURL) {
  if (message?.type !== OPEN_ORIGINAL_MESSAGE || typeof getURL !== "function") return null;
  if (!Number.isInteger(sender?.tab?.id) || sender.tab.id < 0 || typeof sender?.url !== "string") return null;

  const requestedUrl = normalizeHttpUrl(message.url);
  if (!requestedUrl) return null;

  let senderUrl;
  let expectedViewerUrl;
  try {
    senderUrl = new URL(sender.url);
    expectedViewerUrl = new URL(getURL(VIEWER_PATH));
  } catch {
    return null;
  }

  if (senderUrl.origin !== expectedViewerUrl.origin || senderUrl.pathname !== expectedViewerUrl.pathname) {
    return null;
  }
  if (normalizeHttpUrl(senderUrl.searchParams.get("file")) !== requestedUrl) return null;

  return { tabId: sender.tab.id, url: requestedUrl };
}
