export interface PreviewWatermark {
  enabled: boolean
  text: string
  opacity: number
}

export function drawPreviewWatermark(context: CanvasRenderingContext2D, width: number, height: number, settings: PreviewWatermark): void {
  if (!settings.enabled || width <= 0 || height <= 0) return
  const text = settings.text.trim().slice(0, 40) || '仅供确认 · 禁止盗用'
  const opacity = Math.max(8, Math.min(50, Number(settings.opacity) || 20)) / 100
  const scale = Math.max(width, height) / 1200
  const stepX = Math.max(180, text.length * 18 + 24) * scale
  const stepY = 90 * scale
  context.save()
  context.fillStyle = `rgba(102,112,133,${opacity})`
  context.font = `600 ${18 * scale}px sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  for (let y = -stepY / 2; y < height + stepY; y += stepY) {
    for (let x = -stepX / 2; x < width + stepX; x += stepX) {
      context.save()
      context.translate(x, y)
      context.rotate(-25 * Math.PI / 180)
      context.fillText(text, 0, 0)
      context.restore()
    }
  }
  context.restore()
}
