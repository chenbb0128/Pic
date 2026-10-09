import type { PaperSize } from './layout'

export const DIRECT_CANVAS_MAX_PIXELS = 40_000_000
const MAX_EXPORT_PIXELS = 100_000_000

export function exportSize(paper: PaperSize, dpi: number): { width: number; height: number; allowed: boolean } {
  const width = Math.round(paper.widthMm / 25.4 * dpi)
  const height = Math.round(paper.heightMm / 25.4 * dpi)
  return { width, height, allowed: width > 0 && height > 0 && width * height <= MAX_EXPORT_PIXELS }
}
