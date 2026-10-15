import { describe, expect, it } from 'vitest'
import { arrangeItems, type ArrangeOptions, type Placement } from './layout'

function checkBoundsAndGaps(slots: Placement[], paper: { widthMm: number; heightMm: number }, gapX: number, gapY: number): void {
  for (const [index, a] of slots.entries()) {
    expect(a.xMm).toBeGreaterThanOrEqual(4 - 1e-6)
    expect(a.yMm).toBeGreaterThanOrEqual(4 - 1e-6)
    expect(a.xMm + a.widthMm).toBeLessThanOrEqual(paper.widthMm - 4 + 1e-6)
    expect(a.yMm + a.heightMm).toBeLessThanOrEqual(paper.heightMm - 4 + 1e-6)
    for (const b of slots.slice(index + 1)) {
      expect(a.xMm + a.widthMm + gapX <= b.xMm + 1e-6 || b.xMm + b.widthMm + gapX <= a.xMm + 1e-6 ||
        a.yMm + a.heightMm + gapY <= b.yMm + 1e-6 || b.yMm + b.heightMm + gapY <= a.yMm + 1e-6).toBe(true)
    }
  }
}

describe('grouped smart packing', () => {
  it('starts a new row for each material instead of filling the previous partial row', () => {
    const paper = { widthMm: 100, heightMm: 80 }
    const result = arrangeItems({
      paper, mode: 'smart', grouping: 'rows', gapXmm: 4, gapYmm: 3,
      items: [
        { id: 'large', widthMm: 30, heightMm: 20, quantity: 2, selected: true },
        { id: 'important', widthMm: 20, heightMm: 10, quantity: 2, selected: true, important: true },
      ],
    })
    expect(result.placements.map((slot) => slot.itemId)).toEqual(['important', 'important', 'large', 'large'])
    expect(result.placements.map((slot) => slot.yMm)).toEqual([4, 4, 17, 17])
    expect(result.placements[1]!.xMm - result.placements[0]!.xMm).toBe(24)
    expect(result.overflow).toBe(0)
    checkBoundsAndGaps(result.placements, paper, 4, 3)
  })

  it('wraps the same material onto aligned rows before moving to the next material', () => {
    const paper = { widthMm: 100, heightMm: 80 }
    const result = arrangeItems({
      paper, mode: 'smart', grouping: 'rows', gapXmm: 4, gapYmm: 3,
      items: [
        { id: 'important', widthMm: 20, heightMm: 10, quantity: 5, selected: true, important: true },
        { id: 'other', widthMm: 30, heightMm: 20, quantity: 2, selected: true },
      ],
    })
    expect(result.placements.map((slot) => slot.yMm)).toEqual([4, 4, 4, 4, 17, 30, 30])
    expect(result.placements[0]!.xMm).toBe(result.placements[4]!.xMm)
    checkBoundsAndGaps(result.placements, paper, 4, 3)
  })

  it('starts a new column for each material and aligns copies vertically', () => {
    const paper = { widthMm: 80, heightMm: 100 }
    const result = arrangeItems({
      paper, mode: 'smart', grouping: 'columns', gapXmm: 3, gapYmm: 4,
      items: [
        { id: 'important', widthMm: 10, heightMm: 20, quantity: 2, selected: true, important: true },
        { id: 'other', widthMm: 20, heightMm: 30, quantity: 2, selected: true },
      ],
    })
    const [a, b, c, d] = result.placements as [Placement, Placement, Placement, Placement]
    expect(a.xMm).toBe(b.xMm)
    expect(c.xMm).toBe(d.xMm)
    expect(c.xMm - a.xMm).toBe(13)
    expect([a.yMm, b.yMm, c.yMm, d.yMm]).toEqual([4, 28, 4, 38])
    checkBoundsAndGaps(result.placements, paper, 3, 4)
  })

  it.each(['rows', 'columns'] as const)('avoids locked placements with %s grouping without moving them', (grouping) => {
    const paper = { widthMm: 100, heightMm: 80 }
    const locked = { itemId: 'locked', xMm: 4, yMm: 4, widthMm: 30, heightMm: 20 }
    const result = arrangeItems({
      paper, mode: 'smart', grouping, gapMm: 3, reserved: [locked],
      items: [{ id: 'new', widthMm: 15, heightMm: 10, quantity: 6, selected: true }],
    })
    expect(result.placements).toHaveLength(6)
    expect(locked).toEqual({ itemId: 'locked', xMm: 4, yMm: 4, widthMm: 30, heightMm: 20 })
    checkBoundsAndGaps([locked, ...result.placements], paper, 3, 3)
  })

  it('preserves strict grouping instead of interleaving transparent corners', () => {
    const result = arrangeItems({
      paper: { widthMm: 28, heightMm: 28 }, mode: 'smart', grouping: 'rows', gapMm: 2,
      items: [
        { id: 'important', widthMm: 20, heightMm: 20, quantity: 1, selected: true, important: true,
          contour: { width: 40, rows: Array.from({ length: 40 }, (_, y) => [0, y < 20 ? 20 : 40]) } },
        { id: 'small', widthMm: 6, heightMm: 6, quantity: 1, selected: true },
      ],
    })
    expect(result.placements.map((slot) => slot.itemId)).toEqual(['important'])
    expect(result.overflow).toBe(1)
  })

  it('caps quantities and continues with smaller materials when a large one cannot fit', () => {
    const options: ArrangeOptions = {
      paper: { widthMm: 100, heightMm: 80 }, mode: 'smart', grouping: 'rows', gapMm: 0,
      items: [
        { id: 'oversized', widthMm: 200, heightMm: 20, quantity: 2, selected: true },
        { id: 'small', widthMm: 1, heightMm: 1, quantity: 501.9, selected: true },
        { id: 'zero', widthMm: 1, heightMm: 1, quantity: 0, selected: true },
        { id: 'unchecked', widthMm: 1, heightMm: 1, quantity: 500, selected: false },
      ],
    }
    const result = arrangeItems(options)
    expect(result.placements).toHaveLength(500)
    expect(result.placements.every((slot) => slot.itemId === 'small')).toBe(true)
    expect(result.overflow).toBe(2)
  })
})
