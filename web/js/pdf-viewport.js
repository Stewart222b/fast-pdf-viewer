function inverseTransform(m) {
  const d = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[4] * m[3]) / d,
    (m[4] * m[1] - m[5] * m[0]) / d,
  ];
}

function applyTransform(p, m) {
  const x = p[0];
  const y = p[1];
  p[0] = m[0] * x + m[2] * y + m[4];
  p[1] = m[1] * x + m[3] * y + m[5];
}

function applyInverseTransform(p, m) {
  applyTransform(p, inverseTransform(m));
}

/** Build the PDF.js page transform for CSS ↔ PDF user-space conversion. */
export function viewportTransform({
  viewBox,
  userUnit = 1,
  rotation = 0,
  scale,
  offsetX = 0,
  offsetY = 0,
  dontFlip = false,
}) {
  scale *= userUnit;
  const centerX = (viewBox[2] + viewBox[0]) / 2;
  const centerY = (viewBox[3] + viewBox[1]) / 2;
  let rotateA;
  let rotateB;
  let rotateC;
  let rotateD;
  rotation %= 360;
  if (rotation < 0) rotation += 360;
  switch (rotation) {
    case 180:
      rotateA = -1;
      rotateB = 0;
      rotateC = 0;
      rotateD = 1;
      break;
    case 90:
      rotateA = 0;
      rotateB = 1;
      rotateC = 1;
      rotateD = 0;
      break;
    case 270:
      rotateA = 0;
      rotateB = -1;
      rotateC = -1;
      rotateD = 0;
      break;
    default:
      rotateA = 1;
      rotateB = 0;
      rotateC = 0;
      rotateD = -1;
      break;
  }
  if (dontFlip) {
    rotateC = -rotateC;
    rotateD = -rotateD;
  }
  let offsetCanvasX;
  let offsetCanvasY;
  if (rotateA === 0) {
    offsetCanvasX = Math.abs(centerY - viewBox[1]) * scale + offsetX;
    offsetCanvasY = Math.abs(centerX - viewBox[0]) * scale + offsetY;
  } else {
    offsetCanvasX = Math.abs(centerX - viewBox[0]) * scale + offsetX;
    offsetCanvasY = Math.abs(centerY - viewBox[1]) * scale + offsetY;
  }
  return [
    rotateA * scale,
    rotateB * scale,
    rotateC * scale,
    rotateD * scale,
    offsetCanvasX - rotateA * scale * centerX - rotateC * scale * centerY,
    offsetCanvasY - rotateB * scale * centerX - rotateD * scale * centerY,
  ];
}

export function convertCssToPdfPoint(layout, scale, cssX, cssY) {
  if (!layout?.viewBox || !Number.isFinite(scale) || scale <= 0) return [NaN, NaN];
  const transform = viewportTransform({
    viewBox: layout.viewBox,
    userUnit: layout.userUnit ?? 1,
    rotation: layout.rotation ?? 0,
    scale,
  });
  const point = [cssX, cssY];
  applyInverseTransform(point, transform);
  return point;
}

export function convertPdfToCssPoint(layout, scale, pdfX, pdfY) {
  if (!layout?.viewBox || !Number.isFinite(scale) || scale <= 0) return [NaN, NaN];
  const transform = viewportTransform({
    viewBox: layout.viewBox,
    userUnit: layout.userUnit ?? 1,
    rotation: layout.rotation ?? 0,
    scale,
  });
  const point = [pdfX, pdfY];
  applyTransform(point, transform);
  return point;
}
