import type { StickerType } from '../layout/types'

export type QualityLevel = 'clear' | 'usable' | 'warning' | 'insufficient'

export interface AssetRecord {
  id: string
  name: string
  type: StickerType
  mime: 'image/png' | 'image/webp' | 'image/jpeg'
  width: number
  height: number
  url: string
  image: HTMLImageElement
}

export interface QualityResult {
  level: QualityLevel
  label: string
  requiredPx: number
  shortestEdge: number
  ratio: number
}
