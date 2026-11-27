import { describe, expect, it } from 'vitest'
import { calculateLayoutPricing } from './layoutPricing'

const a4 = {
  canvasWidthMm: 293,
  canvasHeightMm: 210,
  patternWidthMm: 30,
  patternHeightMm: 20,
  gapMm: 4,
  marginMm: 4,
  sheetPrice: 5,
}

describe('layout pricing', () => {
  it('deducts both margins and only the gaps between patterns', () => {
    expect(calculateLayoutPricing(a4)).toEqual({
      usableWidthMm: 285,
      usableHeightMm: 202,
      columns: 8,
      rows: 8,
      count: 64,
      unitPrice: 5 / 64,
    })
    expect(calculateLayoutPricing({ ...a4, sheetPrice: 5.05 })).toMatchObject({
      unitPrice: 5.05 / 64,
    })
  })

  it('counts decimal dimensions that fit exactly', () => {
    expect(calculateLayoutPricing({
      canvasWidthMm: 1.2, canvasHeightMm: 1.2,
      patternWidthMm: 0.3, patternHeightMm: 0.3,
      gapMm: 0, marginMm: 0, sheetPrice: 5,
    })).toMatchObject({ columns: 4, rows: 4, count: 16 })
  })

  it('returns no unit price when the pattern does not fit', () => {
    expect(calculateLayoutPricing({ ...a4, patternWidthMm: 286 })).toMatchObject({
      count: 0,
      unitPrice: null,
    })
  })

  it('rejects margins that remove the usable area and negative prices', () => {
    expect(calculateLayoutPricing({ ...a4, marginMm: 105 })).toHaveProperty('error')
    expect(calculateLayoutPricing({ ...a4, sheetPrice: -1 })).toHaveProperty('error')
  })
})
