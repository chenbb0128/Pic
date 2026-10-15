import { describe, expect, it } from 'vitest'
import { arrangeItems, type PaperSize, type Placement } from './layout'

function expectValidLayout(placements: Placement[], paper: PaperSize, gapXmm: number, gapYmm: number): void {
  const tolerance = 1e-6
  for (const [index, slot] of placements.entries()) {
    expect(slot.xMm).toBeGreaterThanOrEqual(-tolerance)
    expect(slot.yMm).toBeGreaterThanOrEqual(-tolerance)
    expect(slot.xMm + slot.widthMm).toBeLessThanOrEqual(paper.widthMm + tolerance)
    expect(slot.yMm + slot.heightMm).toBeLessThanOrEqual(paper.heightMm + tolerance)
    for (const other of placements.slice(index + 1)) {
      expect(slot.xMm + slot.widthMm + gapXmm <= other.xMm + tolerance ||
        other.xMm + other.widthMm + gapXmm <= slot.xMm + tolerance ||
        slot.yMm + slot.heightMm + gapYmm <= other.yMm + tolerance ||
        other.yMm + other.heightMm + gapYmm <= slot.yMm + tolerance).toBe(true)
    }
  }
}

describe('smart quantity packing', () => {
  it('prioritizes 20 large patterns and fills side gaps from the 100 small patterns regardless of upload order', () => {
    const paper = { widthMm: 293, heightMm: 210 }
    const result = arrangeItems({
      paper, gapXmm: 4, gapYmm: 4, mode: 'smart',
      items: [
        { id: 'small', widthMm: 12, heightMm: 5, quantity: 100, selected: true },
        { id: 'large', widthMm: 65, heightMm: 46, quantity: 20, selected: true },
      ],
    })
    const large = result.placements.filter((slot) => slot.itemId === 'large')
    const small = result.placements.filter((slot) => slot.itemId === 'small')
    expect(large).toHaveLength(16)
    expect(small.length).toBeGreaterThanOrEqual(40)
    expect(small.length).toBeLessThanOrEqual(100)
    expect(small.some((slot) => slot.yMm < 46)).toBe(true)
    expect(large.every((slot) => slot.widthMm === 65 && slot.heightMm === 46)).toBe(true)
    expect(small.every((slot) => slot.widthMm === 12 && slot.heightMm === 5)).toBe(true)
    expect(result.overflow).toBe(120 - result.placements.length)
    expectValidLayout(result.placements, paper, 4, 4)
  })

  it('honors quantity limits and counts oversized selected patterns as unplaced', () => {
    const result = arrangeItems({
      paper: { widthMm: 100, heightMm: 100 }, gapMm: 2, mode: 'smart',
      items: [
        { id: 'large', widthMm: 60, heightMm: 60, quantity: 1, selected: true },
        { id: 'small', widthMm: 10, heightMm: 10, quantity: 3, selected: true },
        { id: 'zero', widthMm: 10, heightMm: 10, quantity: 0, selected: true },
        { id: 'unchecked', widthMm: 5, heightMm: 5, quantity: 100, selected: false },
        { id: 'oversized', widthMm: 101, heightMm: 10, quantity: 2, selected: true },
      ],
    })
    expect(result.placements.map((slot) => slot.itemId)).toEqual(['large', 'small', 'small', 'small'])
    expect(result.overflow).toBe(2)
    expectValidLayout(result.placements, { widthMm: 100, heightMm: 100 }, 2, 2)
  })

  it('packs around locked placements while preserving their positions and spacing', () => {
    const paper = { widthMm: 100, heightMm: 50 }
    const locked = { itemId: 'locked', xMm: 0, yMm: 0, widthMm: 60, heightMm: 50 }
    const result = arrangeItems({
      paper, gapXmm: 5, gapYmm: 5, mode: 'smart', reserved: [locked],
      items: [{ id: 'small', widthMm: 30, heightMm: 20, quantity: 10, selected: true }],
    })
    expect(result.placements).toHaveLength(2)
    expect(result.placements.every((slot) => slot.xMm === 65)).toBe(true)
    expect(result.overflow).toBe(8)
    expect(locked).toEqual({ itemId: 'locked', xMm: 0, yMm: 0, widthMm: 60, heightMm: 50 })
    expectValidLayout([locked, ...result.placements], paper, 5, 5)
  })

  it('keeps two-dimensional placements collision-free with automatic spacing and portrait paper', () => {
    const paper = { widthMm: 105, heightMm: 144 }
    const result = arrangeItems({
      paper, gapXmm: 20, gapYmm: 1, autoGap: true, mode: 'smart',
      items: [
        { id: 'large', widthMm: 60, heightMm: 60, quantity: 2, selected: true },
        { id: 'small', widthMm: 20, heightMm: 10, quantity: 30, selected: true },
      ],
    })
    expect(result.placements.filter((slot) => slot.itemId === 'large')).toHaveLength(2)
    expect(result.placements.filter((slot) => slot.itemId === 'small').length).toBeGreaterThan(0)
    expect(result.overflow).toBe(32 - result.placements.length)
    expectValidLayout(result.placements, paper, 5, 5)
  })
})
