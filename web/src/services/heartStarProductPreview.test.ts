import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

const moduleUrl = new URL('../../public/embedded/heart-star/product-preview.js', import.meta.url)
const source = existsSync(moduleUrl) ? readFileSync(moduleUrl, 'utf8') : ''

function setup() {
  const calls: any[] = []
  const paint = {
    fillStyle: '', globalCompositeOperation: 'source-over',
    save() {}, restore() {}, translate() {}, rotate() {},
    drawImage(...args: any[]) { calls.push(['image', ...args]) },
    fillRect(...args: number[]) { calls.push(['fill', this.fillStyle, this.globalCompositeOperation, ...args]) },
    fillText(...args: any[]) { calls.push(['text', this.globalCompositeOperation, ...args]) },
  }
  const document = { createElement: () => ({ width: 0, height: 0, getContext: () => paint }) }
  const feature = new Function('globalThis', 'document', `${source};return globalThis.HeartStarProductPreview`)({}, document)
  expect(feature?.compose).toBeTypeOf('function')
  return { feature, calls }
}

describe('heart-star universal product images', () => {
  it.each([[144, 210], [210, 144]])('centers %s × %s artwork with equal padding and a 1600px long edge', (width, height) => {
    const { feature } = setup()
    const layout = feature.layout(width, height, 6)
    expect(Math.max(layout.width, layout.height)).toBe(1600)
    expect(layout.x).toBeCloseTo((layout.width - layout.artWidth) / 2)
    expect(layout.y).toBeCloseTo((layout.height - layout.artHeight) / 2)
    expect(layout.x).toBeCloseTo(layout.y, 0)
    expect(layout.artWidth / layout.artHeight).toBeCloseTo(width / height)
    expect(layout.x).toBeGreaterThan(0)
  })

  it('preserves the original artwork and alpha when exporting a clean transparent image', () => {
    const { feature, calls } = setup()
    const original = { width: 1000, height: 1400 }
    const output = feature.compose(original, { background: 'transparent', padding: 6, watermark: false })
    expect([output.width, output.height]).toEqual([1198, 1600])
    expect(calls.filter(call => call[0] === 'fill' || call[0] === 'text')).toEqual([])
    expect(calls[0][1]).toBe(original)
    expect(original).toEqual({ width: 1000, height: 1400 })
  })

  it.each([['cream', '#fffaf2'], ['pink', '#fff1f5']])('places the %s background behind artwork without replacing white pixels', (background, color) => {
    const { feature, calls } = setup()
    feature.compose({ width: 1000, height: 1400 }, { background, watermark: false })
    expect(calls[0][0]).toBe('image')
    expect(calls.find(call => call[0] === 'fill')).toEqual(['fill', color, 'destination-over', 0, 0, 1198, 1600])
  })

  it('clips optional watermarks to the artwork so surrounding transparent space stays transparent', () => {
    const { feature, calls } = setup()
    feature.compose({ width: 1000, height: 1400 }, { background: 'transparent', watermark: true, text: '门店展示', opacity: 40 })
    const marks = calls.filter(call => call[0] === 'text')
    expect(marks.length).toBeGreaterThan(0)
    expect(marks.every(call => call[1] === 'source-atop' && call[2] === '门店展示')).toBe(true)
    expect(calls.filter(call => call[0] === 'fill')).toHaveLength(0)
  })

  it.each([[1600, 160], [1600, 32], [32, 1600]])('includes a watermark on a narrow %s × %s layout', (width, height) => {
    const { feature, calls } = setup()
    feature.compose({ width, height }, { background: 'transparent', watermark: true })
    expect(calls.some(call => call[0] === 'text')).toBe(true)
  })

  it('remembers display settings across templates and ignores invalid or unavailable storage', () => {
    const { feature } = setup()
    const records = new Map<string, string>()
    const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) }
    expect(feature.loadSettings(storage)).toMatchObject({ background: 'cream', padding: 6, watermark: true, opacity: 40 })
    feature.saveSettings(storage, { background: 'transparent', padding: 8, watermark: false, text: '我的店铺', opacity: 25 })
    expect(feature.loadSettings(storage)).toEqual({ background: 'transparent', padding: 8, watermark: false, text: '我的店铺', opacity: 25 })
    expect(feature.normalize({ background: 'url(evil)', padding: Infinity, opacity: -10, text: '' })).toMatchObject({ background: 'cream', padding: 6, opacity: 8 })
    const broken = { getItem() { throw Error('blocked') }, setItem() { throw Error('quota') } }
    expect(feature.loadSettings(broken).background).toBe('cream')
    expect(() => feature.saveSettings(broken, {})).not.toThrow()
  })

  it.each([[1082, 1600, 1082, 1578], [1600, 1082, 1578, 1082]])('captures only the content from %s × %s without its numbering strip or selection', (width, height, contentPxW, contentPxH) => {
    const start = toolHtml.indexOf('function productPreviewSnapshot(')
    expect(start).toBeGreaterThan(-1)
    const body = toolHtml.slice(start, toolHtml.indexOf('function resizePreview(', start))
    const draws: any[] = [], copies: any[] = []
    const env: any = {
      selectionBoard: () => ({ ready: true }), fontBusy: false, solidBackgroundEditor: undefined,
      sel: { value: '示例.png' }, templates: { '示例.png': {} }, states: [],
      canvas: { width, height }, renderConfig: () => ({ contentPxW, contentPxH }),
      draw: (...args: any[]) => draws.push(args),
      document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (...args: any[]) => copies.push(args) }) }) },
    }
    const capture = new Function('env', `with(env){${body};return productPreviewSnapshot}`)(env)
    const snapshot = capture()
    expect([snapshot.canvas.width, snapshot.canvas.height]).toEqual([contentPxW, contentPxH])
    expect(snapshot.name).toBe('示例')
    expect(draws).toEqual([[false], []])
    expect(copies).toEqual([[env.canvas, 0, 0, contentPxW, contentPxH, 0, 0, contentPxW, contentPxH]])
  })
})
