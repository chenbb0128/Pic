import type { LayoutItem, PaperSize, Placement } from './layout'
import { PAPER_MARGIN_MM } from './paperBounds'

// Keep tall patterns and adjacent stacked columns together during alignment.
interface Column { xMm: number; widthMm: number; slots: Placement[] }
interface Band { yMm: number; heightMm: number; columns: Column[] }

export function packStackedBands(
  items: LayoutItem[], paper: PaperSize, gapXmm: number, gapYmm: number,
  marginX: number, marginY: number, spreadX: boolean, autoGap: boolean,
  quantity?: number,
): Placement[] | null {
  const bands: Band[] = []
  const placements: Placement[] = []
  let band: Band = { yMm: marginY, heightMm: 0, columns: [] }
  const place = (item: LayoutItem): boolean => {
    for (const column of [...band.columns].reverse()) {
      const last = column.slots[column.slots.length - 1]!
      const yMm = last.yMm + last.heightMm + gapYmm
      if (last.itemId !== item.id || yMm + item.heightMm > band.yMm + band.heightMm + 0.001) continue
      const slot = { itemId: item.id, xMm: column.xMm, yMm, widthMm: item.widthMm, heightMm: item.heightMm }
      column.slots.push(slot)
      placements.push(slot)
      return true
    }
    const lastColumn = band.columns[band.columns.length - 1]
    const xMm = lastColumn ? lastColumn.xMm + lastColumn.widthMm + gapXmm : marginX
    if (xMm + item.widthMm > paper.widthMm - marginX + 0.001 ||
      band.yMm + item.heightMm > paper.heightMm - marginY + 0.001) return false
    const slot = { itemId: item.id, xMm, yMm: band.yMm, widthMm: item.widthMm, heightMm: item.heightMm }
    if (!band.columns.length) bands.push(band)
    band.heightMm = Math.max(band.heightMm, item.heightMm)
    band.columns.push({ xMm, widthMm: item.widthMm, slots: [slot] })
    placements.push(slot)
    return true
  }
  const nextBand = () => {
    band = { yMm: band.yMm + band.heightMm + gapYmm, heightMm: 0, columns: [] }
  }

  if (quantity !== undefined) {
    for (const item of items) {
      for (let index = 0; index < quantity; index += 1) {
        if (place(item)) continue
        nextBand()
        if (!place(item)) return null
      }
    }
  } else {
    // Preserve the big-first cycle, but do not abandon a band's side space
    // just because its next large pattern needs another row.
    while (placements.length < 1000) {
      let added = false
      for (const item of items) {
        if (placements.length >= 1000) break
        if (place(item)) added = true
      }
      if (added) continue
      if (!band.columns.length) break
      nextBand()
    }
  }

  const alignMarginX = autoGap ? PAPER_MARGIN_MM : marginX
  const alignMarginY = autoGap ? PAPER_MARGIN_MM : marginY
  const totalHeight = bands.reduce((sum, row) => sum + row.heightMm, 0)
  const bandGap = bands.length > 1 ? (paper.heightMm - alignMarginY * 2 - totalHeight) / (bands.length - 1) : 0
  let nextY = alignMarginY
  for (const row of bands) {
    const yMm = autoGap ? bands.length === 1 ? (paper.heightMm - row.heightMm) / 2 : nextY : row.yMm
    const totalWidth = row.columns.reduce((sum, column) => sum + column.widthMm, 0)
    const last = row.columns[row.columns.length - 1]!
    const usedWidth = last.xMm + last.widthMm - marginX
    const spread = spreadX || autoGap
    const columnGap = spread && row.columns.length > 1
      ? (paper.widthMm - alignMarginX * 2 - totalWidth) / (row.columns.length - 1) : gapXmm
    let nextX = spread && row.columns.length > 1 ? alignMarginX : (paper.widthMm - usedWidth) / 2
    for (const column of row.columns) {
      for (const slot of column.slots) {
        slot.xMm += nextX - column.xMm
        slot.yMm += yMm - row.yMm
      }
      nextX += column.widthMm + columnGap
    }
    nextY += row.heightMm + bandGap
  }
  return placements
}
