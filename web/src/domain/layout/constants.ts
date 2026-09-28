import type { StickerType } from './types'

export const ARTBOARD_MM = { width: 293, height: 210 } as const
export const PREVIEW_SIZE = { width: 1172, height: 840 } as const

export const STICKER = {
  '2cm': { sizeMm: 20, columns: 12, maxRows: 10 },
  '3cm': { sizeMm: 30, columns: 8, maxRows: 7 },
} satisfies Record<StickerType, { sizeMm: number; columns: number; maxRows: number }>

export const DEFAULT_LAYOUT = { mode: 'mixed', rows2: 4, rows3: 3 } as const
export const DPI_OPTIONS = [300, 600] as const

export function horizontalGap(type: StickerType): number {
  const { sizeMm, columns } = STICKER[type]
  return (ARTBOARD_MM.width - columns * sizeMm) / (columns - 1)
}
