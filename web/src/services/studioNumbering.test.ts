import { describe, expect, it, vi } from 'vitest'
import { drawStudioFooter, numberedPaper } from './studioNumbering'

describe('底部编号绘制', () => {
  it('adds 3mm without changing the content paper', () => {
    const paper = { widthMm: 293, heightMm: 210 }
    expect(numberedPaper(paper, true)).toEqual({ widthMm: 293, heightMm: 213 })
    expect(numberedPaper(paper, false)).toEqual({ widthMm: 293, heightMm: 210 })
    expect(paper).toEqual({ widthMm: 293, heightMm: 210 })
  })

  it('clips text to the extra footer and shrinks long labels without resetting tile transforms', () => {
    const context = { save: vi.fn(), restore: vi.fn(), beginPath() {}, rect: vi.fn(), clip: vi.fn(),
      measureText: () => ({ width: 2000 }), fillText: vi.fn(), font: '', resetTransform: vi.fn() }
    drawStudioFooter(context as unknown as CanvasRenderingContext2D, 1000, 1030, { widthMm: 100, heightMm: 100 }, true, '订单编号')
    expect(context.rect).toHaveBeenCalledWith(0, 1000, 1000, 30)
    expect(context.fillText).toHaveBeenCalledWith('订单编号', 10, 1015)
    expect(context.font).toContain('8.82px')
    expect(context.resetTransform).not.toHaveBeenCalled()
    expect(context.restore).toHaveBeenCalledOnce()
  })

  it('does not draw disabled or blank labels', () => {
    const context = { save: vi.fn() }
    for (const [enabled, text] of [[false, '订单'], [true, '']] as const) {
      drawStudioFooter(context as unknown as CanvasRenderingContext2D, 1000, 1030, { widthMm: 100, heightMm: 100 }, enabled, text)
    }
    expect(context.save).not.toHaveBeenCalled()
  })
})
