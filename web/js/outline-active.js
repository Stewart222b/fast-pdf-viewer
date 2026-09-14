/** Dest Y is PDF user space (origin bottom-left). Larger Y is higher on the page. */
const SAME_PAGE_Y_SLOP = 8;

function destTypeName(type) {
  if (type == null) return "";
  if (typeof type === "string") return type;
  return type.name || "";
}

export function destPdfY(explicit) {
  if (!Array.isArray(explicit)) return NaN;
  const type = destTypeName(explicit[1]);
  let y;
  if (type === "XYZ") y = explicit[3];
  else if (type === "FitH" || type === "FitBH") y = explicit[2];
  else return NaN;
  if (y == null || y === "") return NaN;
  const n = Number(y);
  return Number.isFinite(n) ? n : NaN;
}

function destOrder(a, b) {
  if (a.page !== b.page) return a.page - b.page;
  const aHasY = Number.isFinite(a.pdfY);
  const bHasY = Number.isFinite(b.pdfY);
  if (aHasY && bHasY && a.pdfY !== b.pdfY) return b.pdfY - a.pdfY;
  return a.index - b.index;
}

function destReached(row, page, pdfY) {
  if (row.page < page) return true;
  if (row.page > page) return false;
  if (!Number.isFinite(row.pdfY) || !Number.isFinite(pdfY)) return false;
  return row.pdfY >= pdfY - SAME_PAGE_Y_SLOP;
}

/**
 * Section under the viewport: last dest at or above the reading point.
 * Same-page entries without Y snap to the first heading on that page,
 * not the last — so 1.1/1.2/1.3 never collapse onto 1.3.
 */
export function pickOutlineActive(entries, view) {
  const page = Number(view?.page);
  if (!entries?.length || !Number.isFinite(page) || page < 1) return null;
  const pdfY = Number(view?.pdfY);
  const ranked = entries
    .map((entry, index) => ({
      entry,
      index,
      page: Number(entry.page),
      pdfY: Number(entry.pdfY),
    }))
    .filter((row) => Number.isFinite(row.page) && row.page > 0)
    .sort(destOrder);
  if (!ranked.length) return null;
  let active = null;
  for (const row of ranked) {
    if (destReached(row, page, pdfY)) active = row.entry;
    else if (row.page > page) break;
  }
  if (!active || Number(active.page) < page) {
    const firstOnPage = ranked.find((row) => row.page === page);
    if (firstOnPage) active = firstOnPage.entry;
  }
  return active;
}
