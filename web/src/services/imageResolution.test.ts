import { describe, expect, it } from 'vitest'
import { readImageDpi } from './imageResolution'

function png(unit = 1) {
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 9, 112, 72, 89, 115,
    0, 0, 46, 35, 0, 0, 46, 35, unit, 0, 0, 0, 0,
  ])
}

function exif(little = true, unit = 2, denominator = 1) {
  const data = new Uint8Array(52)
  const view = new DataView(data.buffer)
  data.set(little ? [73, 73] : [77, 77])
  view.setUint16(2, 42, little)
  view.setUint32(4, 8, little)
  view.setUint16(8, 2, little)
  view.setUint16(10, 0x11a, little)
  view.setUint16(12, 5, little)
  view.setUint32(14, 1, little)
  view.setUint32(18, 44, little)
  view.setUint16(22, 0x128, little)
  view.setUint16(24, 3, little)
  view.setUint32(26, 1, little)
  view.setUint16(30, unit, little)
  view.setUint32(44, 300, little)
  view.setUint32(48, denominator, little)
  return data
}

function jpegExif(data: Uint8Array) {
  return new Uint8Array([255, 216, 255, 225, 0, data.length + 8, 69, 120, 105, 102, 0, 0, ...data, 255, 217])
}

describe('source image print resolution', () => {
  it('reads PNG density only when it has physical units', () => {
    expect(readImageDpi(png().buffer)).toBeCloseTo(300, 2)
    expect(readImageDpi(png(0).buffer)).toBeUndefined()
  })

  it.each([true, false])('reads JPEG EXIF resolution with little endian = %s', (little) => {
    expect(readImageDpi(jpegExif(exif(little)).buffer)).toBe(300)
  })

  it('converts EXIF pixels per centimeter to DPI', () => {
    expect(readImageDpi(jpegExif(exif(true, 3)).buffer)).toBe(762)
  })

  it('reads JPEG JFIF density and rejects unitless aspect ratios', () => {
    const data = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 2, 1, 1, 44, 1, 44, 0, 0, 255, 217])
    expect(readImageDpi(data.buffer)).toBe(300)
    data[13] = 0
    expect(readImageDpi(data.buffer)).toBeUndefined()
  })

  it('reads WebP EXIF density', () => {
    const data = exif()
    const webp = new Uint8Array([82, 73, 70, 70, 64, 0, 0, 0, 87, 69, 66, 80, 69, 88, 73, 70, data.length, 0, 0, 0, ...data])
    expect(readImageDpi(webp.buffer)).toBe(300)
  })

  it('falls back safely for missing, invalid or truncated metadata', () => {
    for (const data of [new Uint8Array(), png().slice(0, 20), jpegExif(exif(true, 1)), jpegExif(exif(true, 2, 0))]) {
      expect(readImageDpi(data.buffer)).toBeUndefined()
    }
    const badOffset = exif()
    new DataView(badOffset.buffer).setUint32(18, 99999, true)
    expect(readImageDpi(jpegExif(badOffset).buffer)).toBeUndefined()
  })
})
