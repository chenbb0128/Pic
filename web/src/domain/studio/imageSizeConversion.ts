export interface ImageSizePreset {
  value: 'A3' | 'A4' | 'A5' | 'A6' | 'A7'
  label: string
  widthMm: number
  heightMm: number
}

export const imageSizePresets: ImageSizePreset[] = [
  { value: 'A3', label: 'A3', widthMm: 293, heightMm: 420 },
  { value: 'A4', label: 'A4', widthMm: 293, heightMm: 210 },
  { value: 'A5', label: 'A5', widthMm: 144, heightMm: 210 },
  { value: 'A6', label: 'A6', widthMm: 144, heightMm: 105 },
  { value: 'A7', label: 'A7', widthMm: 72, heightMm: 105 },
]

export function outputPixelSize(preset: ImageSizePreset, dpi: number): { width: number; height: number } {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error('DPI 必须大于 0。')
  return {
    width: Math.round(preset.widthMm / 25.4 * dpi),
    height: Math.round(preset.heightMm / 25.4 * dpi),
  }
}

export interface ContainRect { x: number; y: number; width: number; height: number }

export function containRect(sourceWidth: number, sourceHeight: number, canvasWidth: number, canvasHeight: number): ContainRect {
  if ([sourceWidth, sourceHeight, canvasWidth, canvasHeight].some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('图片或画布尺寸无效。')
  }
  const scale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  }
}
