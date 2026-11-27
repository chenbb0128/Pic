export interface LayoutPricingInput {
  canvasWidthMm: number
  canvasHeightMm: number
  patternWidthMm: number
  patternHeightMm: number
  gapMm: number
  marginMm: number
  sheetPrice: number
}

export function calculateLayoutPricing(input: LayoutPricingInput) {
  const { canvasWidthMm, canvasHeightMm, patternWidthMm, patternHeightMm, gapMm, marginMm, sheetPrice } = input
  const sizes = [canvasWidthMm, canvasHeightMm, patternWidthMm, patternHeightMm]
  if (sizes.some(size => !Number.isFinite(size) || size <= 0)) {
    return { error: '请输入大于 0 的画布和图案尺寸。' } as const
  }
  if ([gapMm, marginMm, sheetPrice].some(value => !Number.isFinite(value) || value < 0)) {
    return { error: '间隔、边距和单张费用必须为非负数。' } as const
  }

  // Use tenths of a millimetre so exact fits stay exact when calculating columns and rows.
  const dimensions = [...sizes, gapMm, marginMm]
  const ticks = dimensions.map(value => Math.round(value * 10))
  if (ticks.some((value, index) => !Number.isSafeInteger(value) || value / 10 !== dimensions[index])) {
    return { error: '尺寸、间隔和边距最多保留一位小数。' } as const
  }
  const [width, height, patternWidth, patternHeight, gap, margin] = ticks
  const usableWidth = width - 2 * margin
  const usableHeight = height - 2 * margin
  if (usableWidth <= 0 || usableHeight <= 0) {
    return { error: '边缘留白过大，请减小边距。' } as const
  }

  const columns = Math.floor((usableWidth + gap) / (patternWidth + gap))
  const rows = Math.floor((usableHeight + gap) / (patternHeight + gap))
  const count = columns * rows
  if (!Number.isSafeInteger(count)) return { error: '计算数量超出范围，请检查尺寸。' } as const

  return {
    columns,
    rows,
    count,
    usableWidthMm: usableWidth / 10,
    usableHeightMm: usableHeight / 10,
    unitPrice: count > 0 ? sheetPrice / count : null,
  }
}
