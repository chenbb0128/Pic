import type { PaperSize } from '../domain/studio/layout'

export function numberedPaper(paper: PaperSize, enabled: boolean): PaperSize {
  const right = paper.widthMm > paper.heightMm
  return { widthMm: paper.widthMm + (enabled && right ? 3 : 0), heightMm: paper.heightMm + (enabled && !right ? 3 : 0) }
}

export function drawStudioFooter(context: CanvasRenderingContext2D, width: number, height: number,
  paper: PaperSize, enabled: boolean, text: string): void {
  if (!enabled || !text) return
  const output = numberedPaper(paper, enabled), right = paper.widthMm > paper.heightMm
  const scaleX = width / output.widthMm
  const scaleY = height / output.heightMm
  const contentWidth = paper.widthMm * scaleX
  const contentHeight = paper.heightMm * scaleY
  const padding = right ? scaleY : scaleX
  const maxWidth = Math.max(1, (right ? height : width) - 2 * padding)
  let fontSize = 1.8 * (right ? scaleX : scaleY)
  // Preserve the caller's transform, including the offset used by tiled exports.
  context.save()
  context.beginPath()
  if (right) context.rect(contentWidth, 0, width - contentWidth, height)
  else context.rect(0, contentHeight, width, height - contentHeight)
  context.clip()
  if (right) {
    context.translate((paper.widthMm + 1.5) * scaleX, 0)
    context.rotate(Math.PI / 2)
  }
  context.fillStyle = '#28252d'
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.direction = 'ltr'
  const font = () => `400 ${fontSize}px "PingFang SC","Microsoft YaHei",sans-serif`
  context.font = font()
  const measured = context.measureText(text).width
  if (measured > maxWidth) {
    fontSize *= maxWidth / measured
    context.font = font()
  }
  context.fillText(text, padding, right ? 0 : (paper.heightMm + 1.5) * scaleY)
  context.restore()
}
