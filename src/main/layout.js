export function computeGrid(count, contentBounds, { cols, gap = 8, topOffset = 0 }) {
  if (count <= 0 || cols <= 0) return [];
  const { width: W, height: H } = contentBounds;
  const rows = Math.ceil(count / cols);
  const cellH = Math.floor((H - topOffset - gap * (rows + 1)) / rows);
  if (cellH <= 0) return [];
  const rects = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const slotsInRow = Math.min(cols, count - r * cols);
    const cellW = Math.floor((W - gap * (slotsInRow + 1)) / slotsInRow);
    if (cellW <= 0) return [];
    rects.push({
      x: gap + c * (cellW + gap),
      y: topOffset + gap + r * (cellH + gap),
      width: cellW,
      height: cellH,
    });
  }
  return rects;
}
