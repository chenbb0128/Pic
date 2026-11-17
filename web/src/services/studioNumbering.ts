import type { PaperSize } from '../domain/studio/layout'

export const FOOTER_PREFIXES = ['ch', 'yy', 'x'] as const
export type FooterPrefix = (typeof FOOTER_PREFIXES)[number]
export const DEFAULT_FOOTER_PREFIX: FooterPrefix = 'ch'
export type NumberingSide = 'top' | 'bottom' | 'left' | 'right'

// Bold usage note printed centered on the numbering strip of every exported sheet.
export const FOOTER_INSTRUCTION = '使用说明：单个剪裁使用，具体操作可咨询'

export function normalizeFooterPrefix(value: unknown): FooterPrefix {
  return FOOTER_PREFIXES.includes(value as FooterPrefix) ? value as FooterPrefix : DEFAULT_FOOTER_PREFIX
}

// Sheet counts are optional 1–999 integers; anything else reads as "not filled".
export function normalizeSheetCount(value: unknown): number | '' {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num < 1) return ''
  return Math.min(999, Math.floor(num))
}

// The prefix, today's date and optional sheet counts are part of the printed number,
// e.g. ch-20261109-0125 共3张·第1张; blank numbers stay blank.
export function composeFooterText(prefix: string | undefined, text: string,
  sheets?: { total?: number | ''; index?: number | '' }, date: Date = new Date()): string {
  if (!text) return ''
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replace(/-/g, '')
  const base = `${normalizeFooterPrefix(prefix)}-${stamp}-${text}`
  const total = normalizeSheetCount(sheets?.total)
  const index = normalizeSheetCount(sheets?.index)
  return total === '' || index === '' ? base : `${base} 共${total}张·第${index}张`
}

export function numberedPaper(paper: PaperSize, enabled: boolean): PaperSize {
  const right = paper.widthMm > paper.heightMm
  return { widthMm: paper.widthMm + (enabled && right ? 3 : 0), heightMm: paper.heightMm + (enabled && !right ? 3 : 0) }
}

export function drawStudioFooter(context: CanvasRenderingContext2D, width: number, height: number,
  paper: PaperSize, enabled: boolean, text: string,
  options?: { side: NumberingSide; stripMm: number }): void {
  if (!enabled || !text) return
  const side = options?.side ?? (paper.widthMm > paper.heightMm ? 'right' : 'bottom')
  const stripMm = options?.stripMm ?? 3
  const vertical = side === 'right' || side === 'left'
  const output = { widthMm: paper.widthMm + (vertical ? stripMm : 0), heightMm: paper.heightMm + (vertical ? 0 : stripMm) }
  const scaleX = width / output.widthMm
  const scaleY = height / output.heightMm
  const contentWidth = paper.widthMm * scaleX
  const contentHeight = paper.heightMm * scaleY
  const padding = vertical ? scaleY : scaleX
  const stripLength = vertical ? height : width
  const maxWidth = Math.max(1, stripLength - 2 * padding)
  const baseline = vertical ? 0 : (side === 'top' ? stripMm / 2 : paper.heightMm + stripMm / 2) * scaleY
  const family = '"PingFang SC","Microsoft YaHei",sans-serif'
  const baseFontSize = Math.min(1.8, stripMm * .6) * (vertical ? scaleX : scaleY)
  let fontSize = baseFontSize
  // Preserve the caller's transform, including the offset used by tiled exports.
  context.save()
  context.beginPath()
  if (vertical) context.rect(side === 'left' ? 0 : contentWidth, 0, width - contentWidth, height)
  else context.rect(0, side === 'top' ? 0 : contentHeight, width, height - contentHeight)
  context.clip()
  if (vertical) {
    context.translate((side === 'left' ? stripMm / 2 : paper.widthMm + stripMm / 2) * scaleX, side === 'left' ? height : 0)
    context.rotate(side === 'left' ? -Math.PI / 2 : Math.PI / 2)
  }
  context.fillStyle = '#28252d'
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.direction = 'ltr'
  const font = () => `400 ${fontSize}px ${family}`
  context.font = font()
  const measured = context.measureText(text).width
  if (measured > maxWidth) {
    fontSize *= maxWidth / measured
    context.font = font()
  }
  context.fillText(text, padding, baseline)
  drawFooterInstruction(context, family, baseFontSize, stripLength, padding, maxWidth, measured, baseline, font())
  context.restore()
}

// Bold note centered on the strip; shifts past the number and shrinks rather than overlapping it.
function drawFooterInstruction(context: CanvasRenderingContext2D, family: string, baseFontSize: number,
  stripLength: number, padding: number, maxWidth: number, numberWidth: number, baseline: number, numberFont: string): void {
  let noteSize = baseFontSize
  const noteFont = () => `700 ${noteSize}px ${family}`
  context.font = noteFont()
  let noteWidth = context.measureText(FOOTER_INSTRUCTION).width
  const numberEnd = padding + Math.min(numberWidth, maxWidth)
  const stripEnd = stripLength - padding
  let left = Math.max(stripLength / 2 - noteWidth / 2, numberEnd + padding)
  const available = stripEnd - left
  if (available <= 0) {
    // Real canvases restore via save(); keep the mock-visible font on the number for tests.
    context.font = numberFont
    return
  }
  if (noteWidth > available) {
    noteSize *= available / noteWidth
    context.font = noteFont()
    noteWidth = context.measureText(FOOTER_INSTRUCTION).width
    left = stripEnd - noteWidth
  }
  context.textAlign = 'center'
  context.fillText(FOOTER_INSTRUCTION, left + noteWidth / 2, baseline)
}
