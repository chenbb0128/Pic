import { describe, expect, it } from 'vitest'
import { arrangeItems, type PaperSize, type Placement } from './layout'

function expectValidLayout(placements: Placement[], paper: PaperSize, gapXmm: number, gapYmm: number): void {
  const tolerance = 1e-6
  for (const [index, slot] of placements.entries()) {
    expect(slot.xMm).toBeGreaterThanOrEqual(4 - tolerance)
    expect(slot.yMm).toBeGreaterThanOrEqual(4 - tolerance)
    expect(slot.xMm + slot.widthMm).toBeLessThanOrEqual(paper.widthMm - 4 + tolerance)
    expect(slot.yMm + slot.heightMm).toBeLessThanOrEqual(paper.heightMm - 4 + tolerance)
    for (const other of placements.slice(index + 1)) {
      expect(slot.xMm + slot.widthMm + gapXmm <= other.xMm + tolerance ||
        other.xMm + other.widthMm + gapXmm <= slot.xMm + tolerance ||
        slot.yMm + slot.heightMm + gapYmm <= other.yMm + tolerance ||
        other.yMm + other.heightMm + gapYmm <= slot.yMm + tolerance).toBe(true)
    }
  }
}

describe('smart quantity packing', () => {
  it('satisfies important small patterns before ordinary large patterns', () => {
    const paper = { widthMm: 100, heightMm: 60 }
    const result = arrangeItems({
      paper, gapMm: 4, mode: 'smart',
      items: [
        { id: 'large', widthMm: 60, heightMm: 40, quantity: 1, selected: true },
        { id: 'important', widthMm: 20, heightMm: 20, quantity: 4, selected: true, important: true },
      ],
    })
    expect(result.placements.map((slot) => slot.itemId)).toEqual(Array(4).fill('important'))
    expect(result.overflow).toBe(1)
    expectValidLayout(result.placements, paper, 4, 4)
  })

  it('orders important patterns by area and fills remaining space without exceeding quantities', () => {
    const paper = { widthMm: 100, heightMm: 100 }
    const result = arrangeItems({
      paper, gapMm: 4, mode: 'smart',
      items: [
        { id: 'ordinary', widthMm: 50, heightMm: 40, quantity: 1, selected: true },
        { id: 'important-small', widthMm: 20, heightMm: 20, quantity: 2, selected: true, important: true },
        { id: 'important-large', widthMm: 40, heightMm: 30, quantity: 1, selected: true, important: true },
      ],
    })
    expect(result.placements.map((slot) => slot.itemId)).toEqual([
      'important-large', 'important-small', 'important-small', 'ordinary',
    ])
    expect(result.overflow).toBe(0)
    expectValidLayout(result.placements, paper, 4, 4)
  })

  it('continues filling with ordinary patterns when an important pattern cannot fit', () => {
    const paper = { widthMm: 100, heightMm: 60 }
    const result = arrangeItems({
      paper, gapMm: 4, mode: 'smart',
      items: [
        { id: 'oversized', widthMm: 95, heightMm: 10, quantity: 2, selected: true, important: true },
        { id: 'ordinary', widthMm: 20, heightMm: 20, quantity: 4, selected: true },
      ],
    })
    expect(result.placements.map((slot) => slot.itemId)).toEqual(Array(4).fill('ordinary'))
    expect(result.overflow).toBe(2)
    expectValidLayout(result.placements, paper, 4, 4)
  })

  it('prioritizes 20 large patterns and fills side gaps from the 100 small patterns regardless of upload order', () => {
    const paper = { widthMm: 293, heightMm: 210 }
    const result = arrangeItems({
      paper, gapXmm: 4, gapYmm: 4, mode: 'smart',
      items: [
        { id: 'small', widthMm: 12, heightMm: 5, quantity: 100, selected: true },
        { id: 'large', widthMm: 60, heightMm: 45, quantity: 20, selected: true },
      ],
    })
    const large = result.placements.filter((slot) => slot.itemId === 'large')
    const small = result.placements.filter((slot) => slot.itemId === 'small')
    expect(large).toHaveLength(16)
    expect(small.length).toBeGreaterThanOrEqual(40)
    expect(small.length).toBeLessThanOrEqual(100)
    expect(small.some((slot) => slot.yMm < 46)).toBe(true)
    expect(large.every((slot) => slot.widthMm === 60 && slot.heightMm === 45)).toBe(true)
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
    const locked = { itemId: 'locked', xMm: 4, yMm: 4, widthMm: 55, heightMm: 42 }
    const result = arrangeItems({
      paper, gapXmm: 5, gapYmm: 5, mode: 'smart', reserved: [locked],
      items: [{ id: 'small', widthMm: 30, heightMm: 18, quantity: 10, selected: true }],
    })
    expect(result.placements).toHaveLength(2)
    expect(result.placements.every((slot) => slot.xMm === 64)).toBe(true)
    expect(result.overflow).toBe(8)
    expect(locked).toEqual({ itemId: 'locked', xMm: 4, yMm: 4, widthMm: 55, heightMm: 42 })
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
