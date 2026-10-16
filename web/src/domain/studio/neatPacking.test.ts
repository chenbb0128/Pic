import { describe, expect, it } from 'vitest'
import { arrangeItems, type LayoutItem, type Placement } from './layout'

const image = (id: string, widthMm: number, heightMm: number, quantity = 1): LayoutItem =>
  ({ id, widthMm, heightMm, quantity, selected: true })

function checkGeometry(slots: Placement[], width: number, height: number, gapX: number, gapY: number) {
  for (const [i, p] of slots.entries()) {
    expect(p.xMm).toBeGreaterThanOrEqual(4 - 1e-6)
    expect(p.yMm).toBeGreaterThanOrEqual(4 - 1e-6)
    expect(p.xMm + p.widthMm).toBeLessThanOrEqual(width - 4 + 1e-6)
    expect(p.yMm + p.heightMm).toBeLessThanOrEqual(height - 4 + 1e-6)
    for (const q of slots.slice(i + 1)) {
      expect(p.xMm + p.widthMm + gapX <= q.xMm + 1e-6 || q.xMm + q.widthMm + gapX <= p.xMm + 1e-6 ||
        p.yMm + p.heightMm + gapY <= q.yMm + 1e-6 || q.yMm + q.heightMm + gapY <= p.yMm + 1e-6).toBe(true)
    }
  }
}

describe('neat quantity packing', () => {
  it('does not repeatedly scan full columns when packing many small copies', () => {
    const start = performance.now()
    const result = arrangeItems({ paper: { widthMm: 420, heightMm: 420 }, mode: 'neat', gapMm: 0,
      items: Array.from({ length: 20 }, (_, index) => image(`small-${index}`, 5, 5, 500)) })
    expect(result.placements).toHaveLength(6724)
    expect(result.overflow).toBe(3276)
    expect(performance.now() - start).toBeLessThan(2000)
  })
  it.each([false, true])('stacks different small images in aligned columns beside a large image (auto=%s)', autoGap => {
    const items = [image('small-0', 10, 10), image('large', 50, 50),
      ...Array.from({ length: 8 }, (_, i) => image(`small-${i + 1}`, 10, 10))]
    const result = arrangeItems({ paper: { widthMm: 108, heightMm: 58 }, mode: 'neat', gapMm: 4, autoGap, items })
    expect(result.placements).toHaveLength(10)
    expect(result.overflow).toBe(0)
    const small = result.placements.filter(slot => slot.itemId !== 'large')
    expect(new Set(small.map(slot => slot.xMm)).size).toBe(3)
    expect(new Set(small.map(slot => slot.yMm)).size).toBe(3)
    expect(result.placements[0]!.itemId).toBe('large')
    expect(Math.min(...result.placements.map(p => p.xMm))).toBe(autoGap ? 6.5 : 8)
    checkGeometry(result.placements, 108, 58, autoGap ? 5 : 4, autoGap ? 5 : 4)
    for (const slot of result.placements) {
      const source = items.find(item => item.id === slot.itemId)!
      expect([slot.widthMm, slot.heightMm]).toEqual([source.widthMm, source.heightMm])
    }
  })

  it('keeps list priority for admission even when visual placement is size-sorted', () => {
    const small = { ...image('first', 10, 10, 3), priority: 2 }
    const big = { ...image('second', 50, 50), priority: 1 }
    const options = { paper: { widthMm: 68, heightMm: 58 }, mode: 'neat' as const, gapMm: 4 }
    const result = arrangeItems({ ...options, items: [small, big] })
    expect(result.placements.map(p => p.itemId)).toEqual(['first', 'first', 'first'])
    expect(result.overflow).toBe(1)
    const reversed = arrangeItems({ ...options, items: [{ ...big, priority: 2 }, { ...small, priority: 1 }] })
    expect(reversed.placements.map(p => p.itemId)).toEqual(['second'])
    expect(reversed.overflow).toBe(3)
  })

  it('avoids locked rectangles without moving them or dropping free quadrants', () => {
    const locked = { itemId: 'locked', xMm: 4, yMm: 4, widthMm: 40, heightMm: 40 }
    const before = { ...locked }
    const result = arrangeItems({ paper: { widthMm: 108, heightMm: 108 }, mode: 'neat', gapMm: 4,
      reserved: [locked], items: [image('normal', 40, 40, 3)] })
    expect(result.overflow).toBe(0)
    expect(result.placements).toHaveLength(3)
    expect(locked).toEqual(before)
    checkGeometry([...result.placements, locked], 108, 108, 4, 4)
  })

  it('centers the complete layout without stretching fixed gaps to fill the paper', () => {
    const result = arrangeItems({ paper: { widthMm: 100, heightMm: 100 }, mode: 'neat', gapXmm: 6, gapYmm: 3,
      items: [image('one', 20, 20, 3)] })
    expect(result.placements.map(p => [p.xMm, p.yMm])).toEqual([[14, 40], [40, 40], [66, 40]])
  })

  it('honors quantities and ignores custom-only breaks, spacing and transparent contours', () => {
    const items = [image('a', 30, 40, 2), image('b', 10, 10, 6)]
    const options = { paper: { widthMm: 108, heightMm: 108 }, mode: 'neat' as const, gapMm: 4 }
    const result = arrangeItems({ ...options, items })
    expect(result.placements).toHaveLength(8)
    expect(arrangeItems({ ...options, items: items.map(item => ({ ...item, gapXmm: 30, gapYmm: 30, startNewRow: true,
      contour: { width: 2, rows: [[0, 1], null] },
    })) })).toEqual(result)
  })

  it('counts invalid or oversized selected images as remaining and never shrinks them', () => {
    const result = arrangeItems({ paper: { widthMm: 40, heightMm: 30 }, mode: 'neat', items: [
      image('wide', 33, 22, 2), image('invalid', NaN, 10), { ...image('unchecked', 10, 10, 5), selected: false },
      image('zero', 10, 10, 0), image('fit', 32, 22),
    ] })
    expect(result.placements).toEqual([{ itemId: 'fit', xMm: 4, yMm: 4, widthMm: 32, heightMm: 22 }])
    expect(result.overflow).toBe(3)
  })
})
