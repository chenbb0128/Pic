import { describe, expect, it } from 'vitest'
import { resizePlacement } from './placementAdjustments'
import * as adjustments from './placementAdjustments'
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
      { itemId: 'snake', xMm: 12, yMm: 4, widthMm: 84, heightMm: 42 },
    ])
  })

  it('rejects a non-positive width', () => {
    const placements: Placement[] = [{ itemId: 'snake', xMm: 0, yMm: 0, widthMm: 20, heightMm: 10 }]
    expect(() => resizePlacement(placements, 0, 0, { widthMm: 100, heightMm: 50 })).toThrow('有效尺寸')
  })
})

describe('box selection and equal spacing', () => {
  const slots: Placement[] = [
    { itemId: 'same', xMm: 10, yMm: 10, widthMm: 10, heightMm: 10 },
    { itemId: 'same', xMm: 35, yMm: 20, widthMm: 20, heightMm: 20 },
    { itemId: 'same', xMm: 80, yMm: 15, widthMm: 10, heightMm: 10 },
    { itemId: 'other', xMm: 10, yMm: 70, widthMm: 10, heightMm: 10 },
  ]
  const paper = { widthMm: 100, heightMm: 100 }

  it('selects fully enclosed instances in either drag direction and excludes locked instances', () => {
    expect(adjustments.selectPlacementsInBox(slots, { xMm: 95, yMm: 50 }, { xMm: 5, yMm: 5 }, 1)).toEqual([1, 2])
    expect(adjustments.selectPlacementsInBox(slots, { xMm: 5, yMm: 5 }, { xMm: 40, yMm: 50 })).toEqual([0])
  })

  it('uses equal edge gaps for mixed widths on one centered row without changing other copies', () => {
    const result = adjustments.distributePlacements(slots, [2, 0, 1], 'x', paper)
    expect(result).toEqual([
      { ...slots[0], xMm: 10, yMm: 20 },
      { ...slots[1], xMm: 40, yMm: 15 },
      { ...slots[2], xMm: 80, yMm: 20 },
      slots[3],
    ])
    expect(slots[1].xMm).toBe(35)
  })

  it('uses equal edge gaps for mixed heights on one centered column', () => {
    const vertical = slots.slice(0, 3).map(slot => ({ ...slot, xMm: slot.yMm, yMm: slot.xMm, widthMm: slot.heightMm, heightMm: slot.widthMm }))
    expect(adjustments.distributePlacements(vertical, [0, 1, 2], 'y', paper)).toEqual([
      { ...vertical[0], xMm: 20, yMm: 10 },
      { ...vertical[1], xMm: 15, yMm: 40 },
      { ...vertical[2], xMm: 20, yMm: 80 },
    ])
  })

  it('rejects insufficient selections, locked selections and insufficient space without mutating input', () => {
    expect(() => adjustments.distributePlacements(slots, [0, 1], 'x', paper)).toThrow('至少')
    expect(() => adjustments.distributePlacements(slots, [0, 1, 2], 'x', paper, 1)).toThrow('锁定')
    const crowded = slots.slice(0, 3).map(slot => ({ ...slot, xMm: 10 }))
    expect(() => adjustments.distributePlacements(crowded, [0, 1, 2], 'x', paper)).toThrow('空间不足')
    expect(crowded.map(slot => slot.xMm)).toEqual([10, 10, 10])
  })

  it('rejects a result overlapping unselected items or crossing the 4mm margin', () => {
    expect(() => adjustments.distributePlacements([...slots, { ...slots[3], xMm: 40, yMm: 15 }], [0, 1, 2], 'x', paper)).toThrow('重叠')
    expect(() => adjustments.distributePlacements(slots, [0, 1, 2], 'x', { widthMm: 90, heightMm: 100 })).toThrow('4mm')
  })

  it('rejects equal spacing under 4mm even when images do not overlap', () => {
    const close = [slots[0], { ...slots[0], xMm: 22 }, { ...slots[0], xMm: 34 }]
    expect(() => adjustments.distributePlacements(close, [0, 1, 2], 'x', paper)).toThrow('4mm')
    const valid = close.map((slot, index) => ({ ...slot, xMm: 10 + index * 14 }))
    expect(adjustments.distributePlacements(valid, [0, 1, 2], 'x', paper).map(slot => slot.xMm)).toEqual([10, 24, 38])
    expect(() => adjustments.distributePlacements([...slots, { ...slots[3], xMm: 63, yMm: 15 }], [0, 1, 2], 'x', paper)).toThrow('4mm')
  })
})
