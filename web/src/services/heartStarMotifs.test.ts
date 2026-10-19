import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

const directory = new URL('../../public/embedded/heart-star/', import.meta.url)
function source(name: string) {
  const path = new URL(name, directory)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
function setup() {
  const draws: any[][] = [], messages: string[] = []
  const paint = { drawImage: (...args: any[]) => draws.push(['image', ...args]), clearRect: (...args: number[]) => draws.push(['clear', ...args]) }
  const global: any = {}
  new Function('globalThis', 'document', source('template-motifs.js'))(global, { createElement: () => ({ getContext: () => paint }) })
  const cfg = { w: 1440, h: 2100, slots: [
    { x: 100, y: 100, w: 120, h: 120 }, { x: 340, y: 100, w: 120, h: 120 }, { x: 210, y: 575, w: 150, h: 150 },
  ] }
  const slots = [
    { index: 0, row: 0, column: 0, name: '原图案', variant: '小款', box: [0, 0, 200, 200] },
    { index: 1, row: 0, column: 1, name: '原图案', variant: '小款', box: [240, 0, 200, 200] },
    { index: 2, row: 1, column: 0, name: '原组合', variant: '原款', box: [0, 500, 300, 300] },
  ]
  const frame = { x: .7, y: .25, w: .4, h: .5 }
  const assets = {
    heart: { name: '新爱心 · 小款', baseName: '新爱心', type: 'heart', variant: '小款', group: '爱心', nativeW: 20, nativeH: 20, frame },
    star: { type: 'star', variant: '小款', group: '星星', nativeW: 20, nativeH: 20, frame },
    combo: { name: '新组合', baseName: '新组合', type: 'heart', variant: '原款', group: 'I ♥ ME 组合', nativeW: 30, nativeH: 30, frame },
  }
  const env: any = { name: '模板爱心.png', cfg, states: [{ size: .62, imageDx: 8, background: { type: 'color' } }, { size: .8 }, { size: .62 }], selected: new Set([0]), base: { name: 'base' } }
  let load: (id: string) => Promise<any> = async id => ({ id })
  const feature = global.HeartStarMotifs.create({
    getName: () => env.name, getTemplate: () => cfg, getStates: () => env.states,
    getSelection: () => env.selected, getSource: () => env.base, assets, slots,
    loadImage: (id: string) => load(id), redraw() {}, report: (text: string) => messages.push(text),
  })
  return { feature, env, assets, cfg, draws, messages, set load(value: typeof load) { load = value } }
}

describe('heart-star built-in motifs', () => {
  it('replaces selected same-size motifs only, preserving photo transforms and original template geometry', async () => {
    const s = setup()
    await s.feature.replace([0], 'heart')
    expect(s.env.states[0]).toMatchObject({ size: .62, imageDx: 8, motif: { assetId: 'heart', placement: { x: 0, y: 0, w: 200, h: 200 } } })
    expect(s.env.states[0].background).toBeUndefined()
    expect(s.env.states[1]).toEqual({ size: .8 })
    expect(s.cfg.slots[0]).toEqual({ x: 100, y: 100, w: 120, h: 120 })
    expect(s.feature.rows(144, 210)[0]).toMatchObject({ name: '新爱心', width: 20, height: 20 })
    expect(s.feature.rows(288, 420)[0]).toMatchObject({ width: 40, height: 40 })
  })

  it('replaces I ♥ ME as a complete group and derives its new photo opening', async () => {
    const s = setup()
    await s.feature.replace([2], 'combo')
    expect(s.env.states[2].motif.placement).toEqual({ x: 0, y: 500, w: 300, h: 300 })
    expect(s.env.states[2].motif.frame).toEqual({ x: 210, y: 575, w: 120, h: 150 })
    expect(s.cfg.slots[2].w).toBe(150)
  })

  it('rejects mismatched variants, stars and selections from other templates without changing artwork', async () => {
    const s = setup()
    await s.feature.replace([0, 2], 'heart')
    await s.feature.replace([0], 'star')
    s.env.name = '模板混合.png'
    await s.feature.replace([0], 'heart')
    expect(s.env.states.some((state: any) => state.motif)).toBe(false)
    expect(s.feature.selection()).toEqual([])
  })

  it('caches composite artwork and restores selected motifs without undoing unselected replacements', async () => {
    const s = setup()
    await s.feature.replace([0, 1], 'heart')
    const first = s.feature.source(s.env.base)
    expect(s.feature.source(s.env.base)).toBe(first)
    expect(s.draws.filter(call => call[0] === 'clear')).toHaveLength(2)
    s.feature.restore([0])
    expect(s.env.states[0].motif).toBeUndefined()
    expect(s.env.states[1].motif.assetId).toBe('heart')
    expect(s.feature.source(s.env.base)).not.toBe(first)
    s.feature.restore([1])
    expect(s.feature.source(s.env.base)).toBe(s.env.base)
  })

  it('ignores late image loads after template/state changes or restore and preserves artwork on failure', async () => {
    const s = setup()
    let finish!: (image: any) => void
    s.load = () => new Promise(resolve => { finish = resolve })
    const pending = s.feature.replace([0], 'heart')
    expect(s.feature.busy()).toBe(true)
    s.env.states = [{ size: .62 }, {}, {}]
    finish({ id: 'heart' })
    await pending
    expect(s.env.states[0].motif).toBeUndefined()
    const cancelled = s.feature.replace([0], 'heart')
    s.feature.restore([0])
    finish({ id: 'heart' })
    await cancelled
    expect(s.env.states[0].motif).toBeUndefined()
    s.load = async () => { throw new Error('图片加载失败') }
    await s.feature.replace([0], 'heart')
    expect(s.env.states[0].motif).toBeUndefined()
    expect(s.feature.busy()).toBe(false)
    expect(s.messages.join('')).toContain('失败')
  })
})

describe('heart-star catalog and overflow details', () => {
  it('adds all 18 material entries with valid local PNGs while preserving existing dimensions', () => {
    const global: any = {}
    new Function('globalThis', source('motif-catalog.js'))(global)
    const extra = global.HeartStarMotifCatalog?.assets || {}
    expect(Object.keys(extra)).toHaveLength(18)
    expect(global.HeartStarMotifCatalog.slots).toHaveLength(40)
    for (const asset of Object.values(extra) as any[]) {
      expect([...readFileSync(new URL(asset.src, directory)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    }
    const original = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    expect(original['pink-dot-heart-small'].nativeW).toBeCloseTo(20.60014)
  })

  it('reports exact overflowing millimeters for width and height instead of shrinking artwork', () => {
    const start = toolHtml.indexOf('function buildCustomLayout(')
    const build = new Function(`${toolHtml.slice(start, toolHtml.indexOf('\n}', start) + 2)};return buildCustomLayout`)()
    const assets = { a: { nativeW: 20, nativeH: 20, frame: { x: .5, y: .5, w: 1, h: 1 } } }
    expect(() => build([{ id: 'r', groups: [{ id: 'g', assetId: 'a', count: 7 }] }], assets, 144, 210)).toThrow(/超出纸张 14\.00 mm/)
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i), groups: [{ id: 'g', assetId: 'a', count: 1 }] }))
    expect(() => build(rows, assets, 144, 210)).toThrow(/超出纸张 14\.00 mm/)
  })
})
