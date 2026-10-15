import type { ArrangeResult, LayoutItem, PaperSize, Placement, SmartGrouping } from './layout'
import { PAPER_MARGIN_MM } from './paperBounds'
import { improveContourPacking } from './contourPacking'
import { arrangeGroupedItems } from './groupedPacking'

interface Rect { x: number; y: number; width: number; height: number }

const EPSILON = 1e-7

function subtractRect(freeRects: Rect[], used: Rect): Rect[] {
  const split: Rect[] = []
  for (const rect of freeRects) {
    const right = rect.x + rect.width
    const bottom = rect.y + rect.height
    const usedRight = used.x + used.width
    const usedBottom = used.y + used.height
    if (used.x >= right - EPSILON || usedRight <= rect.x + EPSILON ||
      used.y >= bottom - EPSILON || usedBottom <= rect.y + EPSILON) {
      split.push(rect)
      continue
    }
    if (used.x > rect.x + EPSILON) split.push({ ...rect, width: used.x - rect.x })
    if (usedRight < right - EPSILON) split.push({ ...rect, x: usedRight, width: right - usedRight })
    if (used.y > rect.y + EPSILON) split.push({ ...rect, height: used.y - rect.y })
    if (usedBottom < bottom - EPSILON) split.push({ ...rect, y: usedBottom, height: bottom - usedBottom })
  }
  // Free rectangles may overlap; remove contained ones to keep the search small.
  return split.filter((rect, index) => !split.some((other, otherIndex) => otherIndex !== index &&
    other.x <= rect.x + EPSILON && other.y <= rect.y + EPSILON &&
    other.x + other.width >= rect.x + rect.width - EPSILON &&
    other.y + other.height >= rect.y + rect.height - EPSILON &&
    (otherIndex < index || other.width > rect.width + EPSILON || other.height > rect.height + EPSILON)))
}

export function arrangeSmartItems(
  paper: PaperSize,
  items: LayoutItem[],
  gapXmm: number,
  gapYmm: number,
  reserved: Placement[] = [],
  grouping: SmartGrouping = 'free',
): ArrangeResult {
  const ordered = items.filter((item) => item.selected).map((item) => ({
    ...item,
    quantity: Number.isFinite(item.quantity) ? Math.min(500, Math.max(0, Math.floor(item.quantity))) : 0,
  })).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || Number(!!b.important) - Number(!!a.important) || b.widthMm * b.heightMm - a.widthMm * a.heightMm)
  const requested = ordered.reduce((sum, item) => sum + item.quantity, 0)
  let placements: Placement[] = []
  if (!Number.isFinite(paper.widthMm) || !Number.isFinite(paper.heightMm) || paper.widthMm <= PAPER_MARGIN_MM * 2 || paper.heightMm <= PAPER_MARGIN_MM * 2) {
    return { placements, overflow: requested }
  }
  if (grouping !== 'free') {
    placements = arrangeGroupedItems(paper, ordered, gapXmm, gapYmm, reserved, grouping)
    if (placements.length && !reserved.length) {
      const left = Math.min(...placements.map((slot) => slot.xMm))
      const right = Math.max(...placements.map((slot) => slot.xMm + slot.widthMm))
      const shift = (paper.widthMm - (right - left)) / 2 - left
      placements.forEach((slot) => { slot.xMm += shift })
    }
    return { placements, overflow: requested - placements.length }
  }

  // Reserve the paper margin; padding right/bottom accounts for inter-pattern gaps.
  let freeRects: Rect[] = [{
    x: PAPER_MARGIN_MM, y: PAPER_MARGIN_MM,
    width: paper.widthMm - PAPER_MARGIN_MM * 2 + gapXmm,
    height: paper.heightMm - PAPER_MARGIN_MM * 2 + gapYmm,
  }]
  for (const slot of reserved) {
    freeRects = subtractRect(freeRects, {
      x: slot.xMm, y: slot.yMm, width: slot.widthMm + gapXmm, height: slot.heightMm + gapYmm,
    })
  }

  for (const item of ordered) {
    if (!Number.isFinite(item.widthMm) || !Number.isFinite(item.heightMm) || item.widthMm <= 0 || item.heightMm <= 0) continue
    const width = item.widthMm + gapXmm
    const height = item.heightMm + gapYmm
    for (let count = 0; count < item.quantity; count += 1) {
      let best: Rect | undefined
      let bestShort = Infinity
      let bestLong = Infinity
      for (const rect of freeRects) {
        if (width > rect.width + EPSILON || height > rect.height + EPSILON) continue
        const short = Math.min(rect.width - width, rect.height - height)
        const long = Math.max(rect.width - width, rect.height - height)
        if (short < bestShort - EPSILON || (Math.abs(short - bestShort) <= EPSILON &&
          (long < bestLong - EPSILON || (Math.abs(long - bestLong) <= EPSILON &&
            (!best || rect.y < best.y - EPSILON || (Math.abs(rect.y - best.y) <= EPSILON && rect.x < best.x)))))) {
          best = rect
          bestShort = short
          bestLong = long
        }
      }
      if (!best) break
      placements.push({ itemId: item.id, xMm: best.x, yMm: best.y, widthMm: item.widthMm, heightMm: item.heightMm })
      freeRects = subtractRect(freeRects, { x: best.x, y: best.y, width, height })
    }
  }

  placements = improveContourPacking(paper, ordered, gapXmm, gapYmm, reserved, placements)
  if (placements.length && !reserved.length) {
    const left = Math.min(...placements.map((slot) => slot.xMm))
    const right = Math.max(...placements.map((slot) => slot.xMm + slot.widthMm))
    const shift = (paper.widthMm - (right - left)) / 2 - left
    placements.forEach((slot) => { slot.xMm += shift })
  }
  return { placements, overflow: requested - placements.length }
}
