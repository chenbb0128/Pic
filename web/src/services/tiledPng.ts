import { dpiToPixelsPerMeter } from './pngExporter'

export interface PngStripesOptions {
  width: number
  height: number
  dpi: number
  stripeHeight: number
  renderStripe: (top: number, rows: number) => Uint8ClampedArray | Promise<Uint8ClampedArray>
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  CRC_TABLE[index] = value >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(data.length + 12)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(new TextEncoder().encode(type), 4)
  chunk.set(data, 8)
  let crc = 0xffffffff
  for (let index = 4; index < data.length + 8; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ chunk[index]) & 255]
  }
  view.setUint32(data.length + 8, (crc ^ 0xffffffff) >>> 0)
  return chunk
}

export async function encodePngFromStripes(options: PngStripesOptions): Promise<Blob> {
  const { width, height, dpi, stripeHeight, renderStripe } = options
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(stripeHeight) ||
    width <= 0 || height <= 0 || stripeHeight <= 0 || dpi <= 0) throw new Error('PNG 导出尺寸无效。')
  if (typeof CompressionStream === 'undefined') throw new Error('当前浏览器不支持高 DPI 分块导出，请更新浏览器。')

  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header[8] = 8
  header[9] = 6
  const density = new Uint8Array(9)
  const densityView = new DataView(density.buffer)
  const pixelsPerMeter = dpiToPixelsPerMeter(dpi)
  densityView.setUint32(0, pixelsPerMeter)
  densityView.setUint32(4, pixelsPerMeter)
  density[8] = 1

  let nextRow = 0
  let stripeTop = 0
  let stripeRows = 0
  let stripePixels: Uint8ClampedArray | null = null
  const rawRows = new ReadableStream<BufferSource>({
    async pull(controller) {
      if (nextRow >= height) { controller.close(); return }
      if (!stripePixels) {
        stripeTop = nextRow
        stripeRows = Math.min(stripeHeight, height - nextRow)
        stripePixels = await renderStripe(stripeTop, stripeRows)
        if (stripePixels.length !== width * stripeRows * 4) throw new Error('分块渲染的像素尺寸不正确。')
      }
      const start = (nextRow - stripeTop) * width * 4
      const scanline = new Uint8Array(width * 4 + 1)
      scanline.set(stripePixels.subarray(start, start + width * 4), 1)
      controller.enqueue(scanline)
      nextRow += 1
      if (nextRow >= stripeTop + stripeRows) stripePixels = null
    },
  })

  const parts: BlobPart[] = [PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('pHYs', density)]
  const reader = rawRows.pipeThrough(new CompressionStream('deflate')).getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.length) parts.push(pngChunk('IDAT', value))
    }
  } finally {
    reader.releaseLock()
  }
  parts.push(pngChunk('IEND', new Uint8Array()))
  return new Blob(parts, { type: 'image/png' })
}
