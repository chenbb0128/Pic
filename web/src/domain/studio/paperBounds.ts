export const PAPER_MARGIN_MM = 4

export function clampPaperPosition(positionMm: number, sizeMm: number, paperEdgeMm: number): number {
  return Math.max(PAPER_MARGIN_MM, Math.min(paperEdgeMm - PAPER_MARGIN_MM - sizeMm, positionMm))
}
