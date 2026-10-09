import { describe, expect, it } from 'vitest'
import { exportSize } from './exportSize'

describe('exportSize', () => {
  it('allows A4 at 800 and 1000 DPI while rejecting oversized custom sheets', () => {
    expect(exportSize({ widthMm: 148, heightMm: 105 }, 1000).allowed).toBe(true)
    expect(exportSize({ widthMm: 297, heightMm: 210 }, 800)).toEqual({ width: 9354, height: 6614, allowed: true })
    expect(exportSize({ widthMm: 297, heightMm: 210 }, 1000)).toEqual({ width: 11693, height: 8268, allowed: true })
    expect(exportSize({ widthMm: 420, heightMm: 420 }, 1000).allowed).toBe(false)
  })

  it('reports the actual rounded pixel dimensions used by export', () => {
    expect(exportSize({ widthMm: 297, heightMm: 210 }, 300)).toEqual({ width: 3508, height: 2480, allowed: true })
  })
})
