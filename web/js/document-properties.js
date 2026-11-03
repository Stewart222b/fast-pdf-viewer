const EMPTY = "—";

function text(value) {
  const raw = String(value ?? "").trim();
  return raw || "";
}

export function formatFileSize(bytes, t) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return t("fileSizeBytes", { count: String(Math.round(n)) });
  if (n < 1024 * 1024) return t("fileSizeKb", { count: (n / 1024).toFixed(1) });
  return t("fileSizeMb", { count: (n / (1024 * 1024)).toFixed(2) });
}

export function formatPdfDate(value, locale = "zh-CN") {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  let date;
  if (match) {
    date = new Date(Date.UTC(
      Number(match[1]),
      Number(match[2] || 1) - 1,
      Number(match[3] || 1),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0),
    ));
  } else {
    date = new Date(raw);
  }
  if (Number.isNaN(date.getTime())) return raw;
  try {
    return date.toLocaleString(locale);
  } catch {
    return date.toISOString();
  }
}

export function formatPageSize(widthPt, heightPt, t) {
  const width = Number(widthPt);
  const height = Number(heightPt);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
  const mm = (pt) => (pt / 72 * 25.4).toFixed(1);
  const orientation = width > height ? t("pageLandscape") : t("pagePortrait");
  return t("pageSizeValue", { width: mm(width), height: mm(height), orientation });
}

function yesNo(value, t) {
  if (value === true) return t("yes");
  if (value === false) return t("no");
  return "";
}

function display(value) {
  return text(value) || EMPTY;
}

/**
 * @param {{
 *   fileName?: string,
 *   fileSize?: number,
 *   location?: string,
 *   pageCount?: number,
 *   pageWidth?: number,
 *   pageHeight?: number,
 *   info?: Record<string, unknown>,
 * }} snapshot
 */
export function buildDocumentPropertyRows(snapshot = {}, t, locale = "zh-CN") {
  const info = snapshot.info && typeof snapshot.info === "object" ? snapshot.info : {};
  const location = text(snapshot.location);
  const usableLocation = location && !/^blob:/i.test(location) ? location : "";
  const rows = [
    { key: "fileName", label: t("fileName"), value: display(snapshot.fileName) },
    { key: "fileSize", label: t("fileSize"), value: display(formatFileSize(snapshot.fileSize, t)) },
    { key: "title", label: t("documentTitle"), value: display(info.Title) },
    { key: "author", label: t("documentAuthor"), value: display(info.Author) },
    { key: "subject", label: t("documentSubject"), value: display(info.Subject) },
    { key: "keywords", label: t("documentKeywords"), value: display(info.Keywords) },
    { key: "created", label: t("documentCreationDate"), value: display(formatPdfDate(info.CreationDate, locale)) },
    { key: "modified", label: t("documentModDate"), value: display(formatPdfDate(info.ModDate, locale)) },
    { key: "creator", label: t("documentCreator"), value: display(info.Creator) },
    { key: "producer", label: t("documentProducer"), value: display(info.Producer) },
    { key: "version", label: t("pdfVersion"), value: display(info.PDFFormatVersion) },
    { key: "pageCount", label: t("documentPageCount"), value: display(snapshot.pageCount) },
    { key: "pageSize", label: t("pageSize"), value: display(formatPageSize(snapshot.pageWidth, snapshot.pageHeight, t)) },
    { key: "linearized", label: t("fastWebView"), value: display(yesNo(info.IsLinearized, t)) },
  ];
  if (usableLocation) {
    rows.splice(2, 0, { key: "location", label: t("documentLocationPath"), value: usableLocation });
  }
  return rows;
}
