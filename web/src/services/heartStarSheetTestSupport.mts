import { inflateSync } from 'node:zlib'
import { expect } from 'vitest'

// Decodes the base sheet as exported: 8-bit RGBA without interlacing.
export function sheetAlpha(bytes: Buffer) {
  expect([bytes[24], bytes[25], bytes[28]]).toEqual([8, 6, 0])
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  const chunks: Buffer[] = []
  for (let position = 8; position < bytes.length; position += 12 + bytes.readUInt32BE(position))
    if (bytes.toString('ascii', position + 4, position + 8) === 'IDAT') chunks.push(bytes.subarray(position + 8, position + 8 + bytes.readUInt32BE(position)))
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4, pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= 4 ? pixels[at - 4] : 0, b = y ? pixels[at - stride] : 0
      const c = x >= 4 && y ? pixels[at - stride - 4] : 0
      let value = raw[y * (stride + 1) + 1 + x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[at] = value & 255
    }
  }
  return { width, height, alpha: (x: number, y: number) => pixels[y * stride + x * 4 + 3] }
}
