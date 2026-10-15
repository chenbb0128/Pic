import { afterEach, describe, expect, it, vi } from 'vitest'
import { creativeFonts, ensureCreativeFont, creativeFontCss } from './creativeFonts'

afterEach(() => { vi.unstubAllGlobals() })

describe('creative fonts', () => {
  it('loads a selected font once and waits before making it available to canvas', async () => {
    let finish!: () => void
    const registered: unknown[] = []
    const sources: string[] = []
    class Face {
      constructor(public family: string, source: string) { sources.push(source) }
      load() { return new Promise<this>(resolve => { finish = () => resolve(this) }) }
    }
    vi.stubGlobal('FontFace', Face)
    vi.stubGlobal('document', { fonts: { add: (face: unknown) => registered.push(face) } })
    const font = creativeFonts.find(font => font.id === 'kuaile')!
    const first = ensureCreativeFont(font.value)
    const second = ensureCreativeFont(font.value)
    expect(registered).toHaveLength(0)
    finish()
    await Promise.all([first, second])
    expect(sources).toEqual(['url("/fonts/ZCOOLKuaiLe-Regular.ttf")'])
    expect(registered).toHaveLength(1)
    expect(creativeFontCss(font.value, 30)).toBe('400 30px "StickerKuaiLe", sans-serif')
  })

  it('allows retry after a font download fails instead of silently using a fallback', async () => {
    let attempts = 0
    class Face {
      load() { return ++attempts === 1 ? Promise.reject(new Error('network')) : Promise.resolve(this) }
    }
    const registered: unknown[] = []
    vi.stubGlobal('FontFace', Face)
    vi.stubGlobal('document', { fonts: { add: (face: unknown) => registered.push(face) } })
    const font = creativeFonts.find(font => font.id === 'huangyou')!
    await expect(ensureCreativeFont(font.value)).rejects.toThrow('字体加载失败')
    await ensureCreativeFont(font.value)
    expect(registered).toHaveLength(1)
  })

  it('keeps system fonts usable without downloading assets', async () => {
    await ensureCreativeFont('Arial, sans-serif')
    expect(creativeFontCss('Arial, sans-serif', 24)).toBe('700 24px Arial, sans-serif')
  })
})
