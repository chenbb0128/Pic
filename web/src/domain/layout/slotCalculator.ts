import { ARTBOARD_MM, STICKER, horizontalGap } from './constants'
import type { LayoutConfig, LayoutResult, StickerSlot, StickerType } from './types'

export { ARTBOARD_MM }
export type { LayoutConfig }

function makeSlots(
  type: StickerType,
  rows: number,
  startY: number,
  gapY: number,
): StickerSlot[] {
  const { sizeMm, columns } = STICKER[type]
  const gapX = horizontalGap(type)
  const slots: StickerSlot[] = []

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      slots.push({
        index: row * columns + column,
        xMm: column * (sizeMm + gapX),
        yMm: startY + row * (sizeMm + gapY),
        sizeMm,
        type,
      })
    }
  }

  return slots
}

function invalid(error: string): LayoutResult {
  return { valid: false, slots2: [], slots3: [], gapY: 0, error }
}

function validRows(type: StickerType, rows: number): boolean {
  return Number.isInteger(rows) && rows >= 1 && rows <= STICKER[type].maxRows
}

export function calculateSlots(config: LayoutConfig): LayoutResult {
  if (!validRows('2cm', config.rows2) || !validRows('3cm', config.rows3)) {
    return invalid('行数必须是有效的正整数。')
  }

  if (config.mode === 'mixed') {
    const totalHeight = config.rows2 * STICKER['2cm'].sizeMm + config.rows3 * STICKER['3cm'].sizeMm
    const gaps = config.rows2 + config.rows3 - 1
    const gapY = (ARTBOARD_MM.height - totalHeight) / gaps
    if (gapY < 0) return invalid('当前行数组合无法放入 293×210mm 画板，请减少行数。')

    const slots2 = makeSlots('2cm', config.rows2, 0, gapY)
    const startY3 = config.rows2 * STICKER['2cm'].sizeMm + config.rows2 * gapY
    const slots3 = makeSlots('3cm', config.rows3, startY3, gapY)
    return { valid: true, slots2, slots3, gapY }
  }

  const type: StickerType = config.mode === 'full2' ? '2cm' : '3cm'
  const rows = type === '2cm' ? config.rows2 : config.rows3
  const totalHeight = rows * STICKER[type].sizeMm
  const gapY = rows > 1 ? (ARTBOARD_MM.height - totalHeight) / (rows - 1) : 0
  if (gapY < 0) return invalid('当前行数无法放入 293×210mm 画板，请减少行数。')

  return {
    valid: true,
    slots2: type === '2cm' ? makeSlots(type, rows, 0, gapY) : [],
    slots3: type === '3cm' ? makeSlots(type, rows, 0, gapY) : [],
    gapY,
  }
}

export function getLayoutCount(result: Pick<LayoutResult, 'slots2' | 'slots3'>) {
  return { count2: result.slots2.length, count3: result.slots3.length }
}
