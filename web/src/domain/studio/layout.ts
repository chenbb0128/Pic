import { imageSizePresets, type ImageSizePreset } from './imageSizeConversion'
import { arrangeSmartItems } from './smartPacking'
import { PAPER_MARGIN_MM } from './paperBounds'
import type { ContourMask } from './contourMask'

export type PaperPreset = ImageSizePreset['value'] | 'custom'
export type Orientation = 'landscape' | 'portrait'
export type LayoutMode = 'balanced' | 'compact' | 'custom' | 'smart'
export type SmartGrouping = 'free' | 'rows' | 'columns'

export interface PaperSize { widthMm: number; heightMm: number }
export interface LayoutItem {
  id: string
  widthMm: number
  heightMm: number
  quantity: number
  selected: boolean
  important?: boolean
  contour?: ContourMask
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
  const requested = mode === 'custom' ? options.items.reduce((sum, item) => sum + (item.selected && Number.isFinite(item.quantity)
    ? Math.min(500, Math.max(0, Math.floor(item.quantity))) : 0), 0) : 0
  const right = paper.widthMm - PAPER_MARGIN_MM
  const bottom = paper.heightMm - PAPER_MARGIN_MM
  const items = options.items.filter((item) =>
    item.selected && item.widthMm > 0 && item.heightMm > 0 &&
    item.widthMm <= paper.widthMm - PAPER_MARGIN_MM * 2 && item.heightMm <= paper.heightMm - PAPER_MARGIN_MM * 2,
  )
  if (!items.length || paper.widthMm <= 0 || paper.heightMm <= 0) return { placements: [], overflow: requested }

  const ordered = mode === 'compact'
    ? [...items].sort((a, b) => b.widthMm * b.heightMm - a.widthMm * a.heightMm)
    : mode === 'balanced' ? [...items].sort((a, b) => a.widthMm - b.widthMm)
    : [...items].sort((a, b) => Number(!!b.important) - Number(!!a.important))
  const queue = mode === 'custom'
    ? ordered.flatMap((item) => Array.from({ length: Math.min(500, Math.max(0, Math.floor(item.quantity))) }, () => item))
    : mode === 'compact' ? Array.from({ length: 1000 }, (_, index) => ordered[index % ordered.length]) : []

  const placements: Placement[] = []
  let overflow = 0
  let balancedMarginX = 0
  if (mode === 'custom') {
    // Keep a row's tall patterns and its stacked small columns as one band.
    // Center/spread columns together, not each distinct y coordinate independently.
    interface Column { xMm: number; widthMm: number; slots: Placement[] }
    interface Band { yMm: number; heightMm: number; columns: Column[] }
    const bands: Band[] = []
    for (const item of queue) {
      let band = bands[bands.length - 1]
      const column = band?.columns[band.columns.length - 1]
      const last = column?.slots[column.slots.length - 1]
      const stackY = last ? last.yMm + last.heightMm + gapYmm : 0
      if (band && column && last?.itemId === item.id && stackY + item.heightMm <= band.yMm + band.heightMm + 0.001) {
        const slot = { itemId: item.id, xMm: column.xMm, yMm: stackY, widthMm: item.widthMm, heightMm: item.heightMm }
        column.slots.push(slot)
        placements.push(slot)
        continue
      }
      let xMm = column ? column.xMm + column.widthMm + gapXmm : PAPER_MARGIN_MM
      let yMm = band?.yMm ?? PAPER_MARGIN_MM
      const newBand = !band || xMm + item.widthMm > right + 0.001
      if (newBand && band) { xMm = PAPER_MARGIN_MM; yMm += band.heightMm + gapYmm }
      // Don't advance the cursor on failure: a later, smaller pattern may still fit.
      if (yMm + item.heightMm > bottom + 0.001) continue
      if (newBand) {
        band = { yMm, heightMm: 0, columns: [] }
        bands.push(band)
      }
      band!.heightMm = Math.max(band!.heightMm, item.heightMm)
      const slot = { itemId: item.id, xMm, yMm, widthMm: item.widthMm, heightMm: item.heightMm }
      band!.columns.push({ xMm, widthMm: item.widthMm, slots: [slot] })
      placements.push(slot)
    }
    const remainingHeight = paper.heightMm - PAPER_MARGIN_MM * 2 - bands.reduce((sum, band) => sum + band.heightMm, 0)
    let nextY = PAPER_MARGIN_MM
    for (const band of bands) {
      const bandY = options.autoGap ? bands.length === 1 ? (paper.heightMm - band.heightMm) / 2 : nextY : band.yMm
      const usedWidth = band.columns.reduce((sum, column) => sum + column.widthMm, 0)
      const bandWidth = usedWidth + gapXmm * (band.columns.length - 1)
      const columnGap = options.autoGap && band.columns.length > 1
        ? (paper.widthMm - PAPER_MARGIN_MM * 2 - usedWidth) / (band.columns.length - 1) : gapXmm
      let nextX = options.autoGap && band.columns.length > 1 ? PAPER_MARGIN_MM : (paper.widthMm - bandWidth) / 2
      for (const column of band.columns) {
        for (const slot of column.slots) { slot.xMm += nextX - column.xMm; slot.yMm += bandY - band.yMm }
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
    for (let quantity = maxQuantity; quantity >= 1; quantity -= 1) {
      const packed = pack(quantity)
      if (packed) {
        placements.push(...packed)
        break
      }
    }
    if (!placements.length) {
      const item = ordered[0]
      placements.push({ itemId: item.id, xMm: balancedMarginX, yMm: marginY, widthMm: item.widthMm, heightMm: item.heightMm })
    }
  } else {
    let xMm = PAPER_MARGIN_MM
    let yMm = PAPER_MARGIN_MM
    let rowHeight = 0
    let failedInARow = 0
    for (const item of queue) {
      if (xMm + item.widthMm > right + 0.001) {
        xMm = PAPER_MARGIN_MM
        yMm += rowHeight + gapYmm
        rowHeight = 0
      }
      if (yMm + item.heightMm > bottom + 0.001) {
        failedInARow += 1
        if (failedInARow >= ordered.length) break
        continue
      }
      placements.push({ itemId: item.id, xMm, yMm, widthMm: item.widthMm, heightMm: item.heightMm })
      xMm += item.widthMm + gapXmm
      rowHeight = Math.max(rowHeight, item.heightMm)
      failedInARow = 0
    }
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
