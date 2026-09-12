/** @typedef {{ left: number, top: number, right: number, bottom: number, width: number, height: number }} RectLike */

export const BUBBLE_GAP = 8;
export const BUBBLE_MARGIN = 8;
export const BUBBLE_MIN_HEIGHT = 72;
/** Minimum height assumed when choosing above vs below (avoids tiny first layout staying below). */
export const BUBBLE_PLACEMENT_ESTIMATE = 280;

/**
 * Viewport-aware placement for the translate bubble (fixed coordinates).
 *
 * @param {RectLike} selectionRect
 * @param {RectLike} viewportRect - PDF viewer scrollport (#viewer-wrap)
 * @param {number} bubbleWidth
 * @param {number} bubbleHeight - measured natural height
 * @param {{ gap?: number, margin?: number, minHeight?: number }} [options]
 */
export function computeBubblePlacement(
  selectionRect,
  viewportRect,
  bubbleWidth,
  bubbleHeight,
  options = {},
) {
  const gap = options.gap ?? BUBBLE_GAP;
  const margin = options.margin ?? BUBBLE_MARGIN;
  const minHeight = options.minHeight ?? BUBBLE_MIN_HEIGHT;
  const placementHeight = Math.max(
    bubbleHeight,
    options.placementEstimate ?? BUBBLE_PLACEMENT_ESTIMATE,
  );

  const belowTop = selectionRect.bottom + gap;
  const spaceBelow = viewportRect.bottom - margin - belowTop;
  const spaceAbove = selectionRect.top - gap - (viewportRect.top + margin);

  let placeBelow;
  if (spaceBelow >= placementHeight) placeBelow = true;
  else if (spaceAbove >= placementHeight) placeBelow = false;
  else placeBelow = spaceBelow >= spaceAbove;

  const available = placeBelow ? spaceBelow : spaceAbove;
  const effectiveHeight = Math.min(bubbleHeight, Math.max(available, minHeight));

  let top = placeBelow
    ? belowTop
    : selectionRect.top - gap - effectiveHeight;

  const minTop = viewportRect.top + margin;
  const maxTop = viewportRect.bottom - margin - minHeight;
  top = Math.min(Math.max(top, minTop), maxTop);

  let maxHeight = viewportRect.bottom - margin - top;
  maxHeight = Math.max(maxHeight, minHeight);

  const minLeft = viewportRect.left + margin;
  const maxLeft = viewportRect.right - margin - bubbleWidth;
  const left = Math.min(Math.max(selectionRect.left, minLeft), maxLeft);

  return { left, top, maxHeight, placeBelow };
}

/**
 * @param {HTMLElement} bubbleEl
 * @param {RectLike} selectionRect
 * @param {RectLike} viewportRect
 */
export function applyBubblePlacement(bubbleEl, selectionRect, viewportRect, options) {
  const width = bubbleEl.offsetWidth;
  const height = bubbleEl.offsetHeight;
  const { left, top, maxHeight } = computeBubblePlacement(
    selectionRect,
    viewportRect,
    width,
    height,
    options,
  );
  bubbleEl.style.left = `${left}px`;
  bubbleEl.style.top = `${top}px`;
  bubbleEl.style.maxHeight = `${maxHeight}px`;
}
