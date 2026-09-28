import type { AssetRecord } from '../domain/assets/types'
import { ARTBOARD_MM } from '../domain/layout/constants'
import type { LayoutConfig } from '../domain/layout/types'
import { calculateSlots } from '../domain/layout/slotCalculator'
import { renderLayout } from './canvasRenderer'

export interface ExportOptions {
  config: LayoutConfig
  dpi: number
  assets2: AssetRecord[]
  assets3: AssetRecord[]
}

export interface ExportResult {
  blob: Blob
  width: number
  height: number
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG 编码失败。'))), 'image/png')
  })
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
}

function concatU8(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  parts.forEach((part) => {
    output.set(part, offset)
    offset += part.length
  })
  return output
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function dpiToPixelsPerMeter(dpi: number): number {
  return Math.round(dpi / 0.0254)
}

export async function setPngDpi(blob: Blob, dpi: number): Promise<Blob> {
  const source = new Uint8Array(await blob.arrayBuffer())
  const signature = source.slice(0, 8)
  let position = 8
  let inserted = false
  const chunks: Uint8Array[] = []
  const type = new TextEncoder().encode('pHYs')
  const data = concatU8([u32be(dpiToPixelsPerMeter(dpi)), u32be(dpiToPixelsPerMeter(dpi)), new Uint8Array([1])])
  const phys = concatU8([u32be(9), type, data, u32be(crc32(concatU8([type, data])))])

  while (position < source.length) {
    const length = ((source[position] << 24) | (source[position + 1] << 16) | (source[position + 2] << 8) | source[position + 3]) >>> 0
    const end = position + 12 + length
    const chunkType = String.fromCharCode(source[position + 4], source[position + 5], source[position + 6], source[position + 7])
    if (chunkType !== 'pHYs') chunks.push(source.slice(position, end))
    if (chunkType === 'IHDR' && !inserted) {
      chunks.push(phys)
      inserted = true
    }
    position = end
  }

  const output = concatU8([signature, ...chunks])
  const buffer = new ArrayBuffer(output.byteLength)
  new Uint8Array(buffer).set(output)
  return new Blob([buffer], { type: 'image/png' })
}

export async function exportLayoutPng(options: ExportOptions): Promise<ExportResult> {
  const width = Math.round((ARTBOARD_MM.width / 25.4) * options.dpi)
  const height = Math.round((ARTBOARD_MM.height / 25.4) * options.dpi)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) throw new Error('当前浏览器无法创建 Canvas。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const layout = calculateSlots(options.config)
  renderLayout(context, width, height, layout, options.assets2, options.assets3)
  const blob = await setPngDpi(await canvasBlob(canvas), options.dpi)
  return { blob, width, height }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
