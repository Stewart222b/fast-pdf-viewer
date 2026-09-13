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
  const left =
    maxLeft < minLeft ? minLeft : Math.min(Math.max(selectionRect.left, minLeft), maxLeft);

  return { left, top, maxHeight, placeBelow };
}

export function maxBubbleWidthForViewport(viewportRect, options = {}) {
  const margin = options.margin ?? BUBBLE_MARGIN;
  const cap = options.absoluteMax ?? 400;
  const viewportWidth = viewportRect.right - viewportRect.left;
  return Math.min(cap, Math.max(160, viewportWidth - margin * 2));
}

function intersectRects(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function windowRectFromGlobal(viewportRect) {
  const width = Number(globalThis.innerWidth) || 0;
  const height = Number(globalThis.innerHeight) || 0;
  if (width <= 0 || height <= 0) return viewportRect;
  return { left: 0, top: 0, right: width, bottom: height, width, height };
}

/**
 * @param {HTMLElement} bubbleEl
 * @param {RectLike} selectionRect
 * @param {RectLike} viewportRect
 */
export function applyBubblePlacement(bubbleEl, selectionRect, viewportRect, options) {
  const clip = intersectRects(viewportRect, options?.windowRect ?? windowRectFromGlobal(viewportRect));
  const usable = clip.width > 0 && clip.height > 0 ? clip : viewportRect;
  const maxWidth = maxBubbleWidthForViewport(usable, options);
  bubbleEl.style.maxWidth = `${maxWidth}px`;
  bubbleEl.style.width = `${maxWidth}px`;
  const width = bubbleEl.offsetWidth;
  const height = bubbleEl.offsetHeight;
  const { left, top, maxHeight } = computeBubblePlacement(
    selectionRect,
    usable,
    width,
    height,
    options,
  );
  bubbleEl.style.left = `${left}px`;
  bubbleEl.style.top = `${top}px`;
  bubbleEl.style.maxHeight = `${maxHeight}px`;
}
