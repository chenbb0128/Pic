import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

const directory = new URL('../../public/embedded/heart-star/', import.meta.url)
function source(name: string) {
  const path = new URL(name, directory)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
function setup(measureRegions?: (cfg: any, pixels: any) => any[]) {
  const draws: any[][] = [], messages: string[] = []
  const paint = { drawImage: (...args: any[]) => draws.push(['image', ...args]), clearRect: (...args: number[]) => draws.push(['clear', ...args]), getImageData: () => ({ data: [] }) }
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
    getName: () => env.name, getTemplate: () => env.cfg, getStates: () => env.states, measureRegions,
    getSelection: () => env.selected, getSource: () => env.base, assets, slots,
    loadImage: (id: string) => load(id), redraw() {}, report: (text: string) => messages.push(text),
  })
  return { feature, env, assets, cfg, draws, messages, set load(value: typeof load) { load = value } }
}

describe('heart-star built-in motifs', () => {
  it('rebuilds a restored custom catalog from current placements and keeps replacements after row changes', async () => {
    const s = setup()
    s.env.name = '自定义排版.png'
    Object.assign(s.cfg, { custom: true, slots: [{ row: 0, column: 0 }, { row: 1, column: 0 }],
      placements: [{ assetId: 'heart', x: 10, y: 20, w: 200, h: 200 }, { assetId: 'star', x: 10, y: 300, w: 200, h: 200 }],
      motifSlots: [{ assetId: 'old', variant: '小款', box: [0, 0, 10, 10] }] })
    s.env.states = [{ size: .62 }, { size: .62 }]
    expect(s.feature.catalog().map((meta: any) => meta.assetId)).toEqual(['heart', 'star'])
    await s.feature.replace([0], 'star')
    s.cfg.slots = [{ row: 0, column: 0 }, { row: 1, column: 0 }] as any
    ;(s.cfg as any).placements = [{ assetId: 'star', x: 30, y: 40, w: 200, h: 200 }, { assetId: 'heart', x: 30, y: 400, w: 200, h: 200 }]
    s.env.states.reverse()
    s.feature.reflow()
    expect(s.env.states[1].motif).toMatchObject({ assetId: 'star', originalAssetId: 'heart', placement: { x: 30, y: 400 } })
  })
  it('replaces only selected motifs in the independent 210×144 template using its own catalog and physical size', async () => {
    const s = setup()
    s.env.name = '爱心横版.png'
    Object.assign(s.cfg, { w: 2100, h: 1440, widthMm: 210, heightMm: 144, motifSlots: [
      { row: 0, column: 0, name: '组合', variant: '原款', box: [100, 100, 300, 300] },
      { row: 2, column: 0, name: '爱心', variant: '小款', box: [100, 800, 200, 200] },
    ] })
    await s.feature.replace([0], 'combo')
    expect(s.feature.active()).toBe(true)
    expect(s.env.states[0].motif.placement).toEqual({ x: 100, y: 100, w: 300, h: 300 })
    expect(s.env.states[0].motif.frame).toEqual({ x: 310, y: 175, w: 120, h: 150 })
    expect(s.env.states[1].motif).toBeUndefined()
    expect(s.feature.rows(210, 144)[0]).toMatchObject({ width: 30, height: 30 })
  })
  it('replaces an I ♥ ME group with I ♥ VE while keeping the photo transform and opening', async () => {
    const s = setup()
    ;(s.assets as any).ive = { ...s.assets.combo, name: '新组合 I ♥ VE', group: 'I ♥ VE 组合' }
    await s.feature.replace([2], 'ive')
    expect(s.env.states[2].motif?.assetId).toBe('ive')
    expect(s.env.states[2].motif.frame).toEqual({ x: 210, y: 575, w: 120, h: 150 })
    expect(s.env.states[2].size).toBe(.62)
    expect(s.env.states[0].motif).toBeUndefined()
  })
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

  it.each(['小款', '大款'])('allows only matching %s hearts and stars, fitting the existing position', async variant => {
    const s = setup()
    Object.assign(s.cfg, { motifSlots: [
      { row: 0, column: 0, name: '爱心', variant, box: [0, 0, 200, 200] },
      { row: 0, column: 1, name: '爱心', variant, box: [240, 0, 200, 200] },
      { row: 1, column: 0, name: '组合', variant: '原款', box: [0, 500, 300, 300] },
    ] })
    s.assets.star.variant = variant
    s.assets.star.nativeW = 21
    s.assets.star.nativeH = 21
    s.assets.heart.variant = variant
    expect(s.feature.allowed(s.assets.star, [0, 1])).toBe(true)
    expect(s.feature.allowed(s.assets.star, [0, 2])).toBe(false)
    expect(s.feature.allowed({ ...s.assets.star, variant: variant === '小款' ? '大款' : '小款', nativeW: 10, nativeH: 10 }, [0])).toBe(false)
    expect(s.feature.allowed({ ...s.assets.star, type: 'circle', nativeW: 10, nativeH: 10 }, [0])).toBe(false)
    await s.feature.replace([0], 'star')
    expect(s.env.states[0].motif).toMatchObject({ assetId: 'star', type: 'star', placement: { x: 0, y: 0, w: 200, h: 200 }, frame: { x: 140, y: 50, w: 80, h: 100 } })
    await s.feature.replace([1], 'combo')
    expect(s.env.states[1].motif).toBeUndefined()
    await s.feature.replace([0], 'heart')
    expect(s.env.states[0].motif.placement).toEqual({ x: 0, y: 0, w: 200, h: 200 })
    expect(s.feature.allowed(s.assets.star, [0])).toBe(true)
    expect(s.env.states[0].imageDx).toBe(8)
  })

  it('rejects replacements from unsupported templates without changing artwork', async () => {
    const s = setup()
    s.env.name = '模板混合.png'
    await s.feature.replace([0], 'heart')
    expect(s.env.states.some((state: any) => state.motif)).toBe(false)
    expect(s.feature.selection()).toEqual([])
  })

  it.each([
    ['模板混合.png', 40, 'star', 24, 8, 8, 'mint-star-small'],
    ['模板粉色.png', 28, 'square', 12, 8, 8, 'pink-plaid-square-small'],
    ['模板蓝色.png', 28, 'square', 12, 8, 8, 'blue-square-small'],
    ['模板黄色.png', 28, 'square', 12, 8, 8, 'yellow-square-small'],
    ['豹纹星星.png', 42, 'star', 30, 12, 0, 'leopard-star-small'],
    ['波点爱心.png', 42, 'heart', 30, 12, 0, 'polka-heart-small'],
    ['波点圆形.png', 42, 'circle', 30, 12, 0, 'polka-circle-small'],
  ])('supports selected replacement and restore in %s without changing neighbors', async (name, count, type, small, large, combos, firstId) => {
    const templateStart = toolHtml.indexOf('const templates=')
    const templates = new Function(`${toolHtml.slice(templateStart, toolHtml.indexOf('const canvas=', templateStart))};return templates`)()
    // Hand-set measured bounds prove the editor uses full artwork, not photo openings.
    const bounds = templates[name].slots.map((p: any) => ({ x: p.x, y: p.y, w: 210, h: 220 }))
    const s = setup(() => bounds)
    s.env.name = name
    s.env.cfg = templates[name]
    Object.assign(s.assets, JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!))
    s.env.base = { complete: true, naturalWidth: templates[name].w }
    s.env.states = Array.from({ length: Number(count) }, () => ({ size: .62, imageDx: 8 }))
    expect(s.feature.active()).toBe(true)
    const catalog = s.feature.catalog()
    expect(catalog).toHaveLength(Number(count))
    expect(catalog.filter((p: any) => p.variant === '小款')).toHaveLength(Number(small))
    expect(catalog.filter((p: any) => p.variant === '大款')).toHaveLength(Number(large))
    expect(catalog.filter((p: any) => p.variant === '原款')).toHaveLength(Number(combos))
    expect(catalog[0]).toMatchObject({ type, assetId: firstId, box: [bounds[0].x - 105, bounds[0].y - 110, 210, 220] })
    const selectedAsset = 'star'
    expect(s.feature.allowed((s.assets as any)[selectedAsset], [0])).toBe(true)
    expect(s.feature.allowed({ ...(s.assets as any)[selectedAsset], variant: '大款' }, [0])).toBe(false)
    expect(s.feature.allowed((s.assets as any)[firstId], [0])).toBe(true)
    await s.feature.replace([0], selectedAsset)
    expect(s.env.states[0].motif.assetId).toBe(selectedAsset)
    expect(s.env.states[0].imageDx).toBe(8)
    expect(s.env.states[1].motif).toBeUndefined()
    s.feature.source(s.env.base)
    expect(s.draws).toContainEqual(['clear', bounds[0].x - 105, bounds[0].y - 110, 210, 220])
    s.feature.restore([0])
    expect(s.feature.source(s.env.base)).toBe(s.env.base)
  })

  it.each(['小款', '大款'])('replaces %s circles and squares with hearts or stars while preserving other positions', async variant => {
    const s = setup()
    Object.assign(s.cfg, { motifSlots: [
      { row: 0, column: 0, name: '圆形', variant, type: 'circle', box: [0, 0, 200, 200] },
      { row: 0, column: 1, name: '方块', variant, type: 'square', box: [240, 0, 200, 200] },
      { row: 1, column: 0, name: '组合', variant: '原款', box: [0, 500, 300, 300] },
    ] })
    s.assets.star.variant = variant
    s.assets.heart.variant = variant
    for (const assetId of ['heart', 'star'] as const) {
      expect(s.feature.allowed(s.assets[assetId], [0, 1])).toBe(true)
      expect(s.feature.allowed({ ...s.assets[assetId], variant: variant === '小款' ? '大款' : '小款' }, [0, 1])).toBe(false)
      expect(s.feature.allowed(s.assets[assetId], [0, 2])).toBe(false)
      await s.feature.replace([0, 1], assetId)
      expect(s.env.states[0].motif).toMatchObject({ assetId, type: assetId, placement: { x: 0, y: 0, w: 200, h: 200 } })
      expect(s.env.states[1].motif).toMatchObject({ assetId, type: assetId, placement: { x: 240, y: 0, w: 200, h: 200 } })
      expect(s.env.states[0].imageDx).toBe(8)
      expect(s.env.states[2].motif).toBeUndefined()
    }
    expect(s.feature.allowed(s.assets.combo, [0, 1])).toBe(false)
  })

  it('supports custom-layout replacements using placements and refuses text templates', async () => {
    const s = setup()
    s.env.name = '自定义排版.png'
    s.env.cfg = { w: 2100, h: 1440, custom: true, slots: [{ type: 'heart', row: 0, column: 0 }],
      placements: [{ assetId: 'heart', x: 50, y: 80, w: 200, h: 200 }] }
    s.env.states = [{ imageDx: 8 }]
    expect(s.feature.active()).toBe(true)
    await s.feature.replace([0], 'star')
    expect(s.env.states[0].motif).toMatchObject({ assetId: 'star', type: 'star', placement: { x: 50, y: 80, w: 200, h: 200 } })
    s.env.cfg.placements = [{ assetId: 'heart', x: 300, y: 500, w: 200, h: 200 }]
    s.feature.reflow()
    expect(s.env.states[0].motif.placement).toEqual({ x: 300, y: 500, w: 200, h: 200 })
    expect(s.env.states[0].imageDx).toBe(8)
    s.env.cfg.placements = [{ assetId: 'combo', x: 300, y: 500, w: 300, h: 300 }]
    s.feature.reflow()
    expect(s.env.states[0].motif).toBeUndefined()
    s.env.cfg = { text: true, slots: [{}] }
    expect(s.feature.active()).toBe(false)
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
  it('adds all three new heart patterns to both letter combinations without changing their photo openings', () => {
    const scope: any = {}
    new Function('globalThis', source('pattern-combos.js'))(scope)
    expect(scope.HeartStarPatternCombos).toBeDefined()
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    new Function('globalThis', source('ive-motifs.js'))(scope)
    Object.assign(assets, scope.HeartStarIVE.register(assets))
    const extra = scope.HeartStarPatternCombos.register(assets)
    expect(Object.keys(extra)).toHaveLength(6)
    for (const letters of ['ime', 'ive']) for (const pattern of ['brown-polka', 'brown-stripe', 'pink-stripe']) {
      const variant = extra[`${letters}-${pattern}`], original = assets[`${letters}-rose`]
      expect(variant).toMatchObject({ group: original.group, variant: '原款', nativeW: original.nativeW,
        nativeH: original.nativeH, frame: original.frame })
      expect([...readFileSync(new URL(variant.src, directory)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    }
  })
  it('registers pink vertical striped hearts in both sizes with existing selection geometry', () => {
    const scope: any = {}
    new Function('globalThis', source('pink-motifs.js'))(scope)
    expect(scope.HeartStarPink).toBeDefined()
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    const entries = scope.HeartStarPink.register(assets)
    expect(Object.keys(entries)).toHaveLength(4)
    for (const suffix of ['-small', '']) {
      const original = assets[`rose-heart${suffix}`], variant = entries[`pink-stripe-heart${suffix}`]
      expect(variant).toMatchObject({ type: 'heart', variant: original.variant, nativeW: original.nativeW,
        nativeH: original.nativeH, frame: original.frame, baseName: '粉色条纹爱心' })
      expect([...readFileSync(new URL(variant.src, directory)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    }
  })
  it('offers white-background pink stars in both sizes with the existing star silhouette and dimensions', () => {
    const scope: any = {}
    new Function('globalThis', source('pink-motifs.js'))(scope)
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    const entries = scope.HeartStarPink.register(assets)
    for (const suffix of ['-small', '']) {
      const original = assets[`white-mint-star${suffix}`], variant = entries[`white-pink-star${suffix}`]
      expect(variant).toMatchObject({ type: 'star', variant: original.variant, nativeW: original.nativeW,
        nativeH: original.nativeH, frame: original.frame, baseName: '白底粉星星' })
      expect([...readFileSync(new URL(variant.src, directory)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    }
  })
  it('adds brown polka and two-tone striped hearts in both sizes without altering existing materials', () => {
    const scope: any = {}
    new Function('globalThis', source('brown-motifs.js'))(scope)
    expect(scope.HeartStarBrown).toBeDefined()
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    const before = structuredClone(assets)
    const extra = scope.HeartStarBrown.register(assets)
    expect(Object.keys(extra)).toHaveLength(4)
    for (const pattern of ['polka', 'stripe']) for (const [suffix, original] of [['-small', 'rose-heart-small'], ['', 'rose-heart']]) {
      const material = extra[`brown-${pattern}-heart${suffix}`]
      expect(material).toMatchObject({ type: 'heart', variant: assets[original!].variant,
        nativeW: assets[original!].nativeW, nativeH: assets[original!].nativeH, frame: assets[original!].frame })
      expect([...readFileSync(new URL(material.src, directory)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    }
    expect(assets).toEqual(before)
  })
  it('adds matching I ♥ VE materials without overwriting I ♥ ME or changing their dimensions', () => {
    const global: any = {}
    new Function('globalThis', source('motif-catalog.js'))(global)
    new Function('globalThis', source('ive-motifs.js'))(global)
    const assets = { ...JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!), ...global.HeartStarMotifCatalog.assets }
    expect(global.HeartStarIVE).toBeDefined()
    const entries = global.HeartStarIVE.register(assets)
    const originals = Object.entries(assets).filter(([, a]: any) => a.group === 'I ♥ ME 组合')
    expect(Object.keys(entries)).toHaveLength(originals.length)
    for (const [id, original] of originals as [string, any][]) {
      const variant = entries[id.replace(/^ime-/, 'ive-')]
      expect(variant).toMatchObject({ group: 'I ♥ VE 组合', w: original.w, h: original.h,
        nativeW: original.nativeW, nativeH: original.nativeH, frame: original.frame })
      expect(variant.name).toContain('I ♥ VE')
      expect([...readFileSync(new URL(variant.src, directory)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
      expect(assets[id]).toBe(original)
    }
    const start = toolHtml.indexOf('function buildCustomLayout(')
    const build = new Function(`${toolHtml.slice(start, toolHtml.indexOf('\n}', start) + 2)};return buildCustomLayout`)()
    const layout = build([{ id: 'r', groups: [{ id: 'g', assetId: 'ive-rose', count: 1 }] }], entries, 144, 210)
    expect(layout.slots[0].backgroundPart).toBe('heart')
  })
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
