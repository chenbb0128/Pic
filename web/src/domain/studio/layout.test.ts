import { describe, expect, it } from 'vitest'
import { arrangeItems, horizontalPaperSize, orientedPaperSize, paperSize } from './layout'

describe('paperSize', () => {
  it('uses the reference site sheet dimensions and rotates them for portrait', () => {
    expect(paperSize('A4', 'landscape')).toEqual({ widthMm: 297, heightMm: 210 })
    expect(paperSize('A4', 'portrait')).toEqual({ widthMm: 210, heightMm: 297 })
    expect(paperSize('A5', 'landscape')).toEqual({ widthMm: 210, heightMm: 148 })
    expect(paperSize('A6', 'landscape')).toEqual({ widthMm: 148, heightMm: 105 })
  })
})

describe('horizontalPaperSize', () => {
  it('keeps both preset and reversed custom paper horizontal', () => {
    expect(horizontalPaperSize('A4', 100, 200)).toEqual({ widthMm: 297, heightMm: 210 })
    expect(horizontalPaperSize('custom', 100, 200)).toEqual({ widthMm: 200, heightMm: 100 })
  })
})

describe('orientedPaperSize', () => {
  it('rotates preset and custom sheets into portrait dimensions', () => {
    expect(orientedPaperSize('A4', 'portrait', 297, 210)).toEqual({ widthMm: 210, heightMm: 297 })
    expect(orientedPaperSize('custom', 'portrait', 297, 210)).toEqual({ widthMm: 210, heightMm: 297 })
    expect(orientedPaperSize('custom', 'portrait', 100, 200)).toEqual({ widthMm: 100, heightMm: 200 })
    expect(orientedPaperSize('custom', 'landscape', 100, 200)).toEqual({ widthMm: 200, heightMm: 100 })
  })
})

describe('arrangeItems', () => {
  it('honors custom quantities without placing anything outside the sheet', () => {
    const result = arrangeItems({
      paper: { widthMm: 50, heightMm: 25 },
      gapMm: 5,
      mode: 'custom',
      items: [{ id: 'flower', widthMm: 20, heightMm: 20, quantity: 3, selected: true }],
    })

    expect(result.placements.map(({ xMm, yMm }) => [xMm, yMm])).toEqual([[2.5, 0], [27.5, 0]])
    expect(result.overflow).toBe(1)
  })

  it('balances two image counts while continuing into the same row', () => {
    const result = arrangeItems({
      paper: { widthMm: 297, heightMm: 210 },
      gapXmm: 5,
      gapYmm: 5,
      mode: 'balanced',
      items: [
        { id: 'head', widthMm: 50, heightMm: 50, quantity: 1, selected: true },
        { id: 'dog', widthMm: 38, heightMm: 50, quantity: 1, selected: true },
      ],
    })

    const rows = new Map<number, string[]>()
    for (const placement of result.placements) {
      rows.set(placement.yMm, [...(rows.get(placement.yMm) ?? []), placement.itemId])
    }
    expect([...rows]).toEqual([
      [5, ['dog', 'dog', 'dog', 'dog', 'dog', 'dog']],
      [60, ['dog', 'dog', 'head', 'head', 'head']],
      [115, ['head', 'head', 'head', 'head', 'head']],
    ])
    expect(result.placements).toHaveLength(16)
    expect(result.placements[0].xMm).toBe(5)
    expect(result.placements[1].xMm).toBeCloseTo(54.8)
    expect(result.placements[5].xMm + result.placements[5].widthMm).toBe(292)
    expect(result.placements[6].xMm).toBe(5)
    expect(result.placements[10].xMm + result.placements[10].widthMm).toBe(292)
    expect(result.overflow).toBe(0)
  })

  it('uses different horizontal and vertical gaps', () => {
    const result = arrangeItems({
      paper: { widthMm: 25, heightMm: 25 },
      gapXmm: 5,
      gapYmm: 2,
      mode: 'custom',
      items: [{ id: 'a', widthMm: 10, heightMm: 10, quantity: 3, selected: true }],
    })
    expect(result.placements.map(({ xMm, yMm }) => [xMm, yMm])).toEqual([[0, 0], [15, 0], [7.5, 12]])
  })

  it('centers each row on the A4 sheet without changing sticker gaps', () => {
    const result = arrangeItems({
      paper: { widthMm: 297, heightMm: 210 },
      gapXmm: 5,
      gapYmm: 2,
      mode: 'custom',
      items: [{ id: 'a', widthMm: 50, heightMm: 50, quantity: 12, selected: true }],
    })
    expect(result.placements.slice(0, 5).map(({ xMm, yMm }) => [xMm, yMm])).toEqual([
      [13.5, 0], [68.5, 0], [123.5, 0], [178.5, 0], [233.5, 0],
    ])
    expect(result.placements.slice(-2).map(({ xMm, yMm }) => [xMm, yMm])).toEqual([[96, 104], [151, 104]])
  })

  it('automatically spreads a row across the sheet', () => {
    const result = arrangeItems({
      paper: { widthMm: 100, heightMm: 50 },
      gapXmm: 2,
      gapYmm: 2,
      autoGap: true,
      mode: 'custom',
      items: [{ id: 'a', widthMm: 10, heightMm: 10, quantity: 2, selected: true }],
    })
    expect(result.placements.map(({ xMm, yMm }) => [xMm, yMm])).toEqual([[5, 20], [85, 20]])
  })
})
