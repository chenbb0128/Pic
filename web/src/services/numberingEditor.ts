import { drawStudioFooter, type NumberingSide } from './studioNumbering'
import type { LocalImage } from './studioImage'

export interface NumberingEdit {
  dpi: number
  stripMm: number
  side: NumberingSide
  text: string
}

export function numberingRegion(width: number, height: number, dpi: number, stripMm: number, side: NumberingSide) {
  if (![width, height, dpi, stripMm].every(Number.isFinite) || width <= 0 || height <= 0 || dpi <= 0 || stripMm <= 0) {
    throw new Error('请填写有效的图片 DPI 和编号区大小。')
  }
  if (!['top', 'bottom', 'left', 'right'].includes(side)) throw new Error('请选择编号位置。')
  const vertical = side === 'left' || side === 'right'
  const thickness = Math.max(1, Math.round(stripMm / 25.4 * dpi))
  if (thickness >= (vertical ? width : height)) throw new Error('编号区不能覆盖整张图片，请减小区域大小或检查 DPI。')
  return {
    x: side === 'right' ? width - thickness : 0,
    y: side === 'bottom' ? height - thickness : 0,
    width: vertical ? thickness : width,
    height: vertical ? height : thickness,
  }
}

// Draw at source resolution first so exports and scaled previews share the same strip boundary.
// Keep the caller's transform for tiled PNG export; only pixels inside the strip are cleared.
export function drawRenumberedImage(context: CanvasRenderingContext2D,
  source: Pick<LocalImage, 'image' | 'width' | 'height'>, width: number, height: number, edit: NumberingEdit): void {
  const region = numberingRegion(source.width, source.height, edit.dpi, edit.stripMm, edit.side)
  const vertical = edit.side === 'left' || edit.side === 'right'
  const mmPerPx = 25.4 / edit.dpi
  context.save()
  context.scale(width / source.width, height / source.height)
  context.drawImage(source.image, 0, 0)
  context.clearRect(region.x, region.y, region.width, region.height)
  drawStudioFooter(context, source.width, source.height, {
    widthMm: (source.width - (vertical ? region.width : 0)) * mmPerPx,
    heightMm: (source.height - (vertical ? 0 : region.height)) * mmPerPx,
  }, true, edit.text, { side: edit.side, stripMm: (vertical ? region.width : region.height) * mmPerPx })
  context.restore()
}
