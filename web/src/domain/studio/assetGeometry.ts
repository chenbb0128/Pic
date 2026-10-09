export interface AssetSizeMm { widthMm: number; heightMm: number }

export function fitSizeMm(widthPx: number, heightPx: number, longEdgeMm: number): AssetSizeMm {
  if (widthPx <= 0 || heightPx <= 0 || longEdgeMm <= 0) throw new Error('图片尺寸无效。')
  const scale = longEdgeMm / Math.max(widthPx, heightPx)
  return {
    widthMm: Math.round(widthPx * scale * 10) / 10,
    heightMm: Math.round(heightPx * scale * 10) / 10,
  }
}

export function resizeAssetSize(size: AssetSizeMm, widthPx: number, heightPx: number, edge: keyof AssetSizeMm, valueMm: number, locked: boolean): AssetSizeMm {
  if (!Number.isFinite(valueMm) || valueMm <= 0 || widthPx <= 0 || heightPx <= 0) throw new Error('请输入有效的图片尺寸。')
  if (!locked) return { ...size, [edge]: valueMm }
  const scale = edge === 'widthMm' ? valueMm / widthPx : valueMm / heightPx
  return {
    widthMm: Math.round(widthPx * scale * 10) / 10,
    heightMm: Math.round(heightPx * scale * 10) / 10,
  }
}

export function rotatedBounds(widthMm: number, heightMm: number, angleDeg: number): AssetSizeMm {
  const radians = angleDeg * Math.PI / 180
  const cosine = Math.abs(Math.cos(radians))
  const sine = Math.abs(Math.sin(radians))
  return {
    widthMm: Math.round((widthMm * cosine + heightMm * sine) * 1000) / 1000,
    heightMm: Math.round((heightMm * cosine + widthMm * sine) * 1000) / 1000,
  }
}
