import { rotatedBounds } from '../domain/studio/assetGeometry'
import { alphaRowsFromRgba, projectContour, type ContourMask, type ContourRow } from '../domain/studio/contourMask'

const cache = new WeakMap<HTMLImageElement, Map<string, ContourMask | undefined>>()
const originals = new WeakMap<HTMLImageElement, ContourMask>()

function originalContour(image: HTMLImageElement): ContourMask {
  const cached = originals.get(image)
  if (cached) return cached
  const rows: ContourRow[] = Array(image.naturalHeight).fill(null)
  const canvas = document.createElement('canvas')
  // Read native pixels in small tiles: no resampling and no full-size canvas.
  canvas.width = Math.min(2048, image.naturalWidth)
  canvas.height = Math.min(64, image.naturalHeight)
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('无法读取图案轮廓。')
    for (let top = 0; top < image.naturalHeight; top += canvas.height) {
      const height = Math.min(canvas.height, image.naturalHeight - top)
      for (let left = 0; left < image.naturalWidth; left += canvas.width) {
        const width = Math.min(canvas.width, image.naturalWidth - left)
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, left, top, width, height, 0, 0, width, height)
        const tile = alphaRowsFromRgba(context.getImageData(0, 0, width, height).data, width, height)
        tile.forEach((span, index) => {
          if (!span) return
          const previous = rows[top + index]
          rows[top + index] = [Math.min(previous?.[0] ?? Infinity, left + span[0]), Math.max(previous?.[1] ?? 0, left + span[1])]
        })
      }
    }
  } finally {
    canvas.width = 1
    canvas.height = 1
  }
  const source = { width: image.naturalWidth, rows }
  originals.set(image, source)
  return source
}

export function imageContour(image: HTMLImageElement, widthMm: number, heightMm: number, rotationDeg: number, ratioLocked: boolean): ContourMask | undefined {
  const key = `${widthMm}:${heightMm}:${rotationDeg}:${ratioLocked}`
  let entries = cache.get(image)
  if (entries?.has(key)) return entries.get(key)
  const bounds = rotatedBounds(widthMm, heightMm, rotationDeg)
  if (![bounds.widthMm, bounds.heightMm].every((edge) => Number.isFinite(edge) && edge > 0 && edge <= 600)) return undefined
  let contour: ContourMask | undefined
  try {
    contour = projectContour(originalContour(image), widthMm, heightMm, rotationDeg, ratioLocked)
  } catch {
    // Unsupported pixel access safely falls back to the existing rectangle packing.
    contour = undefined
  }
  if (!entries) { entries = new Map(); cache.set(image, entries) }
  if (entries.size >= 8) entries.delete(entries.keys().next().value!)
  entries.set(key, contour)
  return contour
}
