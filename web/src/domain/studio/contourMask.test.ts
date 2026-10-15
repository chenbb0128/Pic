import { describe, expect, it } from 'vitest'
import { alphaRowsFromRgba, projectContour } from './contourMask'

describe('image contour mask', () => {
  it('keeps faint and isolated original pixels before projecting into collision cells', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4)
    rgba[(0 * 4 + 0) * 4 + 3] = 1
    rgba[(2 * 4 + 0) * 4 + 3] = 255
    rgba[(3 * 4 + 3) * 4 + 3] = 255
    expect(alphaRowsFromRgba(rgba, 4, 4)).toEqual([[0, 1], null, [0, 1], [3, 4]])
    const source = { width: 4, rows: alphaRowsFromRgba(rgba, 4, 4) }
    expect(projectContour(source, 1, 1, 0, false)).toEqual({ width: 2, rows: [[0, 1], [0, 2]] })
  })

  it('uses rectangular fallback for fully opaque or fully transparent images', () => {
    expect(projectContour({ width: 2, rows: alphaRowsFromRgba(new Uint8ClampedArray(16).fill(255), 2, 2) }, 1, 1, 0, false)).toBeUndefined()
    expect(projectContour({ width: 2, rows: alphaRowsFromRgba(new Uint8ClampedArray(16), 2, 2) }, 1, 1, 0, false)).toBeUndefined()
  })

  it('retains a single pixel from a high-resolution original even at tiny print size', () => {
    const rows: ([number, number] | null)[] = Array(1000).fill(null)
    rows[500] = [500, 501]
    expect(projectContour({ width: 1000, rows }, 1, 1, 0, false)).toEqual({ width: 2, rows: [null, [1, 2]] })
  })

  it('projects original pixels through rotation using the same physical bounds as rendering', () => {
    const source = { width: 4, rows: [[0, 2], [0, 4]] as [number, number][] }
    expect(projectContour(source, 2, 1, 90, false)).toEqual({ width: 2, rows: [[0, 2], [0, 2], [0, 1], [0, 1]] })
  })
})
