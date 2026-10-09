import { setPngDpi } from './pngExporter'
import { encodePngFromStripes } from './tiledPng'

export interface LocalImage {
  id: string
  name: string
  url: string
  image: HTMLImageElement
  width: number
  height: number
}

export async function loadLocalImage(file: File): Promise<LocalImage> {
  if (!['image/png', 'image/webp', 'image/jpeg'].includes(file.type)) {
    throw new Error(`${file.name} 不是 PNG、WebP 或 JPG 图片。`)
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error(`${file.name} 无法读取。`))
      if (image.complete && image.naturalWidth > 0) resolve()
      image.src = url
    })
    if (typeof image.decode === 'function') await image.decode()
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `studio-${Date.now()}-${Math.random().toString(16).slice(2)}`
    return { id, name: file.name, url, image, width: image.naturalWidth, height: image.naturalHeight }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

export function drawImageContained(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight)
}

export async function canvasPng(canvas: HTMLCanvasElement, dpi: number): Promise<Blob> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG 编码失败，请降低 DPI 后重试。')), 'image/png')
  })
  return setPngDpi(blob, dpi)
}

export async function tiledCanvasPng(
  width: number,
  height: number,
  dpi: number,
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void,
  onProgress?: (completedRows: number, totalRows: number) => void,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true })
  if (!context) throw new Error('浏览器无法创建分块画布。')
  const tileWidth = 2048
  const stripeHeight = 128
  try {
    return await encodePngFromStripes({
      width, height, dpi, stripeHeight,
      renderStripe: async (top, rows) => {
        const stripe = new Uint8ClampedArray(width * rows * 4)
        for (let left = 0; left < width; left += tileWidth) {
          const columns = Math.min(tileWidth, width - left)
          canvas.width = columns
          canvas.height = rows
          context.setTransform(1, 0, 0, 1, -left, -top)
          draw(context, width, height)
          const pixels = context.getImageData(0, 0, columns, rows).data
          for (let row = 0; row < rows; row += 1) {
            stripe.set(pixels.subarray(row * columns * 4, (row + 1) * columns * 4), (row * width + left) * 4)
          }
        }
        onProgress?.(top + rows, height)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        return stripe
      },
    })
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

export function downloadBlob(url: string, name: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
}
