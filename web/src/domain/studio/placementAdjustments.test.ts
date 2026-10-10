import { describe, expect, it } from 'vitest'
import { resizePlacement } from './placementAdjustments'
import type { Placement } from './layout'

describe('resizePlacement', () => {
  it('resizes only the selected copy around its center', () => {
    const placements: Placement[] = [
      { itemId: 'snake', xMm: 10, yMm: 10, widthMm: 40, heightMm: 20 },
      { itemId: 'snake', xMm: 60, yMm: 10, widthMm: 40, heightMm: 20 },
    ]

    const result = resizePlacement(placements, 1, 20, { widthMm: 100, heightMm: 50 })

    expect(result[0]).toEqual({ itemId: 'snake', xMm: 10, yMm: 10, widthMm: 40, heightMm: 20 })
    expect(result[1]).toEqual({ itemId: 'snake', xMm: 70, yMm: 15, widthMm: 20, heightMm: 10 })
    expect(placements[1]).toEqual({ itemId: 'snake', xMm: 60, yMm: 10, widthMm: 40, heightMm: 20 })
  })

  it('keeps enlarged copies inside the paper without changing their aspect ratio', () => {
    const placements: Placement[] = [{ itemId: 'snake', xMm: 80, yMm: 30, widthMm: 20, heightMm: 10 }]

    expect(resizePlacement(placements, 0, 200, { widthMm: 100, heightMm: 50 })).toEqual([
      { itemId: 'snake', xMm: 0, yMm: 0, widthMm: 100, heightMm: 50 },
    ])
  })

  it('rejects a non-positive width', () => {
    const placements: Placement[] = [{ itemId: 'snake', xMm: 0, yMm: 0, widthMm: 20, heightMm: 10 }]
    expect(() => resizePlacement(placements, 0, 0, { widthMm: 100, heightMm: 50 })).toThrow('有效尺寸')
  })
})
