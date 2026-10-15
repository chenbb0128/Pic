import type { LayoutItem, PaperSize, Placement } from './layout'
import { CONTOUR_CELL_MM as CELL, type ContourMask, type ContourRow } from './contourMask'
import { PAPER_MARGIN_MM as MARGIN } from './paperBounds'

function rectangle(widthMm: number, heightMm: number): ContourMask {
  const width = Math.ceil(widthMm / CELL)
  return { width, rows: Array.from({ length: Math.ceil(heightMm / CELL) }, () => [0, width]) }
}

// Only occupied silhouette cells are blocked. Transparent corners remain usable.
function search(paper: PaperSize, items: LayoutItem[], gapXmm: number, gapYmm: number, reserved: Placement[], seed: Placement[], vertical: boolean): Placement[] {
  const columns = Math.ceil((paper.widthMm - MARGIN * 2) / CELL)
  const rows = Math.ceil((paper.heightMm - MARGIN * 2) / CELL)
  const stride = Math.ceil(columns / 32)
  const blocked = new Uint32Array(stride * rows)
  const gapX = Math.ceil(gapXmm / CELL)
  const gapY = Math.ceil(gapYmm / CELL)
  const shapes = new Map(items.map((item) => [item.id, item.contour ?? rectangle(item.widthMm, item.heightMm)]))
  const placements = seed.map((slot) => ({ ...slot }))

  function range(y: number, left: number, right: number, write: boolean): boolean {
    left = Math.max(0, left)
    right = Math.min(columns, right)
    if (y < 0 || y >= rows || left >= right) return false
    const first = left >>> 5
    const last = (right - 1) >>> 5
    for (let word = first; word <= last; word += 1) {
      const mask = (word === first ? 0xffffffff << (left & 31) : 0xffffffff) &
        (word === last ? 0xffffffff >>> (31 - ((right - 1) & 31)) : 0xffffffff)
      const index = y * stride + word
      if (write) blocked[index] |= mask
      else if (blocked[index] & mask) return true
    }
    return false
  }

  function stamp(slot: Placement, shape: ContourMask): void {
    const x = (slot.xMm - MARGIN) / CELL
    const y = (slot.yMm - MARGIN) / CELL
    const startX = Math.floor(x + 1e-7)
    const startY = Math.floor(y + 1e-7)
    const extraX = Math.ceil(x - startX - 1e-7)
    const extraY = Math.ceil(y - startY - 1e-7)
    // Merge nearby spans before writing to avoid repeatedly expanding every cell.
    const expanded: ContourRow[] = Array(shape.rows.length + gapY * 2 + extraY).fill(null)
    for (const [rowIndex, row] of shape.rows.entries()) {
      if (!row) continue
      for (let yy = rowIndex; yy <= rowIndex + gapY * 2 + extraY; yy += 1) {
        const previous = expanded[yy]
        expanded[yy] = [Math.min(previous?.[0] ?? Infinity, row[0] - gapX), Math.max(previous?.[1] ?? 0, row[1] + gapX + extraX)]
      }
    }
    expanded.forEach((row, index) => { if (row) range(startY + index - gapY, startX + row[0], startX + row[1], true) })
  }

  // Locked groups stay untouched and conservatively reserve their full rectangles.
  reserved.forEach((slot) => stamp(slot, rectangle(slot.widthMm, slot.heightMm)))
  seed.forEach((slot) => stamp(slot, shapes.get(slot.itemId) ?? rectangle(slot.widthMm, slot.heightMm)))

  const counts = new Map<string, number>()
  seed.forEach((slot) => counts.set(slot.itemId, (counts.get(slot.itemId) ?? 0) + 1))
  for (const item of items) {
    const maxX = Math.floor((paper.widthMm - MARGIN * 2 - item.widthMm) / CELL + 1e-7)
    const maxY = Math.floor((paper.heightMm - MARGIN * 2 - item.heightMm) / CELL + 1e-7)
    if (maxX < 0 || maxY < 0) continue
    const shape = shapes.get(item.id)!
    // Wide rows reject collisions first. Cursor never revisits a failed position:
    // adding more stickers cannot make a previously blocked position available.
    const checks = shape.rows.flatMap((row, y) => row ? [{ y, left: row[0], right: row[1] }] : [])
      .sort((a, b) => (b.right - b.left) - (a.right - a.left))
    let cursor = 0
    const inner = (vertical ? maxY : maxX) + 1
    const positions = (maxX + 1) * (maxY + 1)
    for (let count = counts.get(item.id) ?? 0; count < item.quantity; count += 1) {
      let found = false
      while (cursor < positions) {
        const current = cursor++
        const x = vertical ? Math.floor(current / inner) : current % inner
        const y = vertical ? current % inner : Math.floor(current / inner)
        if (checks.some((row) => range(y + row.y, x + row.left, x + row.right, false))) continue
        const slot = { itemId: item.id, xMm: MARGIN + x * CELL, yMm: MARGIN + y * CELL, widthMm: item.widthMm, heightMm: item.heightMm }
        placements.push(slot)
        stamp(slot, shape)
        found = true
        break
      }
      if (!found) break
    }
  }
  return placements
}

export function improveContourPacking(paper: PaperSize, ordered: LayoutItem[], gapXmm: number, gapYmm: number, reserved: Placement[], baseline: Placement[]): Placement[] {
  const items = ordered.filter((item) => Number.isFinite(item.widthMm) && Number.isFinite(item.heightMm) &&
    item.widthMm > 0 && item.heightMm > 0 && item.quantity > 0 &&
    item.widthMm <= paper.widthMm - MARGIN * 2 && item.heightMm <= paper.heightMm - MARGIN * 2)
  if (!items.some((item) => item.quantity > 0 && item.contour)) return baseline
  let best = baseline
  const count = (slots: Placement[], id: string) => slots.filter((slot) => slot.itemId === id).length
  const better = (candidate: Placement[]) => {
    for (const item of items.filter((entry) => entry.priority !== undefined || entry.important)) {
      const difference = count(candidate, item.id) - count(best, item.id)
      if (difference) return difference > 0
    }
    return candidate.length > best.length
  }
  // Keep an augmented original layout as a floor; try both scan directions too.
  for (const [seed, vertical] of [[baseline, false], [[], false], [[], true]] as [Placement[], boolean][]) {
    const candidate = search(paper, items, gapXmm, gapYmm, reserved, seed, vertical)
    if (better(candidate)) best = candidate
  }
  return best
}
