/** @typedef {{ left: number, top: number, right: number, bottom: number, width: number, height: number }} RectLike */

function isValidRect(rect) {
  return rect && rect.width > 0 && rect.height > 0;
}

function rectsIntersectViewport(rect, viewport) {
  return (
    rect.bottom > viewport.top &&
    rect.top < viewport.bottom &&
    rect.right > viewport.left &&
    rect.left < viewport.right
  );
}

/**
 * Anchor bubble placement to the end of the user's selection (last drag point).
 * Multi-page selections have a huge union getBoundingClientRect(); use client rects instead.
 *
 * @param {Range} range
 * @param {RectLike | null} [viewportRect]
 */
function pickLastVisibleOrLast(rects, viewportRect) {
  if (!rects.length) return null;
  if (!viewportRect) return rects[rects.length - 1];
  const visible = rects.filter((rect) => rectsIntersectViewport(rect, viewportRect));
  const pool = visible.length ? visible : rects;
  return pool[pool.length - 1];
}

export function getSelectionAnchorRect(range, viewportRect = null) {
  const endRange = range.cloneRange();
  endRange.collapse(false);
  const endRects = [...endRange.getClientRects()].filter(isValidRect);
  const endAnchor = pickLastVisibleOrLast(endRects, viewportRect);
  if (endAnchor) return endAnchor;

  const endBox = endRange.getBoundingClientRect();
  if (isValidRect(endBox) && (!viewportRect || rectsIntersectViewport(endBox, viewportRect))) {
    return endBox;
  }

  const clientRects = [...range.getClientRects()].filter(isValidRect);
  const fromClients = pickLastVisibleOrLast(clientRects, viewportRect);
  if (fromClients) return fromClients;

  if (isValidRect(endBox)) return endBox;
  const union = range.getBoundingClientRect();
  if (isValidRect(union) && union.height > 200 && clientRects.length > 1) {
    return clientRects[clientRects.length - 1];
  }
  return union;
}

/**
 * @param {Selection} selection
 * @param {RectLike | null} [viewportRect]
 */
export function getSelectionAnchorFromSelection(selection, viewportRect = null) {
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const endInLayer =
    range.endContainer?.parentElement?.closest?.(".textLayer") ||
    range.startContainer?.parentElement?.closest?.(".textLayer");
  if (!endInLayer) return null;
  return getSelectionAnchorRect(range, viewportRect);
}
