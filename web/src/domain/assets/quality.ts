import type { StickerType } from '../layout/types'
import type { QualityLevel, QualityResult } from './types'

export interface QualityInput {
  width: number
  height: number
  type: StickerType
}

export interface QualitySummary {
  total: number
  clear: number
  usable: number
  warning: number
  insufficient: number
  level: QualityLevel | 'empty'
  label: string
}

export function requiredPixels(type: StickerType, dpi: number): number {
  const mm = type === '2cm' ? 20 : 30
  return Math.round((mm / 25.4) * dpi)
}

export function assessQuality(width: number, height: number, type: StickerType, dpi: number): QualityResult {
  const requiredPx = requiredPixels(type, dpi)
  const shortestEdge = Math.min(width, height)
  const ratio = shortestEdge / requiredPx
  let level: QualityLevel
  let label: string

  if (ratio >= 1.5) {
    level = 'clear'
    label = '清晰 ✓'
  } else if (ratio >= 1) {
    level = 'usable'
    label = '够用 ✓'
  } else if (ratio >= 0.75) {
    level = 'warning'
    label = '一般 △'
  } else {
    level = 'insufficient'
    label = '不足 ⚠'
  }

  return { level, label, requiredPx, shortestEdge, ratio }
}

export function summarizeQuality(items: QualityInput[], dpi: number): QualitySummary {
  const counts = { clear: 0, usable: 0, warning: 0, insufficient: 0 }
  items.forEach((item) => {
    counts[assessQuality(item.width, item.height, item.type, dpi).level] += 1
  })
  const level: QualitySummary['level'] = counts.insufficient
    ? 'insufficient'
    : counts.warning
      ? 'warning'
      : counts.usable
        ? 'usable'
        : counts.clear
          ? 'clear'
          : 'empty'
  const label = level === 'empty' ? '暂无素材' : level === 'insufficient' ? '存在清晰度不足素材' : level === 'warning' ? '存在清晰度一般素材' : '全部素材满足建议清晰度'
  return { total: items.length, ...counts, level, label }
}
