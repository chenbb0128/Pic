import { describe, expect, it } from 'vitest'
import { containRect, imageSizePresets, outputPixelSize } from './imageSizeConversion'

describe('imageSizePresets', () => {
  it('contains the requested printable dimensions in millimetres', () => {
    expect(imageSizePresets).toEqual([
      { value: 'A3', label: 'A3', widthMm: 293, heightMm: 420 },
      { value: 'A4', label: 'A4', widthMm: 293, heightMm: 210 },
      { value: 'A5', label: 'A5', widthMm: 144, heightMm: 210 },
      { value: 'A6', label: 'A6', widthMm: 144, heightMm: 105 },
      { value: 'A7', label: 'A7', widthMm: 72, heightMm: 105 },
    ])
  })
})

describe('outputPixelSize', () => {
  it('converts the selected physical size to pixels at the requested DPI', () => {
    expect(outputPixelSize(imageSizePresets[0], 300)).toEqual({ width: 3461, height: 4961 })
    expect(outputPixelSize(imageSizePresets[1], 300)).toEqual({ width: 3461, height: 2480 })
  })
})

describe('containRect', () => {
  it('keeps the source aspect ratio and centers it on transparent canvas', () => {
    expect(containRect(100, 50, 200, 200)).toEqual({ x: 0, y: 50, width: 200, height: 100 })
    expect(containRect(50, 100, 200, 200)).toEqual({ x: 50, y: 0, width: 100, height: 200 })
  })
})
