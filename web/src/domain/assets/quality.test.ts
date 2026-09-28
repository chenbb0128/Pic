import { describe, expect, it } from 'vitest'
import { assessQuality, requiredPixels, summarizeQuality } from './quality'

describe('asset quality', () => {
  it('calculates the minimum pixel size for each sticker type and dpi', () => {
    expect(requiredPixels('2cm', 300)).toBe(236)
    expect(requiredPixels('3cm', 600)).toBe(709)
  })

  it('classifies an asset by its shortest edge against the required size', () => {
    expect(assessQuality(354, 354, '2cm', 300).level).toBe('clear')
    expect(assessQuality(236, 300, '2cm', 300).level).toBe('usable')
    expect(assessQuality(180, 300, '2cm', 300).level).toBe('warning')
    expect(assessQuality(100, 300, '2cm', 300).level).toBe('insufficient')
  })

  it('summarizes the worst quality state without losing the total count', () => {
    const summary = summarizeQuality(
      [
        { width: 500, height: 500, type: '2cm' },
        { width: 180, height: 500, type: '2cm' },
      ],
      300,
    )

    expect(summary).toMatchObject({ total: 2, warning: 1, insufficient: 0, level: 'warning' })
  })
})
