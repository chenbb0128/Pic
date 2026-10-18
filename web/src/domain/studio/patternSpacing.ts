import { CONTOUR_CELL_MM, type ContourMask } from './contourMask'
import type { Placement } from './layout'

export const DEFAULT_PATTERN_GAP_MM = 4
export const MIN_PATTERN_GAP_MM = 0
export type PlacementContour = (placement: Placement) => ContourMask | undefined
const EPSILON = 1e-6

export function normalizePatternGap(value: number): number {
  return Number.isFinite(value) ? Math.min(30, Math.max(MIN_PATTERN_GAP_MM, Math.round(value))) : DEFAULT_PATTERN_GAP_MM
}

function rectanglesTooClose(a: Placement, b: Placement): boolean {
  return a.xMm < b.xMm + b.widthMm + MIN_PATTERN_GAP_MM - EPSILON &&
    a.xMm + a.widthMm + MIN_PATTERN_GAP_MM > b.xMm + EPSILON &&
    a.yMm < b.yMm + b.heightMm + MIN_PATTERN_GAP_MM - EPSILON &&
    a.yMm + a.heightMm + MIN_PATTERN_GAP_MM > b.yMm + EPSILON
}

// The existing contour projection uses conservative 0.5mm row spans. Check
// those occupied spans, not transparent bounding boxes, without reading pixels here.
function occupiedRows(slot: Placement, mask?: ContourMask): Placement[] {
  if (!mask) return [slot]
  return mask.rows.flatMap((row, index) => {
    if (!row || index * CONTOUR_CELL_MM >= slot.heightMm) return []
    const left = row[0] * CONTOUR_CELL_MM
    const right = Math.min(slot.widthMm, row[1] * CONTOUR_CELL_MM)
    return right <= left ? [] : [{ ...slot, xMm: slot.xMm + left, yMm: slot.yMm + index * CONTOUR_CELL_MM,
      widthMm: right - left, heightMm: Math.min(CONTOUR_CELL_MM, slot.heightMm - index * CONTOUR_CELL_MM) }]
  })
}

export function findSpacingConflict(placements: Placement[], contourFor?: PlacementContour, changed?: ReadonlySet<number>): [number, number] | null {
  const ordered = placements.map((slot, index) => ({ slot, index })).sort((a, b) => a.slot.xMm - b.slot.xMm)
  const rows = new Map<number, Placement[]>()
  const spans = (index: number) => {
    if (!rows.has(index)) rows.set(index, occupiedRows(placements[index]!, contourFor?.(placements[index]!)))
    return rows.get(index)!
  }
  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i]!
    for (let j = i + 1; j < ordered.length; j += 1) {
      const b = ordered[j]!
      if (b.slot.xMm >= a.slot.xMm + a.slot.widthMm + MIN_PATTERN_GAP_MM - EPSILON) break
      if (changed && !changed.has(a.index) && !changed.has(b.index)) continue
      if (!rectanglesTooClose(a.slot, b.slot)) continue
      const first = spans(a.index)
      const second = spans(b.index)
      let start = 0
      for (const row of first) {
        while (start < second.length && second[start]!.yMm + second[start]!.heightMm + MIN_PATTERN_GAP_MM <= row.yMm + EPSILON) start += 1
        for (let k = start; k < second.length && second[k]!.yMm < row.yMm + row.heightMm + MIN_PATTERN_GAP_MM - EPSILON; k += 1) {
          if (rectanglesTooClose(row, second[k]!)) return [a.index, b.index]
        }
      }
    }
  }
  return null
}
