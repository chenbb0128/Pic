export type LayoutMode = 'mixed' | 'full2' | 'full3'
export type StickerType = '2cm' | '3cm'

export interface LayoutConfig {
  mode: LayoutMode
  rows2: number
  rows3: number
}

export interface StickerSlot {
  index: number
  xMm: number
  yMm: number
  sizeMm: number
  type: StickerType
}

export interface LayoutResult {
  valid: boolean
  slots2: StickerSlot[]
  slots3: StickerSlot[]
  gapY: number
  error?: string
}
