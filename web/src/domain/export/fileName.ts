import type { LayoutMode } from '../layout/types'

export function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\.png$/i, '')
}

export function buildExportFileName(
  customName: string,
  mode: LayoutMode,
  dpi: number,
  width: number,
  height: number,
): string {
  const safe = sanitizeFileName(customName.trim())
  if (safe) return `${safe}.png`
  const label = mode === 'full2' ? '2CM铺满' : mode === 'full3' ? '3CM铺满' : '2CM48_3CM24'
  return `转印贴_${label}_${dpi}dpi_${width}x${height}_透明.png`
}
