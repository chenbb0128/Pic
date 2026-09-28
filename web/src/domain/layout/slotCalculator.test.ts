import { describe, expect, it } from 'vitest'
import {
  ARTBOARD_MM,
  calculateSlots,
  getLayoutCount,
  type LayoutConfig,
} from './slotCalculator'

describe('calculateSlots', () => {
  it('creates the default mixed layout with 48 two-centimeter and 24 three-centimeter slots', () => {
    const result = calculateSlots({ mode: 'mixed', rows2: 4, rows3: 3 })

    expect(result.valid).toBe(true)
    expect(result.slots2).toHaveLength(48)
    expect(result.slots3).toHaveLength(24)
    expect(result.slots2[0]).toMatchObject({ xMm: 0, yMm: 0, sizeMm: 20, type: '2cm' })
    expect(result.slots2.at(-1)).toMatchObject({ xMm: ARTBOARD_MM.width - 20, sizeMm: 20 })
    expect(result.slots3.at(-1)).toMatchObject({ xMm: ARTBOARD_MM.width - 30, yMm: ARTBOARD_MM.height - 30 })
    expect(result.gapY).toBeCloseTo(6.6667, 3)
  })

  it('keeps the selected row counts in full-sheet modes', () => {
    const full2 = calculateSlots({ mode: 'full2', rows2: 4, rows3: 3 })
    const full3 = calculateSlots({ mode: 'full3', rows2: 4, rows3: 7 })

    expect(full2.slots2).toHaveLength(48)
    expect(full2.slots3).toHaveLength(0)
    expect(full3.slots2).toHaveLength(0)
    expect(full3.slots3).toHaveLength(56)
    expect(getLayoutCount(full2)).toEqual({ count2: 48, count3: 0 })
    expect(getLayoutCount(full3)).toEqual({ count2: 0, count3: 56 })
  })

  it('rejects a mixed row combination that cannot fit the artboard', () => {
    const config: LayoutConfig = { mode: 'mixed', rows2: 10, rows3: 7 }
    const result = calculateSlots(config)

    expect(result.valid).toBe(false)
    expect(result.slots2).toHaveLength(0)
    expect(result.slots3).toHaveLength(0)
    expect(result.error).toContain('无法放入')
  })
})
