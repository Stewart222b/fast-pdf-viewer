/** Classify the original source, before PDF.js turns it into bytes/blob URLs. */
export function pdfSourceKind(source = {}) {
  if (source.sourceKind === "local") return "local";
  const original = String(source.originalUrl || source.path || source.url || "").trim();
  if (/^https?:\/\//i.test(original)) return "remote";
  if (/^file:/i.test(original) || /^[a-z]:[\\/]/i.test(original) || /^\\\\/.test(original)) return "local";
  if (source.path && original.startsWith("/")) return "local";
  return "unknown";
}

export function pdfDownloadName(name) {
  let filename = String(name || "").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").trim().replace(/[. ]+$/, "");
  if (!filename) filename = "document";
  if (!/\.pdf$/i.test(filename)) filename += ".pdf";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) filename = `_${filename}`;
  return filename;
}

export async function originalPdfBlob(pdf, blob) {
  if (blob) return blob;
  // getData retrieves the original bytes, including any not yet fetched by Range.
  const bytes = await pdf.getData();
  return new Blob([bytes], { type: "application/pdf" });
}
