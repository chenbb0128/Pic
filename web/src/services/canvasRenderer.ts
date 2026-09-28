import { ARTBOARD_MM } from '../domain/layout/constants'
import type { AssetRecord } from '../domain/assets/types'
import type { LayoutResult, StickerSlot } from '../domain/layout/types'

function fitImage(image: HTMLImageElement, sizePx: number) {
  const ratio = image.naturalWidth / image.naturalHeight
  if (ratio >= 1) return { width: sizePx, height: sizePx / ratio }
  return { width: sizePx * ratio, height: sizePx }
}

function drawHighQuality(
  target: CanvasRenderingContext2D,
  image: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  target.save()
  target.imageSmoothingEnabled = true
  target.imageSmoothingQuality = 'high'
  const ratio = Math.max(image.naturalWidth / dw, image.naturalHeight / dh)
  if (ratio > 2.2) {
    let source: CanvasImageSource = image
    let sourceWidth = image.naturalWidth
    let sourceHeight = image.naturalHeight
    while (sourceWidth / 2 > dw * 1.35 && sourceHeight / 2 > dh * 1.35) {
      const width = Math.max(Math.ceil(dw), Math.floor(sourceWidth / 2))
      const height = Math.max(Math.ceil(dh), Math.floor(sourceHeight / 2))
      const buffer = document.createElement('canvas')
      buffer.width = width
      buffer.height = height
      const bufferContext = buffer.getContext('2d')
      if (!bufferContext) break
      bufferContext.imageSmoothingEnabled = true
      bufferContext.imageSmoothingQuality = 'high'
      bufferContext.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height)
      source = buffer
      sourceWidth = width
      sourceHeight = height
    }
    target.drawImage(source, 0, 0, sourceWidth, sourceHeight, dx, dy, dw, dh)
  } else {
    target.drawImage(image, dx, dy, dw, dh)
  }
  target.restore()
}

function drawGroup(
  target: CanvasRenderingContext2D,
  slots: StickerSlot[],
  assets: AssetRecord[],
  sx: number,
  sy: number,
): void {
  if (!assets.length) return
  slots.forEach((slot, index) => {
    const image = assets[index % assets.length].image
    const box = slot.sizeMm * Math.min(sx, sy)
    const fitted = fitImage(image, box)
    const centerX = (slot.xMm + slot.sizeMm / 2) * sx
    const centerY = (slot.yMm + slot.sizeMm / 2) * sy
    drawHighQuality(target, image, centerX - fitted.width / 2, centerY - fitted.height / 2, fitted.width, fitted.height)
  })
}

export interface RenderOptions {
  guides?: boolean
}

export function renderLayout(
  target: CanvasRenderingContext2D,
  width: number,
  height: number,
  layout: LayoutResult,
  assets2: AssetRecord[],
  assets3: AssetRecord[],
  options: RenderOptions = {},
): void {
  target.clearRect(0, 0, width, height)
  if (!layout.valid) return
  const sx = width / ARTBOARD_MM.width
  const sy = height / ARTBOARD_MM.height
  drawGroup(target, layout.slots2, assets2, sx, sy)
  drawGroup(target, layout.slots3, assets3, sx, sy)

  if (!options.guides) return
  target.save()
  target.lineWidth = 1.2
  layout.slots2.forEach((slot) => {
    target.strokeStyle = 'rgba(37,99,235,.30)'
    target.strokeRect(slot.xMm * sx, slot.yMm * sy, slot.sizeMm * sx, slot.sizeMm * sy)
  })
  layout.slots3.forEach((slot) => {
    target.strokeStyle = 'rgba(219,39,119,.30)'
    target.strokeRect(slot.xMm * sx, slot.yMm * sy, slot.sizeMm * sx, slot.sizeMm * sy)
  })
  target.restore()
}
