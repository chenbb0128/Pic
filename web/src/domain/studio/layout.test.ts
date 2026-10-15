import { describe, expect, it } from 'vitest'
import { arrangeItems, horizontalPaperSize, orientedPaperSize, paperSize } from './layout'

describe('paperSize', () => {
  it('uses the requested printable dimensions and rotates them for portrait', () => {
    expect(paperSize('A3', 'landscape')).toEqual({ widthMm: 420, heightMm: 293 })
    expect(paperSize('A3', 'portrait')).toEqual({ widthMm: 293, heightMm: 420 })
    expect(paperSize('A4', 'landscape')).toEqual({ widthMm: 293, heightMm: 210 })
    expect(paperSize('A4', 'portrait')).toEqual({ widthMm: 210, heightMm: 293 })
    expect(paperSize('A5', 'landscape')).toEqual({ widthMm: 210, heightMm: 144 })
    expect(paperSize('A5', 'portrait')).toEqual({ widthMm: 144, heightMm: 210 })
    expect(paperSize('A6', 'landscape')).toEqual({ widthMm: 144, heightMm: 105 })
    expect(paperSize('A6', 'portrait')).toEqual({ widthMm: 105, heightMm: 144 })
    expect(paperSize('A7', 'landscape')).toEqual({ widthMm: 105, heightMm: 75 })
    expect(paperSize('A7', 'portrait')).toEqual({ widthMm: 75, heightMm: 105 })
  })
})

describe('horizontalPaperSize', () => {
  it('keeps both preset and reversed custom paper horizontal', () => {
    expect(horizontalPaperSize('A4', 100, 200)).toEqual({ widthMm: 293, heightMm: 210 })
    expect(horizontalPaperSize('custom', 100, 200)).toEqual({ widthMm: 200, heightMm: 100 })
  })
})

describe('orientedPaperSize', () => {
  it('rotates preset and custom sheets into portrait dimensions', () => {
    expect(orientedPaperSize('A4', 'portrait', 297, 210)).toEqual({ widthMm: 210, heightMm: 293 })
    expect(orientedPaperSize('custom', 'portrait', 297, 210)).toEqual({ widthMm: 210, heightMm: 297 })
    expect(orientedPaperSize('custom', 'portrait', 100, 200)).toEqual({ widthMm: 100, heightMm: 200 })
    expect(orientedPaperSize('custom', 'landscape', 100, 200)).toEqual({ widthMm: 200, heightMm: 100 })
  })
})

describe('arrangeItems', () => {
  it.each([false, true])('stacks small patterns beside a tall one without overlap (autoGap=%s)', (autoGap) => {
    const result = arrangeItems({
      paper: { widthMm: 108, heightMm: 58 }, mode: 'custom', gapXmm: 4, gapYmm: 4, autoGap,
      items: [
        { id: 'B', widthMm: 10, heightMm: 10, quantity: 9, selected: true },
        { id: 'A', widthMm: 50, heightMm: 50, quantity: 1, selected: true, important: true },
      ],
    })
    expect(result.placements).toHaveLength(10)
    expect(result.overflow).toBe(0)
    expect(result.placements[0].itemId).toBe('A')
    const small = result.placements.filter(p => p.itemId === 'B')
    expect(new Set(small.map(p => p.xMm)).size).toBe(3)
    expect(small.slice(0, 3).every(p => p.xMm === small[0].xMm)).toBe(true)
    expect(small[0].yMm).toBe(4)
    expect(small[1].yMm).toBe(autoGap ? 19 : 18)
    expect(small[2].yMm).toBe(autoGap ? 34 : 32)
    const gap = autoGap ? 5 : 4
    for (const [i, p] of result.placements.entries()) {
      expect(p.xMm).toBeGreaterThanOrEqual(4)
      expect(p.yMm).toBeGreaterThanOrEqual(4)
      expect(p.xMm + p.widthMm).toBeLessThanOrEqual(104)
      expect(p.yMm + p.heightMm).toBeLessThanOrEqual(54)
      for (const q of result.placements.slice(i + 1)) {
        expect(p.xMm + p.widthMm + gap <= q.xMm + 0.001 || q.xMm + q.widthMm + gap <= p.xMm + 0.001 ||
          p.yMm + p.heightMm + gap <= q.yMm + 0.001 || q.yMm + q.heightMm + gap <= p.yMm + 0.001).toBe(true)
      }
    }
  })

  it('fills the last tall row with small columns before starting another row', () => {
    const result = arrangeItems({
      paper: { widthMm: 210, heightMm: 112 }, mode: 'custom', gapXmm: 4, gapYmm: 4,
      items: [
        { id: 'A', widthMm: 50, heightMm: 50, quantity: 5, selected: true },
        { id: 'B', widthMm: 10, heightMm: 10, quantity: 20, selected: true },
      ],
    })
    expect(result.overflow).toBe(0)
    expect(result.placements).toHaveLength(25)
    expect(Math.max(...result.placements.map(p => p.yMm + p.heightMm))).toBe(108)
    expect(result.placements.filter(p => p.itemId === 'B').every(p => p.yMm >= 58 && p.yMm < 108)).toBe(true)
  })

  it('keeps the remaining row space available when an intermediate pattern does not fit', () => {
    const result = arrangeItems({
      paper: { widthMm: 108, heightMm: 68 }, mode: 'custom', gapMm: 4,
      items: [
        { id: 'A', widthMm: 60, heightMm: 60, quantity: 1, selected: true },
        { id: 'B', widthMm: 40, heightMm: 60, quantity: 1, selected: true },
        { id: 'C', widthMm: 10, heightMm: 10, quantity: 6, selected: true },
      ],
    })
    expect(result.placements.filter(p => p.itemId === 'C')).toHaveLength(6)
    expect(result.placements.filter(p => p.itemId === 'B')).toHaveLength(0)
    expect(result.overflow).toBe(1)
  })

  it('places priority images first in custom mode, keeping upload order within each priority', () => {
    const result = arrangeItems({
      paper: { widthMm: 108, heightMm: 58 }, gapMm: 0, mode: 'custom',
      items: [
        { id: 'normal', widthMm: 50, heightMm: 50, quantity: 2, selected: true },
        { id: 'priority-first', widthMm: 50, heightMm: 50, quantity: 1, selected: true, important: true },
        { id: 'priority-second', widthMm: 50, heightMm: 50, quantity: 1, selected: true, important: true },
      ],
    })
    expect(result.placements.map((slot) => slot.itemId)).toEqual(['priority-first', 'priority-second'])
    expect(result.overflow).toBe(2)
  })

  it('honors custom quantities without placing anything outside the sheet', () => {
    const result = arrangeItems({
      paper: { widthMm: 58, heightMm: 33 },
      gapMm: 5,
      mode: 'custom',
      items: [{ id: 'flower', widthMm: 20, heightMm: 20, quantity: 3, selected: true }],
    })

    expect(result.placements.map(({ xMm, yMm }) => [xMm, yMm])).toEqual([[6.5, 4], [31.5, 4]])
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
      paper: { widthMm: 33, heightMm: 33 },
      gapXmm: 5,
      gapYmm: 2,
      mode: 'custom',
      items: [{ id: 'a', widthMm: 10, heightMm: 10, quantity: 3, selected: true }],
    })
    expect(result.placements.map(({ xMm, yMm }) => [xMm, yMm])).toEqual([[4, 4], [19, 4], [11.5, 16]])
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
      [13.5, 4], [68.5, 4], [123.5, 4], [178.5, 4], [233.5, 4],
    ])
    expect(result.placements.slice(-2).map(({ xMm, yMm }) => [xMm, yMm])).toEqual([[96, 108], [151, 108]])
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
    expect(result.placements.map(({ xMm, yMm }) => [xMm, yMm])).toEqual([[4, 20], [86, 20]])
  })

  it.each(['balanced', 'compact', 'custom', 'smart'] as const)('keeps a 4mm margin on every edge in %s mode', (mode) => {
    for (const autoGap of [false, true]) {
      const result = arrangeItems({
        paper: { widthMm: 40, heightMm: 30 }, gapMm: 0, autoGap, mode,
        items: [{ id: 'exact-fit', widthMm: 32, heightMm: 22, quantity: 2, selected: true }],
      })
      expect(result.placements).toEqual([{ itemId: 'exact-fit', xMm: 4, yMm: 4, widthMm: 32, heightMm: 22 }])
    }
  })

  it.each(['balanced', 'compact', 'custom', 'smart'] as const)('does not shrink oversized patterns to bypass the margin in %s mode', (mode) => {
    const result = arrangeItems({
      paper: { widthMm: 40, heightMm: 30 }, mode,
      items: [{ id: 'too-wide', widthMm: 33, heightMm: 22, quantity: 2, selected: true }],
    })
    expect(result.placements).toEqual([])
    expect(result.overflow).toBe(mode === 'custom' || mode === 'smart' ? 2 : 0)
  })
})
