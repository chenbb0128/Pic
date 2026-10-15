import { describe, expect, it } from 'vitest'
import { fitSizeMm, originalSizeMm, resizeAssetSize, rotatedBounds } from './assetGeometry'

describe('sticker asset geometry', () => {
  it('converts original pixels to millimeters without fitting to a fixed edge', () => {
    expect(originalSizeMm(1500, 750, 300)).toEqual({ widthMm: 127, heightMm: 63.5 })
    expect(originalSizeMm(10000, 5000, 500)).toEqual({ widthMm: 508, heightMm: 254 })
  })

  it('fits a requested long edge without stretching the image', () => {
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
