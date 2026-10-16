import type { ArrangeResult, LayoutItem, PaperSize, Placement } from './layout'
import { PAPER_MARGIN_MM as MARGIN } from './paperBounds'

interface Column { xMm: number; widthMm: number; slots: Placement[] }
interface Band { yMm: number; heightMm: number; columns: Column[] }
interface Packed { placements: Placement[]; bands: Band[] }
const EPSILON = 1e-6

// Size ordering is visual only. Admission below protects the list's quantity
// priority before rearranging the accepted images into aligned bands.
function packBands(items: LayoutItem[], paper: PaperSize, gapX: number, gapY: number, reserved: Placement[]): Packed | null {
  const bands: Band[] = []
  const placements: Placement[] = []
  const right = paper.widthMm - MARGIN
  const bottom = paper.heightMm - MARGIN
  const ordered = [...items].sort((a, b) => b.heightMm - a.heightMm || b.widthMm - a.widthMm)
  const clear = (x: number, y: number, width: number, height: number) => reserved.every(lock =>
    x + width + gapX <= lock.xMm + EPSILON || lock.xMm + lock.widthMm + gapX <= x + EPSILON ||
    y + height + gapY <= lock.yMm + EPSILON || lock.yMm + lock.heightMm + gapY <= y + EPSILON)

  function addColumn(band: Band, item: LayoutItem): boolean {
    const last = band.columns[band.columns.length - 1]
    const start = last ? last.xMm + last.widthMm + gapX : MARGIN
    if (start + item.widthMm > right + EPSILON) return false
    // A locked rectangle may leave a usable span on its right.
    const candidates = [start, ...reserved.map(lock => lock.xMm + lock.widthMm + gapX)]
      .filter(x => x >= start - EPSILON).sort((a, b) => a - b)
    const xMm = candidates.find(x => x + item.widthMm <= right + EPSILON && clear(x, band.yMm, item.widthMm, band.heightMm))
    if (xMm === undefined) return false
    const slot = { itemId: item.id, xMm, yMm: band.yMm, widthMm: item.widthMm, heightMm: item.heightMm }
    band.columns.push({ xMm, widthMm: item.widthMm, slots: [slot] })
    placements.push(slot)
    return true
  }

  for (const item of ordered) {
    for (let copy = 0; copy < item.quantity; copy += 1) {
      let placed = false
      // Different patterns with similar widths can share one small-image column.
      for (const band of bands) {
        // Heights are descending: every column already contains an image at
        // least this tall, so shorter bands cannot possibly fit a second one.
        if (band.heightMm + EPSILON < item.heightMm * 2 + gapY) continue
        for (const column of band.columns) {
          const last = column.slots[column.slots.length - 1]!
          const yMm = last.yMm + last.heightMm + gapY
          if (item.widthMm > column.widthMm + EPSILON || item.widthMm < column.widthMm * 0.8 ||
            yMm + item.heightMm > band.yMm + band.heightMm + EPSILON) continue
          const slot = { itemId: item.id, xMm: column.xMm + (column.widthMm - item.widthMm) / 2,
            yMm, widthMm: item.widthMm, heightMm: item.heightMm }
          column.slots.push(slot)
          placements.push(slot)
          placed = true
          break
        }
        if (placed) break
      }
      if (placed) continue
      for (const band of bands) {
        if (addColumn(band, item)) { placed = true; break }
      }
      if (placed) continue
      const lastBand = bands[bands.length - 1]
      const startY = lastBand ? lastBand.yMm + lastBand.heightMm + gapY : MARGIN
      const candidates = [startY, ...reserved.map(lock => lock.yMm + lock.heightMm + gapY)]
        .filter(y => y >= startY - EPSILON).sort((a, b) => a - b)
      for (const yMm of candidates) {
        if (yMm + item.heightMm > bottom + EPSILON) continue
        const band: Band = { yMm, heightMm: item.heightMm, columns: [] }
        if (addColumn(band, item)) { bands.push(band); placed = true; break }
      }
      if (!placed) return null
    }
  }
  return { placements, bands }
}

export function arrangeNeatItems(paper: PaperSize, items: LayoutItem[], gapX: number, gapY: number, reserved: Placement[] = []): ArrangeResult {
  const ordered = items.filter(item => item.selected).map(item => ({ ...item,
    quantity: Number.isFinite(item.quantity) ? Math.min(500, Math.max(0, Math.floor(item.quantity))) : 0,
  })).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const requested = ordered.reduce((sum, item) => sum + item.quantity, 0)
  if (!Number.isFinite(paper.widthMm) || !Number.isFinite(paper.heightMm) || paper.widthMm <= MARGIN * 2 || paper.heightMm <= MARGIN * 2) {
    return { placements: [], overflow: requested }
  }
  const accepted: LayoutItem[] = []
  let packed: Packed = { placements: [], bands: [] }
  for (const item of ordered) {
    if (!item.quantity || !Number.isFinite(item.widthMm) || !Number.isFinite(item.heightMm) || item.widthMm <= 0 || item.heightMm <= 0 ||
      item.widthMm > paper.widthMm - MARGIN * 2 + EPSILON || item.heightMm > paper.heightMm - MARGIN * 2 + EPSILON) continue
    // Try the full target first, then find an admissible partial quantity without
    // ever evicting a previously accepted, higher-priority pattern.
    let quantity = item.quantity
    let candidate = packBands([...accepted, item], paper, gapX, gapY, reserved)
    if (!candidate) {
      let low = 0
      let high = item.quantity - 1
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const trial = packBands([...accepted, { ...item, quantity: middle }], paper, gapX, gapY, reserved)
        if (trial) { low = middle; candidate = trial } else high = middle - 1
      }
      quantity = low
      if (quantity) candidate = packBands([...accepted, { ...item, quantity }], paper, gapX, gapY, reserved)
    }
    if (quantity && candidate) { accepted.push({ ...item, quantity }); packed = candidate }
  }
  if (packed.placements.length && !reserved.length) {
    // Center each small stack within its tall band, keeping its fixed spacing.
    for (const band of packed.bands) {
      for (const column of band.columns) {
        const last = column.slots[column.slots.length - 1]!
        const shift = (band.heightMm - (last.yMm + last.heightMm - band.yMm)) / 2
        column.slots.forEach(slot => { slot.yMm += shift })
      }
    }
    const left = Math.min(...packed.placements.map(slot => slot.xMm))
    const right = Math.max(...packed.placements.map(slot => slot.xMm + slot.widthMm))
    const top = Math.min(...packed.placements.map(slot => slot.yMm))
    const bottom = Math.max(...packed.placements.map(slot => slot.yMm + slot.heightMm))
    const shiftX = (paper.widthMm - (right - left)) / 2 - left
    const shiftY = (paper.heightMm - (bottom - top)) / 2 - top
    packed.placements.forEach(slot => { slot.xMm += shiftX; slot.yMm += shiftY })
  }
  return { placements: packed.placements, overflow: requested - packed.placements.length }
}
