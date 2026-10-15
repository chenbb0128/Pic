import { describe, expect, it } from 'vitest'
import { arrangeItems, type LayoutItem, type Placement } from './layout'

// A 20mm square with a transparent 10mm upper-right corner.
const corner = {
  width: 40,
  rows: Array.from({ length: 40 }, (_, y) => [0, y < 20 ? 20 : 40] as [number, number]),
}

function pack(items: LayoutItem[], gapMm = 2, reserved: Placement[] = []) {
  return arrangeItems({ paper: { widthMm: 28, heightMm: 28 }, mode: 'smart', gapMm, items, reserved })
}

describe('transparent contour packing', () => {
  it('fills A4 corner gaps while preserving at least the original 16 important patterns', () => {
    const ellipse = {
      width: 130,
      rows: Array.from({ length: 92 }, (_, y) => {
        const distance = Math.max(0, Math.abs(y + 0.5 - 46) - 0.5) / 46
        const radius = 65 * Math.sqrt(1 - distance * distance)
        return [Math.floor(65 - radius), Math.ceil(65 + radius)] as [number, number]
      }),
    }
    const result = arrangeItems({
      paper: { widthMm: 293, heightMm: 210 }, mode: 'smart', gapMm: 4,
      items: [
        { id: 'important', widthMm: 65, heightMm: 45.6, quantity: 20, selected: true, important: true, contour: ellipse },
        { id: 'small', widthMm: 15, heightMm: 6.8, quantity: 100, selected: true },
      ],
    })
    const important = result.placements.filter((slot) => slot.itemId === 'important')
    const small = result.placements.filter((slot) => slot.itemId === 'small')
    expect(important.length).toBeGreaterThanOrEqual(16)
    expect(important.length).toBeLessThanOrEqual(20)
    expect(small.length).toBeGreaterThan(0)
    expect(small.length).toBeLessThanOrEqual(100)
    expect(result.overflow).toBe(120 - result.placements.length)
    for (const slot of result.placements) {
      expect(slot.xMm).toBeGreaterThanOrEqual(4 - 1e-6)
      expect(slot.yMm).toBeGreaterThanOrEqual(4 - 1e-6)
      expect(slot.xMm + slot.widthMm).toBeLessThanOrEqual(289 + 1e-6)
      expect(slot.yMm + slot.heightMm).toBeLessThanOrEqual(206 + 1e-6)
    }
    // Independently check all occupied row rectangles, including the configured gap.
    for (const [index, a] of result.placements.entries()) {
      const aRows = a.itemId === 'important' ? ellipse.rows : Array(14).fill([0, 30]) as [number, number][]
      for (const b of result.placements.slice(index + 1)) {
        const bRows = b.itemId === 'important' ? ellipse.rows : Array(14).fill([0, 30]) as [number, number][]
        for (const [ay, ar] of aRows.entries()) {
          for (const [by, br] of bRows.entries()) {
            if (a.yMm + Math.min((ay + 1) * 0.5, a.heightMm) + 4 <= b.yMm + by * 0.5 + 1e-6 ||
              b.yMm + Math.min((by + 1) * 0.5, b.heightMm) + 4 <= a.yMm + ay * 0.5 + 1e-6) continue
            expect(a.xMm + ar[1] * 0.5 + 4 <= b.xMm + br[0] * 0.5 + 1e-6 ||
              b.xMm + br[1] * 0.5 + 4 <= a.xMm + ar[0] * 0.5 + 1e-6).toBe(true)
          }
        }
      }
    }
  })

  it('fits a small pattern into a transparent corner without resizing either image', () => {
    const items = [
      { id: 'large', widthMm: 20, heightMm: 20, quantity: 1, selected: true, important: true, contour: corner },
      { id: 'small', widthMm: 6, heightMm: 6, quantity: 1, selected: true },
    ]
    const result = pack(items)
    expect(result.placements).toHaveLength(2)
    expect(result.overflow).toBe(0)
    const large = result.placements.find((slot) => slot.itemId === 'large')!
    const small = result.placements.find((slot) => slot.itemId === 'small')!
    expect([large.widthMm, large.heightMm, small.widthMm, small.heightMm]).toEqual([20, 20, 6, 6])
    expect(small.xMm).toBeGreaterThanOrEqual(large.xMm + 12)
    expect(small.yMm + small.heightMm).toBeLessThanOrEqual(large.yMm + 8)
    expect(small.xMm + small.widthMm).toBeLessThanOrEqual(24)
    expect(small.yMm).toBeGreaterThanOrEqual(4)
  })

  it('does not squeeze a pattern into a transparent corner without the required gap', () => {
    expect(pack([
      { id: 'large', widthMm: 20, heightMm: 20, quantity: 1, selected: true, important: true, contour: corner },
      { id: 'small', widthMm: 6, heightMm: 6, quantity: 1, selected: true },
    ], 5).placements.map((slot) => slot.itemId)).toEqual(['large'])
  })

  it('keeps locked rectangles reserved even when the source has transparent corners', () => {
    const locked = { itemId: 'large', xMm: 4, yMm: 4, widthMm: 20, heightMm: 20 }
    const result = pack([
      { id: 'large', widthMm: 20, heightMm: 20, quantity: 0, selected: false, contour: corner },
      { id: 'small', widthMm: 6, heightMm: 6, quantity: 1, selected: true },
    ], 2, [locked])
    expect(result.placements).toEqual([])
    expect(locked).toEqual({ itemId: 'large', xMm: 4, yMm: 4, widthMm: 20, heightMm: 20 })
  })

  it('never reduces the original important count and respects zero and unchecked quantities', () => {
    const items = [
      { id: 'important', widthMm: 8, heightMm: 8, quantity: 3, selected: true, important: true, contour: { width: 16, rows: Array(16).fill([0, 8]) } },
      { id: 'zero', widthMm: 1, heightMm: 1, quantity: 0, selected: true },
      { id: 'unchecked', widthMm: 1, heightMm: 1, quantity: 500, selected: false },
    ]
    const result = pack(items)
    expect(result.placements.map((slot) => slot.itemId)).toEqual(Array(3).fill('important'))
    expect(result.overflow).toBe(0)
  })
})
