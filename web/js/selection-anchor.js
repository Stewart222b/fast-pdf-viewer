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
export function getSelectionAnchorRect(range, viewportRect = null) {
  const clientRects = [...range.getClientRects()].filter(isValidRect);
  if (clientRects.length) {
    const visible = viewportRect
      ? clientRects.filter((rect) => rectsIntersectViewport(rect, viewportRect))
      : clientRects;
    const pool = visible.length ? visible : clientRects;
    return pool[pool.length - 1];
  }

  const endRange = range.cloneRange();
  endRange.collapse(false);
  const endRects = [...endRange.getClientRects()].filter(isValidRect);
  if (endRects.length) {
    const last = endRects[endRects.length - 1];
    if (!viewportRect || rectsIntersectViewport(last, viewportRect)) return last;
  }

  const collapsed = endRange.getBoundingClientRect();
  if (isValidRect(collapsed)) return collapsed;
  return range.getBoundingClientRect();
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
