import type { PaperSize, Placement } from './layout'

export function resizePlacement(placements: Placement[], index: number, widthMm: number, paper: PaperSize): Placement[] {
  const selected = placements[index]
  if (!selected) throw new Error('请先选择一张图片。')
  if (!Number.isFinite(widthMm) || widthMm <= 0 || selected.widthMm <= 0 || selected.heightMm <= 0) {
    throw new Error('请输入有效尺寸。')
  }

  const width = Math.min(widthMm, paper.widthMm, selected.widthMm * paper.heightMm / selected.heightMm)
  const height = selected.heightMm * width / selected.widthMm
  const centerX = selected.xMm + selected.widthMm / 2
  const centerY = selected.yMm + selected.heightMm / 2
  return placements.map((placement, placementIndex) => placementIndex === index ? {
    ...placement,
    xMm: Math.max(0, Math.min(paper.widthMm - width, centerX - width / 2)),
    yMm: Math.max(0, Math.min(paper.heightMm - height, centerY - height / 2)),
    widthMm: width,
    heightMm: height,
  } : placement)
}
