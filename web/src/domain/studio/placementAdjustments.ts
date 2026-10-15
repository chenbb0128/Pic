import type { PaperSize, Placement } from './layout'
import { clampPaperPosition, PAPER_MARGIN_MM } from './paperBounds'

export function resizePlacement(placements: Placement[], index: number, widthMm: number, paper: PaperSize): Placement[] {
  const selected = placements[index]
  if (!selected) throw new Error('请先选择一张图片。')
  if (!Number.isFinite(widthMm) || widthMm <= 0 || selected.widthMm <= 0 || selected.heightMm <= 0) {
    throw new Error('请输入有效尺寸。')
  }

  const width = Math.min(widthMm, paper.widthMm - PAPER_MARGIN_MM * 2, selected.widthMm * (paper.heightMm - PAPER_MARGIN_MM * 2) / selected.heightMm)
  if (width <= 0) throw new Error('纸张尺寸不足以保留 4mm 留边。')
  const height = selected.heightMm * width / selected.widthMm
  const centerX = selected.xMm + selected.widthMm / 2
  const centerY = selected.yMm + selected.heightMm / 2
  return placements.map((placement, placementIndex) => placementIndex === index ? {
    ...placement,
    xMm: clampPaperPosition(centerX - width / 2, width, paper.widthMm),
    yMm: clampPaperPosition(centerY - height / 2, height, paper.heightMm),
    widthMm: width,
    heightMm: height,
  } : placement)
}
