import type { PaperSize, Placement } from './layout'
import { clampPaperPosition, PAPER_MARGIN_MM } from './paperBounds'
import { findSpacingConflict, type PlacementContour } from './patternSpacing'

interface PointMm { xMm: number; yMm: number }

export function selectPlacementsInBox(placements: Placement[], start: PointMm, end: PointMm, lockedCount = 0): number[] {
  const left = Math.min(start.xMm, end.xMm)
  const right = Math.max(start.xMm, end.xMm)
  const top = Math.min(start.yMm, end.yMm)
  const bottom = Math.max(start.yMm, end.yMm)
  return placements.flatMap((slot, index) => index >= lockedCount && slot.xMm >= left && slot.yMm >= top &&
    slot.xMm + slot.widthMm <= right && slot.yMm + slot.heightMm <= bottom ? [index] : [])
}

export function distributePlacements(placements: Placement[], indices: number[], axis: 'x' | 'y', paper: PaperSize, lockedCount = 0, contourFor?: PlacementContour): Placement[] {
  const selected = [...new Set(indices)]
  if (selected.some(index => !Number.isInteger(index) || !placements[index])) throw new Error('选区已变化，请重新框选图片。')
  if (selected.some(index => index < lockedCount)) throw new Error('锁定组需先解锁后再进行等间距排列。')
  if (selected.length < 3) throw new Error('请至少框选 3 张图片。')
  const position = axis === 'x' ? 'xMm' : 'yMm'
  const size = axis === 'x' ? 'widthMm' : 'heightMm'
  const crossPosition = axis === 'x' ? 'yMm' : 'xMm'
  const crossSize = axis === 'x' ? 'heightMm' : 'widthMm'
  selected.sort((a, b) => placements[a]![position] - placements[b]![position] || a - b)
  const slots = selected.map(index => placements[index]!)
  const start = Math.min(...slots.map(slot => slot[position]))
  const end = Math.max(...slots.map(slot => slot[position] + slot[size]))
  const gap = (end - start - slots.reduce((sum, slot) => sum + slot[size], 0)) / (slots.length - 1)
  if (gap < -1e-6) throw new Error('当前选区空间不足，请先拉开首尾图片的位置。')
  const center = (Math.min(...slots.map(slot => slot[crossPosition])) + Math.max(...slots.map(slot => slot[crossPosition] + slot[crossSize]))) / 2
  const result = [...placements]
  let cursor = start
  for (const index of selected) {
    const slot = placements[index]!
    result[index] = { ...slot, [position]: cursor, [crossPosition]: center - slot[crossSize] / 2 }
    cursor += slot[size] + Math.max(0, gap)
  }
  const selectedSet = new Set(selected)
  for (const index of selected) {
    const slot = result[index]!
    if (slot.xMm < PAPER_MARGIN_MM - 1e-6 || slot.yMm < PAPER_MARGIN_MM - 1e-6 ||
      slot.xMm + slot.widthMm > paper.widthMm - PAPER_MARGIN_MM + 1e-6 ||
      slot.yMm + slot.heightMm > paper.heightMm - PAPER_MARGIN_MM + 1e-6) throw new Error('排列后会超出 4mm 留边，请调整选区。')
  }
  if (findSpacingConflict(result, contourFor, selectedSet)) throw new Error('排列后会与其他图案重叠，请先调整位置。')
  return result
}

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
