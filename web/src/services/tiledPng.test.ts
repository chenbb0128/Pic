import { describe, expect, it } from 'vitest'
import { encodePngFromStripes } from './tiledPng'

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('encodePngFromStripes', () => {
  it('writes valid transparent RGBA pixels and 800 DPI metadata across stripes', async () => {
    const source = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 0, 0, 0,
      0, 255, 0, 128, 0, 0, 255, 255,
    ])
    const stripes: number[] = []
    const blob = await encodePngFromStripes({
      width: 2,
      height: 2,
      dpi: 800,
      stripeHeight: 1,
      renderStripe: (top, rows) => {
        stripes.push(top)
        return source.slice(top * 8, (top + rows) * 8)
      },
    })

    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(blob.type).toBe('image/png')
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const chunks: { type: string; data: Uint8Array }[] = []
    for (let offset = 8; offset < bytes.length;) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
      const length = view.getUint32(0)
      const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8))
      expect(view.getUint32(8 + length)).toBe(crc32(bytes.slice(offset + 4, offset + 8 + length)))
      chunks.push({ type, data: bytes.slice(offset + 8, offset + 8 + length) })
      offset += length + 12
    }
    expect(chunks.slice(0, 2).map((chunk) => chunk.type)).toEqual(['IHDR', 'pHYs'])
    expect(chunks.slice(2, -1).every((chunk) => chunk.type === 'IDAT')).toBe(true)
    expect(chunks.at(-1)?.type).toBe('IEND')
    const header = new DataView(chunks[0].data.buffer)
    expect([header.getUint32(0), header.getUint32(4), chunks[0].data[8], chunks[0].data[9]]).toEqual([2, 2, 8, 6])
    const density = new DataView(chunks[1].data.buffer)
    expect([density.getUint32(0), density.getUint32(4), chunks[1].data[8]]).toEqual([31496, 31496, 1])
    const compressed = new Blob(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => new Uint8Array(chunk.data).buffer))
    const raw = new Uint8Array(await new Response(compressed.stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())
    expect([...raw]).toEqual([
      0, 255, 0, 0, 255, 0, 0, 0, 0,
      0, 0, 255, 0, 128, 0, 0, 255, 255,
    ])
    expect(stripes).toEqual([0, 1])
  })
})
