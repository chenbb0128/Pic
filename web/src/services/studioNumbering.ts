import type { PaperSize } from '../domain/studio/layout'

export function numberedPaper(paper: PaperSize, enabled: boolean): PaperSize {
  return { widthMm: paper.widthMm, heightMm: paper.heightMm + (enabled ? 3 : 0) }
}

export function drawStudioFooter(context: CanvasRenderingContext2D, width: number, height: number,
  paper: PaperSize, enabled: boolean, text: string): void {
  if (!enabled || !text) return
  const scaleX = width / paper.widthMm
  const scaleY = height / numberedPaper(paper, enabled).heightMm
  const contentHeight = paper.heightMm * scaleY
  const maxWidth = Math.max(1, width - 2 * scaleX)
  let fontSize = 1.8 * scaleY
  // Preserve the caller's transform, including the offset used by tiled exports.
  context.save()
  context.beginPath()
  context.rect(0, contentHeight, width, height - contentHeight)
  context.clip()
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
  context.fillText(text, scaleX, (paper.heightMm + 1.5) * scaleY)
  context.restore()
}
