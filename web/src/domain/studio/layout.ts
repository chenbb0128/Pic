import { imageSizePresets, type ImageSizePreset } from './imageSizeConversion'
import { arrangeSmartItems } from './smartPacking'
import { PAPER_MARGIN_MM } from './paperBounds'
import type { ContourMask } from './contourMask'
import { packStackedBands } from './bandPacking'
import { arrangeNeatItems } from './neatPacking'

export type PaperPreset = ImageSizePreset['value'] | 'custom'
export type Orientation = 'landscape' | 'portrait'
export type LayoutMode = 'balanced' | 'compact' | 'custom' | 'smart' | 'neat'
export type SmartGrouping = 'free' | 'rows' | 'columns'

export interface PaperSize { widthMm: number; heightMm: number }
export interface LayoutItem {
  id: string
  widthMm: number
  heightMm: number
  quantity: number
  selected: boolean
  important?: boolean
  priority?: number
  contour?: ContourMask
  gapXmm?: number
  gapYmm?: number
  startNewRow?: boolean
}
export interface Placement {
  itemId: string
  xMm: number
  yMm: number
  widthMm: number
  heightMm: number
}
export interface ArrangeOptions {
  paper: PaperSize
  gapMm?: number
  gapXmm?: number
  gapYmm?: number
  autoGap?: boolean
  mode: LayoutMode
  grouping?: SmartGrouping
  items: LayoutItem[]
  reserved?: Placement[]
}
export interface ArrangeResult { placements: Placement[]; overflow: number }

export function customItemGap(item: Pick<LayoutItem, 'gapXmm' | 'gapYmm'> | undefined, axis: 'x' | 'y', fallback: number): number {
  const value = axis === 'x' ? item?.gapXmm : item?.gapYmm
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback
}

export function paperSize(preset: PaperPreset, orientation: Orientation): PaperSize {
  if (preset === 'custom') throw new Error('自定义纸张需要输入宽度和高度。')
  const option = imageSizePresets.find((item) => item.value === preset)!
  const size = { widthMm: Math.max(option.widthMm, option.heightMm), heightMm: Math.min(option.widthMm, option.heightMm) }
  return orientation === 'landscape' ? size : { widthMm: size.heightMm, heightMm: size.widthMm }
}

export function horizontalPaperSize(preset: PaperPreset, customWidth: number, customHeight: number): PaperSize {
  if (preset !== 'custom') return paperSize(preset, 'landscape')
  const widthMm = Math.min(420, Math.max(50, Number(customWidth) || 293))
  const heightMm = Math.min(420, Math.max(50, Number(customHeight) || 210))
  return { widthMm: Math.max(widthMm, heightMm), heightMm: Math.min(widthMm, heightMm) }
}

export function orientedPaperSize(preset: PaperPreset, orientation: Orientation, customWidth: number, customHeight: number): PaperSize {
  const size = horizontalPaperSize(preset, customWidth, customHeight)
  return orientation === 'landscape' ? size : { widthMm: size.heightMm, heightMm: size.widthMm }
}

export function arrangeItems(options: ArrangeOptions): ArrangeResult {
  const { paper, mode } = options
  const gapXmm = options.autoGap ? 5 : Math.max(0, options.gapXmm ?? options.gapMm ?? 0)
  const gapYmm = options.autoGap ? 5 : Math.max(0, options.gapYmm ?? options.gapMm ?? 0)
  if (mode === 'smart') return arrangeSmartItems(paper, options.items, gapXmm, gapYmm, options.reserved, options.grouping)
  if (mode === 'neat') return arrangeNeatItems(paper, options.items, gapXmm, gapYmm, options.reserved)
  const requested = mode === 'custom' ? options.items.reduce((sum, item) => sum + (item.selected && Number.isFinite(item.quantity)
    ? Math.min(500, Math.max(0, Math.floor(item.quantity))) : 0), 0) : 0
  const right = paper.widthMm - PAPER_MARGIN_MM
  const bottom = paper.heightMm - PAPER_MARGIN_MM
  const items = options.items.filter((item) =>
    item.selected && item.widthMm > 0 && item.heightMm > 0 &&
    (mode === 'custom' || (item.widthMm <= paper.widthMm - PAPER_MARGIN_MM * 2 && item.heightMm <= paper.heightMm - PAPER_MARGIN_MM * 2)),
  )
  if (!items.length || paper.widthMm <= 0 || paper.heightMm <= 0) return { placements: [], overflow: requested }

  const ordered = mode === 'compact'
    ? [...items].sort((a, b) => b.widthMm * b.heightMm - a.widthMm * a.heightMm)
    : mode === 'balanced' ? [...items].sort((a, b) => a.widthMm - b.widthMm)
    : [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || Number(!!b.important) - Number(!!a.important))
  const queue = mode === 'custom'
    ? ordered.flatMap((item) => Array.from({ length: Math.min(500, Math.max(0, Math.floor(item.quantity))) }, () => item))
    : []

  const placements: Placement[] = []
  let overflow = 0
  let balancedMarginX = 0
  if (mode === 'custom') {
    // Keep a row's tall patterns and its stacked small columns as one band.
    // Center/spread columns together, not each distinct y coordinate independently.
    interface Column { xMm: number; widthMm: number; gapXmm: number; slots: Placement[] }
    interface Band { yMm: number; heightMm: number; gapYmm: number; columns: Column[] }
    const bands: Band[] = []
    const autoX = options.autoGap && !items.some(item => item.quantity > 0 && item.gapXmm !== undefined && Number.isFinite(item.gapXmm))
    const autoY = options.autoGap && !items.some(item => item.quantity > 0 && item.gapYmm !== undefined && Number.isFinite(item.gapYmm))
    let previousItemId: string | undefined
    let pendingNewRow = false
    for (const item of queue) {
      if (item.id !== previousItemId && item.startNewRow) pendingNewRow = true
      previousItemId = item.id
      if (!Number.isFinite(item.widthMm) || !Number.isFinite(item.heightMm) || item.widthMm > right - PAPER_MARGIN_MM || item.heightMm > bottom - PAPER_MARGIN_MM) continue
      const itemGapX = customItemGap(item, 'x', gapXmm)
      const itemGapY = customItemGap(item, 'y', gapYmm)
      let band = bands[bands.length - 1]
      const previousBand = bands[bands.length - 2]
      const column = band?.columns[band.columns.length - 1]
      const last = column?.slots[column.slots.length - 1]
      const bandY = previousBand
        ? Math.max(band!.yMm, previousBand.yMm + previousBand.heightMm + Math.max(previousBand.gapYmm, band!.gapYmm, itemGapY))
        : band?.yMm ?? PAPER_MARGIN_MM
      const shiftY = band ? bandY - band.yMm : 0
      const stackY = last ? last.yMm + shiftY + last.heightMm + itemGapY : 0
      const canStack = !pendingNewRow && band && column && last?.itemId === item.id && stackY + item.heightMm <= bandY + band.heightMm + 0.001
      let xMm = canStack ? column.xMm : column ? column.xMm + column.widthMm + Math.max(column.gapXmm, itemGapX) : PAPER_MARGIN_MM
      let yMm = canStack ? stackY : bandY
      const newBand = !band || pendingNewRow || xMm + item.widthMm > right + 0.001
      if (newBand && band) { xMm = PAPER_MARGIN_MM; yMm = band.yMm + band.heightMm + Math.max(band.gapYmm, itemGapY) }
      // Only commit a row/shift after a successful placement. Explicit row breaks
      // remain pending on failure so later small patterns cannot backfill above them.
      const bandBottom = newBand ? yMm + item.heightMm : bandY + Math.max(band!.heightMm, item.heightMm)
      if (bandBottom > bottom + 0.001) continue
      if (newBand) {
        band = { yMm, heightMm: 0, gapYmm: itemGapY, columns: [] }
        bands.push(band)
      } else if (shiftY) {
        band!.columns.forEach(col => col.slots.forEach(slot => { slot.yMm += shiftY }))
        band!.yMm = bandY
      }
      band!.heightMm = Math.max(band!.heightMm, item.heightMm)
      band!.gapYmm = Math.max(band!.gapYmm, itemGapY)
      const slot = { itemId: item.id, xMm, yMm, widthMm: item.widthMm, heightMm: item.heightMm }
      if (canStack && !newBand) column.slots.push(slot)
      else band!.columns.push({ xMm, widthMm: item.widthMm, gapXmm: itemGapX, slots: [slot] })
      placements.push(slot)
      pendingNewRow = false
    }
    const remainingHeight = paper.heightMm - PAPER_MARGIN_MM * 2 - bands.reduce((sum, band) => sum + band.heightMm, 0)
    let nextY = PAPER_MARGIN_MM
    for (const band of bands) {
      const bandY = autoY ? bands.length === 1 ? (paper.heightMm - band.heightMm) / 2 : nextY : band.yMm
      const usedWidth = band.columns.reduce((sum, column) => sum + column.widthMm, 0)
      const lastColumn = band.columns[band.columns.length - 1]!
      const bandWidth = lastColumn.xMm + lastColumn.widthMm - PAPER_MARGIN_MM
      const columnGap = autoX && band.columns.length > 1
        ? (paper.widthMm - PAPER_MARGIN_MM * 2 - usedWidth) / (band.columns.length - 1) : gapXmm
      const centerShift = (paper.widthMm - bandWidth) / 2 - PAPER_MARGIN_MM
      let nextX = band.columns.length > 1 ? PAPER_MARGIN_MM : (paper.widthMm - bandWidth) / 2
      for (const column of band.columns) {
        for (const slot of column.slots) { slot.xMm += autoX ? nextX - column.xMm : centerShift; slot.yMm += bandY - band.yMm }
        nextX += column.widthMm + columnGap
      }
      nextY += band.heightMm + (bands.length > 1 ? remainingHeight / (bands.length - 1) : 0)
    }
    return { placements, overflow: requested - placements.length }
  }
  if (mode === 'balanced') {
    balancedMarginX = Math.min(5, (paper.widthMm - Math.max(...ordered.map((item) => item.widthMm))) / 2)
    const marginY = Math.min(5, (paper.heightMm - Math.max(...ordered.map((item) => item.heightMm))) / 2)
    const right = paper.widthMm - balancedMarginX
    const bottom = paper.heightMm - marginY
    const pack = (quantity: number): Placement[] | null => {
      const packed: Placement[] = []
      let xMm = balancedMarginX
      let yMm = marginY
      let rowHeight = 0
      for (const item of ordered) {
        for (let index = 0; index < quantity; index += 1) {
          if (xMm > balancedMarginX && xMm + item.widthMm > right + 0.001) {
            xMm = balancedMarginX
            yMm += rowHeight + gapYmm
            rowHeight = 0
          }
          if (xMm + item.widthMm > right + 0.001 || yMm + item.heightMm > bottom + 0.001) return null
          packed.push({ itemId: item.id, xMm, yMm, widthMm: item.widthMm, heightMm: item.heightMm })
          xMm += item.widthMm + gapXmm
          rowHeight = Math.max(rowHeight, item.heightMm)
        }
      }
      return packed
    }
    const usableArea = (right - balancedMarginX) * (bottom - marginY)
    const itemArea = ordered.reduce((sum, item) => sum + item.widthMm * item.heightMm, 0)
    const maxQuantity = Math.min(Math.floor(1000 / ordered.length), Math.floor(usableArea / itemArea))
    const heightOrdered = [...ordered].sort((a, b) => b.heightMm - a.heightMm || b.widthMm - a.widthMm)
    for (let quantity = maxQuantity; quantity >= 1; quantity -= 1) {
      const packed = pack(quantity)
      if (packed) {
        placements.push(...packed)
        break
      }
      const stacked = packStackedBands(heightOrdered, paper, gapXmm, gapYmm,
        balancedMarginX, marginY, true, !!options.autoGap, quantity)
      if (stacked) return { placements: stacked, overflow: 0 }
    }
    if (!placements.length) {
      const item = ordered[0]
      placements.push({ itemId: item.id, xMm: balancedMarginX, yMm: marginY, widthMm: item.widthMm, heightMm: item.heightMm })
    }
  } else {
    return { placements: packStackedBands(ordered, paper, gapXmm, gapYmm,
      PAPER_MARGIN_MM, PAPER_MARGIN_MM, false, !!options.autoGap)!, overflow: 0 }
  }
  if (placements.length) {
    const rows = new Map<number, Placement[]>()
    for (const placement of placements) {
      const row = rows.get(placement.yMm) ?? []
      row.push(placement)
      rows.set(placement.yMm, row)
    }
    if (options.autoGap) {
      const rowList = [...rows.values()]
      const heights = rowList.map((row) => Math.max(...row.map((placement) => placement.heightMm)))
      const remainingHeight = paper.heightMm - PAPER_MARGIN_MM * 2 - heights.reduce((sum, height) => sum + height, 0)
      let nextY = PAPER_MARGIN_MM
      rowList.forEach((row, rowIndex) => {
        const rowY = rowList.length === 1
          ? (paper.heightMm - heights[0]) / 2
          : remainingHeight >= 0 ? nextY : row[0].yMm
        const remainingWidth = paper.widthMm - PAPER_MARGIN_MM * 2 - row.reduce((sum, placement) => sum + placement.widthMm, 0)
        let nextX = PAPER_MARGIN_MM
        row.forEach((placement, index) => {
          if (row.length === 1) placement.xMm = (paper.widthMm - placement.widthMm) / 2
          else if (remainingWidth >= 0) {
            placement.xMm = nextX
            nextX += placement.widthMm + remainingWidth / (row.length - 1)
          }
          placement.yMm = rowY
        })
        nextY += heights[rowIndex] + (rowList.length > 1 ? remainingHeight / (rowList.length - 1) : 0)
      })
    } else if (mode === 'balanced') {
      for (const row of rows.values()) {
        const remainingWidth = paper.widthMm - 2 * balancedMarginX - row.reduce((sum, placement) => sum + placement.widthMm, 0)
        let nextX = balancedMarginX
        row.forEach((placement) => {
          placement.xMm = row.length === 1 ? (paper.widthMm - placement.widthMm) / 2 : nextX
          nextX += placement.widthMm + remainingWidth / Math.max(1, row.length - 1)
        })
      }
    } else {
      for (const row of rows.values()) {
        const left = Math.min(...row.map((placement) => placement.xMm))
        const right = Math.max(...row.map((placement) => placement.xMm + placement.widthMm))
        const shift = (paper.widthMm - (right - left)) / 2 - left
        row.forEach((placement) => { placement.xMm += shift })
      }
    }
  }
  return { placements, overflow }
}
