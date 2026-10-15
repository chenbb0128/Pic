import type { LocalImage } from './studioImage'
import { creativeFontCss } from './creativeFonts'

export type CreativeKind = 'recolor' | 'polka' | 'frame' | 'name' | 'text'
export type FrameShape = 'circle' | 'heart' | 'rect' | 'rounded' | 'star'
export type PolkaShape = 'circle' | 'ring' | 'star' | 'heart' | 'hex'

export interface CreativeSettings {
  kind: CreativeKind
  image: LocalImage | null
  widthMm: number
  heightMm: number
  text: string
  font: string
  fontMm: number
  cellMm: number
  gapMm: number
  color: string
  secondColor: string
  thirdColor: string
  colorMode: 'solid' | 'gradient' | 'rainbow'
  pattern: 'grid' | 'random'
  polkaShape: PolkaShape
  dotMm: number
  seed: number
  frameShape: FrameShape
  frameFit: 'cover' | 'contain'
  frameZoom: number
  offsetX: number
  offsetY: number
  textEffect: 'none' | 'outline' | 'shadow' | 'glow'
}

function pathForShape(context: CanvasRenderingContext2D, shape: FrameShape | PolkaShape, x: number, y: number, width: number, height: number): void {
  const centerX = x + width / 2
  const centerY = y + height / 2
  context.beginPath()
  if (shape === 'circle' || shape === 'ring') {
    context.ellipse(centerX, centerY, width / 2, height / 2, 0, 0, Math.PI * 2)
  } else if (shape === 'rect') {
    context.rect(x, y, width, height)
  } else if (shape === 'rounded') {
    context.roundRect(x, y, width, height, Math.min(width, height) * 0.18)
  } else if (shape === 'heart') {
    context.moveTo(centerX, y + height)
    context.bezierCurveTo(x - width * 0.15, y + height * 0.55, x, y + height * 0.12, centerX, y + height * 0.32)
    context.bezierCurveTo(x + width, y + height * 0.12, x + width * 1.15, y + height * 0.55, centerX, y + height)
  } else {
    const points = shape === 'hex' ? 6 : 10
    for (let index = 0; index < points; index += 1) {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / points
      const radius = shape === 'hex' || index % 2 === 0 ? 0.5 : 0.22
      const px = centerX + Math.cos(angle) * width * radius
      const py = centerY + Math.sin(angle) * height * radius
      if (index === 0) context.moveTo(px, py)
      else context.lineTo(px, py)
    }
    context.closePath()
  }
}

function colorAt(settings: CreativeSettings, fraction: number): string {
  if (settings.colorMode === 'solid') return settings.color
  if (settings.colorMode === 'rainbow') return `hsl(${Math.round(fraction * 360)}, 90%, 55%)`
  return fraction < 0.5 ? settings.color : fraction < 0.8 ? settings.secondColor : settings.thirdColor
}

function drawPolka(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, settings: CreativeSettings): number {
  const pxPerMm = canvas.width / settings.widthMm
  const dot = Math.max(1, settings.dotMm * pxPerMm)
  const step = Math.max(dot + 1, (settings.dotMm + settings.gapMm) * pxPerMm)
  const columns = Math.floor(canvas.width / step)
  const rows = Math.floor(canvas.height / step)
  const total = Math.min(2000, columns * rows)
  for (let index = 0; index < total; index += 1) {
    const row = Math.floor(index / columns)
    const column = index % columns
    const random = (value: number) => {
      const seed = Math.sin(value * 12.9898 + settings.seed * 78.233) * 43758.5453
      return seed - Math.floor(seed)
    }
    const jitterX = settings.pattern === 'random' ? (random(index + 1) - 0.5) * step * 0.8 : 0
    const jitterY = settings.pattern === 'random' ? (random(index + 2) - 0.5) * step * 0.8 : 0
    const x = column * step + (canvas.width - columns * step) / 2 + jitterX
    const y = row * step + (canvas.height - rows * step) / 2 + jitterY
    context.fillStyle = colorAt(settings, index / Math.max(1, total - 1))
    context.strokeStyle = context.fillStyle
    context.lineWidth = Math.max(1, dot * 0.18)
    pathForShape(context, settings.polkaShape, x, y, dot, dot)
    if (settings.polkaShape === 'ring') context.stroke()
    else context.fill()
  }
  return total
}

function drawRecolor(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, settings: CreativeSettings): number {
  if (!settings.image) return 0
  context.drawImage(settings.image.image, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const data = pixels.data
  const first = parseInt(settings.color.slice(1), 16)
  const second = parseInt(settings.secondColor.slice(1), 16)
  for (let index = 0; index < data.length; index += 4) {
    if (!data[index + 3]) continue
    const x = (index / 4) % canvas.width
    const fraction = x / Math.max(1, canvas.width - 1)
    const hue = fraction * Math.PI * 2
    const mix = settings.colorMode === 'solid' ? 0 : fraction
    const red = settings.colorMode === 'rainbow' ? Math.round((Math.sin(hue) + 1) * 127) : Math.round(((first >> 16) & 255) * (1 - mix) + ((second >> 16) & 255) * mix)
    const green = settings.colorMode === 'rainbow' ? Math.round((Math.sin(hue + 2) + 1) * 127) : Math.round(((first >> 8) & 255) * (1 - mix) + ((second >> 8) & 255) * mix)
    const blue = settings.colorMode === 'rainbow' ? Math.round((Math.sin(hue + 4) + 1) * 127) : Math.round((first & 255) * (1 - mix) + (second & 255) * mix)
    const darkness = 1 - (data[index] + data[index + 1] + data[index + 2]) / 765
    data[index] = red
    data[index + 1] = green
    data[index + 2] = blue
    data[index + 3] = Math.round(data[index + 3] * darkness)
  }
  context.putImageData(pixels, 0, 0)
  return 1
}

function drawFrame(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, settings: CreativeSettings): number {
  const padding = Math.min(canvas.width, canvas.height) * 0.02
  const x = padding
  const y = padding
  const width = canvas.width - padding * 2
  const height = canvas.height - padding * 2
  context.save()
  pathForShape(context, settings.frameShape, x, y, width, height)
  context.clip()
  if (settings.image) {
    const image = settings.image.image
    const scale = (settings.frameFit === 'cover'
      ? Math.max(width / image.naturalWidth, height / image.naturalHeight)
      : Math.min(width / image.naturalWidth, height / image.naturalHeight)) * settings.frameZoom
    const drawWidth = image.naturalWidth * scale
    const drawHeight = image.naturalHeight * scale
    context.drawImage(image, x + (width - drawWidth) / 2 + settings.offsetX * width, y + (height - drawHeight) / 2 + settings.offsetY * height, drawWidth, drawHeight)
  }
  context.restore()
  return settings.image ? 1 : 0
}

function drawName(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, settings: CreativeSettings): number {
  const text = settings.text.trim()
  if (!text) return 0
  const pxPerMm = canvas.width / settings.widthMm
  const fontSize = settings.fontMm * pxPerMm
  context.font = creativeFontCss(settings.font, fontSize)
  context.textBaseline = 'middle'
  context.fillStyle = settings.color
  const textWidth = context.measureText(text).width
  const stepX = Math.max(1, textWidth + settings.gapMm * pxPerMm)
  const stepY = Math.max(1, fontSize * 1.2 + settings.gapMm * pxPerMm)
  let count = 0
  for (let y = stepY / 2; y + fontSize / 2 <= canvas.height && count < 1000; y += stepY) {
    for (let x = 0; x + textWidth <= canvas.width && count < 1000; x += stepX) {
      context.fillStyle = colorAt(settings, count / 100)
      context.fillText(text, x, y)
      count += 1
    }
  }
  return count
}

function drawTextGrid(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, settings: CreativeSettings): number {
  const lines = settings.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return 0
  const pxPerMm = canvas.width / settings.widthMm
  const cell = settings.cellMm * pxPerMm
  const columns = Math.floor(canvas.width / cell)
  const rows = Math.floor(canvas.height / cell)
  if (!columns || !rows) return 0
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = creativeFontCss(settings.font, settings.fontMm * pxPerMm)
  const total = Math.min(1000, columns * rows)
  for (let index = 0; index < total; index += 1) {
    const x = (index % columns + 0.5) * cell
    const y = (Math.floor(index / columns) + 0.5) * cell
    const text = lines[index % lines.length]
    context.fillStyle = settings.color
    context.strokeStyle = settings.secondColor
    context.lineWidth = Math.max(1, settings.fontMm * pxPerMm * 0.1)
    context.shadowBlur = settings.textEffect === 'glow' ? cell * 0.15 : settings.textEffect === 'shadow' ? cell * 0.08 : 0
    context.shadowColor = settings.secondColor
    if (settings.textEffect === 'outline') context.strokeText(text, x, y, cell * 0.9)
    context.fillText(text, x, y, cell * 0.9)
  }
  context.shadowBlur = 0
  return total
}

export function renderCreative(canvas: HTMLCanvasElement, settings: CreativeSettings): number {
  const context = canvas.getContext('2d', { alpha: true, willReadFrequently: settings.kind === 'recolor' })
  if (!context) throw new Error('浏览器无法创建画布。')
  context.clearRect(0, 0, canvas.width, canvas.height)
  if (settings.kind === 'recolor') return drawRecolor(context, canvas, settings)
  if (settings.kind === 'polka') return drawPolka(context, canvas, settings)
  if (settings.kind === 'frame') return drawFrame(context, canvas, settings)
  if (settings.kind === 'name') return drawName(context, canvas, settings)
  return drawTextGrid(context, canvas, settings)
}
