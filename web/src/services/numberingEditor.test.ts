import { describe, expect, it, vi } from 'vitest'
import { numberingRegion, drawRenumberedImage } from './numberingEditor'
import { FOOTER_INSTRUCTION } from './studioNumbering'

describe('重写成品图片编号区', () => {
  it.each([
    ['bottom', { x: 0, y: 2100, width: 1440, height: 30 }],
    ['top', { x: 0, y: 0, width: 1440, height: 30 }],
    ['left', { x: 0, y: 0, width: 30, height: 2130 }],
    ['right', { x: 1410, y: 0, width: 30, height: 2130 }],
  ] as const)('按 DPI 在 %s 覆盖指定毫米宽度', (side, expected) => {
    expect(numberingRegion(1440, 2130, 254, 3, side)).toEqual(expected)
  })

  it('支持小数条宽，并拒绝无效 DPI、尺寸及覆盖整张图', () => {
    expect(numberingRegion(1440, 2130, 254, 4.5, 'bottom').height).toBe(45)
    for (const [dpi, mm] of [[0, 3], [NaN, 3], [254, 0], [254, -1], [254, 300]]) {
      expect(() => numberingRegion(1440, 2130, dpi, mm, 'bottom')).toThrow()
    }
  })

  it.each(['bottom', 'top', 'left', 'right'] as const)('仅清理 %s 编号条，保持图像位置并复用编号和使用说明样式', side => {
    const ctx = { save: vi.fn(), restore: vi.fn(), scale: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn(),
      beginPath() {}, rect: vi.fn(), clip() {}, translate: vi.fn(), rotate: vi.fn(),
      measureText: () => ({ width: 50 }), fillText: vi.fn() }
    const image = { width: 1440, height: 2130, image: {} as HTMLImageElement }
    drawRenumberedImage(ctx as unknown as CanvasRenderingContext2D, image, 1440, 2130,
      { dpi: 254, stripMm: 3, side, text: 'ch-20261118-0125 共3张·第1张' })
    const r = numberingRegion(1440, 2130, 254, 3, side)
    expect(ctx.drawImage).toHaveBeenCalledWith(image.image, 0, 0)
    expect(ctx.clearRect).toHaveBeenCalledExactlyOnceWith(r.x, r.y, r.width, r.height)
    expect(ctx.fillText.mock.calls[0][0]).toBe('ch-20261118-0125 共3张·第1张')
    expect(ctx.fillText.mock.calls[1][0]).toBe(FOOTER_INSTRUCTION)
    expect(ctx.rect).toHaveBeenCalledWith(r.x, r.y, r.width, r.height)
    expect(ctx.scale).toHaveBeenCalledWith(1, 1)
    if (side === 'left') expect(ctx.rotate).toHaveBeenCalledWith(-Math.PI / 2)
    if (side === 'right') expect(ctx.rotate).toHaveBeenCalledWith(Math.PI / 2)
  })
})
