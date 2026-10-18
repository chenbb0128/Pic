import { describe, expect, it } from 'vitest'
import { findSpacingConflict, normalizePatternGap } from './patternSpacing'
import type { Placement } from './layout'

const slot = (xMm: number, yMm = 4): Placement => ({ itemId: String(xMm), xMm, yMm, widthMm: 10, heightMm: 10 })

describe('minimum pattern spacing', () => {
  it('normalizes configured gaps to whole millimeters from 0 to 30, falling back to 4', () => {
    expect([0, -2, 1, 3.9, 4, 4.6, 31, NaN, Infinity].map(normalizePatternGap)).toEqual([0, 0, 1, 4, 4, 5, 30, 4, 4])
  })

  it('allows zero and sub-4mm horizontal and vertical gaps but rejects overlaps', () => {
    expect(findSpacingConflict([slot(4), slot(18)])).toBeNull()
    expect(findSpacingConflict([slot(4), slot(17.99)])).toBeNull()
    expect(findSpacingConflict([slot(4), slot(14)])).toBeNull()
    expect(findSpacingConflict([slot(4), slot(13.99)])).toEqual([0, 1])
    expect(findSpacingConflict([slot(4), slot(4, 18)])).toBeNull()
    expect(findSpacingConflict([slot(4), slot(4, 17)])).toBeNull()
    expect(findSpacingConflict([slot(4), slot(4, 14)])).toBeNull()
    expect(findSpacingConflict([slot(4), slot(4, 13.99)])).toEqual([0, 1])
    expect(findSpacingConflict([slot(4), slot(5)])).toEqual([0, 1])
    expect(findSpacingConflict([slot(4), slot(4, 5), slot(40)], undefined, new Set([2]))).toBeNull()
  })

  it('preserves transparent interlocking with touching silhouette edges but rejects overlaps', () => {
    const shapes = (p: Placement) => ({ width: 20, rows: Array.from({ length: 20 }, () => p.itemId === '4' ? [0, 2] as [number, number] : [10, 12] as [number, number]) })
    expect(findSpacingConflict([slot(4), { ...slot(4), itemId: 'other' }], shapes)).toBeNull()
    const tooClose = () => ({ width: 20, rows: Array.from({ length: 20 }, () => [0, 2] as [number, number]) })
    expect(findSpacingConflict([slot(4), slot(4.9)], tooClose)).toEqual([0, 1])
    expect(findSpacingConflict([slot(4), slot(5)], tooClose)).toBeNull()
  })
})
