import { describe, expect, it } from 'vitest'
import { fitSizeMm, resizeAssetSize, rotatedBounds } from './assetGeometry'

describe('sticker asset geometry', () => {
  it('starts at a five-centimeter long edge without stretching the image', () => {
    expect(fitSizeMm(1000, 500, 50)).toEqual({ widthMm: 50, heightMm: 25 })
  })

  it('keeps the original ratio only while the ratio lock is on', () => {
    expect(resizeAssetSize({ widthMm: 50, heightMm: 25 }, 1000, 500, 'heightMm', 30, true)).toEqual({ widthMm: 60, heightMm: 30 })
    expect(resizeAssetSize({ widthMm: 50, heightMm: 25 }, 1000, 500, 'heightMm', 30, false)).toEqual({ widthMm: 50, heightMm: 30 })
  })

  it('uses the rotated bounding box for layout', () => {
    expect(rotatedBounds(50, 25, 90)).toEqual({ widthMm: 25, heightMm: 50 })
  })
})
