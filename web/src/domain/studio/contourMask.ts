import { rotatedBounds } from './assetGeometry'

// Conservative half-millimeter cells, independent of export DPI.
export const CONTOUR_CELL_MM = 0.5
export type ContourRow = [number, number] | null // [left, right), filling internal holes
export interface ContourMask { width: number; rows: ContourRow[] }

export function alphaRowsFromRgba(rgba: Uint8ClampedArray, width: number, height: number): ContourRow[] {
  const rows: ContourRow[] = []
  for (let y = 0; y < height; y += 1) {
    let left = width
    let right = 0
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3]) {
        left = Math.min(left, x)
        right = x + 1
      }
    }
    rows.push(right > left ? [left, right] : null)
  }
  return rows
}

export function projectContour(source: ContourMask, widthMm: number, heightMm: number, rotationDeg: number, ratioLocked: boolean): ContourMask | undefined {
  const bounds = rotatedBounds(widthMm, heightMm, rotationDeg)
  const columns = Math.ceil(bounds.widthMm / CONTOUR_CELL_MM)
  const rows: ContourRow[] = Array(Math.ceil(bounds.heightMm / CONTOUR_CELL_MM)).fill(null)
  const scale = Math.min(widthMm / source.width, heightMm / source.rows.length)
  const drawWidth = ratioLocked ? source.width * scale : widthMm
  const drawHeight = ratioLocked ? source.rows.length * scale : heightMm
  const cos = Math.cos(rotationDeg * Math.PI / 180)
  const sin = Math.sin(rotationDeg * Math.PI / 180)
  const point = (x: number, y: number): [number, number] => {
    const dx = x / source.width * drawWidth - drawWidth / 2
    const dy = y / source.rows.length * drawHeight - drawHeight / 2
    return [bounds.widthMm / 2 + dx * cos - dy * sin, bounds.heightMm / 2 + dx * sin + dy * cos]
  }
  // Each native pixel row span becomes a quadrilateral. Intersect it with grid
  // row bands: unlike image downsampling, this cannot discard a fine feature.
  for (const [y, span] of source.rows.entries()) {
    if (!span) continue
    const polygon = [point(span[0], y), point(span[1], y), point(span[1], y + 1), point(span[0], y + 1)]
    const top = Math.max(0, Math.floor(Math.min(...polygon.map((p) => p[1])) / CONTOUR_CELL_MM + 1e-7))
    const bottom = Math.min(rows.length, Math.ceil(Math.max(...polygon.map((p) => p[1])) / CONTOUR_CELL_MM - 1e-7))
    for (let rowIndex = top; rowIndex < bottom; rowIndex += 1) {
      const low = rowIndex * CONTOUR_CELL_MM
      const high = low + CONTOUR_CELL_MM
      const xs: number[] = []
      for (const [index, a] of polygon.entries()) {
        const b = polygon[(index + 1) % polygon.length]
        if (a[1] >= low - 1e-9 && a[1] <= high + 1e-9) xs.push(a[0])
        if (Math.abs(b[1] - a[1]) < 1e-12) continue
        for (const edge of [low, high]) {
          const t = (edge - a[1]) / (b[1] - a[1])
          if (t >= 0 && t <= 1) xs.push(a[0] + (b[0] - a[0]) * t)
        }
      }
      if (!xs.length) continue
      const left = Math.max(0, Math.floor(Math.min(...xs) / CONTOUR_CELL_MM + 1e-7))
      const right = Math.min(columns, Math.ceil(Math.max(...xs) / CONTOUR_CELL_MM - 1e-7))
      if (left >= right) continue
      const previous = rows[rowIndex]
      rows[rowIndex] = [Math.min(previous?.[0] ?? columns, left), Math.max(previous?.[1] ?? 0, right)]
    }
  }
  if (!rows.some(Boolean) || rows.every((row) => row && row[0] === 0 && row[1] === columns)) return undefined
  return { width: columns, rows }
}
