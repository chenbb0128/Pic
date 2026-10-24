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
  it.each(['blue-square-small', 'blue-square', 'polka-circle-small', 'polka-circle'])('offers %s for mixed heart, star and letter selections without moving neighbors', async assetId => {
    const s = setup()
    const originalAssets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    const asset = originalAssets[assetId]
    Object.assign(s.assets, { [assetId]: asset })
    Object.assign(s.env.base, { width: 1440, height: 2100 })
    s.env.states.push({ size: .5 })
    const untouched = structuredClone(s.env.states[3])
    expect(s.feature.allowed(asset, [0, 1, 2])).toBe(true)
    await s.feature.replace([0, 1, 2], assetId)
    for (const [i, maxW, maxH, centerX, centerY] of [[0, 200, 200, 100, 100], [1, 200, 200, 340, 100], [2, 300, 300, 150, 650]]) {
      const motif = s.env.states[i!].motif, p = motif.placement
      expect(motif.assetId).toBe(assetId)
      expect(motif.type).toBe(asset.type)
      expect(p.w).toBeLessThanOrEqual(maxW! + 1e-9)
      expect(p.h).toBeLessThanOrEqual(maxH! + 1e-9)
      expect(p.w / p.h).toBeCloseTo(asset.nativeW / asset.nativeH)
      expect(p.x + p.w / 2).toBeCloseTo(centerX!)
      expect(p.y + p.h / 2).toBeCloseTo(centerY!)
      expect(motif.frame.w).toBeCloseTo(p.w * asset.frame.w)
      expect(motif.frame.x).toBeCloseTo(p.x + p.w * asset.frame.x)
    }
    s.feature.source(s.env.base)
    expect(s.env.states[0]).toMatchObject({ size: .62, imageDx: 8 })
    expect(s.env.states[3]).toEqual(untouched)
  })

  it.each([
    [19.5, 39, 100, 200], [10, 8, 100, 80], [19.5, 19.5, 195, 195],
  ])('fits selected small hearts %s×%s without growing them during rendering or restore', async (nativeW, nativeH, wantW, wantH) => {
    const s = setup()
    Object.assign(s.assets.heart, { nativeW, nativeH })
    Object.assign(s.env.base, { width: 1440, height: 2100 })
    await s.feature.replace([0], 'heart')
    const motif = s.env.states[0].motif
    expect(motif.placement.w).toBeCloseTo(wantW!)
    expect(motif.placement.h).toBeCloseTo(wantH!)
    s.feature.source(s.env.base)
    expect(s.env.states[0].motif).toBe(motif)
    s.env.states = structuredClone(s.env.states)
    s.feature.source(s.env.base)
    expect(s.feature.rows(144, 210)[0].width).toBeCloseTo(wantW! / 10)
    expect(s.feature.rows(144, 210)[0].height).toBeCloseTo(wantH! / 10)
  })

  it('opens all motif choices for mixed-size selections in the preview controls', () => {
    const s = setup(), controls = new Map<string, any>(), offered: string[] = []
    s.env.selected = new Set([0, 2])
    const element = () => ({ textContent: '', disabled: false, append() {} })
    const document = { getElementById(id: string) {
      if (!controls.has(id)) controls.set(id, { ...element(), replaceChildren() {} })
      return controls.get(id)
    }, createElement: () => ({ ...element(), style: {} }) }
    let opened = false
    const env = { document, motifEditor: s.feature, templates: { test: s.cfg }, sel: { value: 'test' },
      base: { complete: true, naturalWidth: 1440 }, states: s.env.states, exportBusy: false,
      widthInput: { value: '144' }, heightInput: { value: '210' },
      customPicker: { querySelector: (id: string) => document.getElementById(id), querySelectorAll: () => [], showModal() { opened = true } },
      filterCustomPicker(predicate: (asset: any) => boolean) { for (const [id, asset] of Object.entries(s.assets)) if (predicate(asset)) offered.push(id) },
    }
    const start = toolHtml.indexOf('function updateMotifControls(')
    const code = toolHtml.slice(start, toolHtml.indexOf('function openCustomPicker(', start))
    const ui = new Function('env', `with(env){let motifTableKey='',customPickerTarget=null;${code};return {updateMotifControls,openHeartMotifPicker}}`)(env)
    ui.updateMotifControls()
    expect(controls.get('replaceHeartMotif').disabled).toBe(false)
    ui.openHeartMotifPicker()
    expect(opened).toBe(true)
    expect(offered).toEqual(['heart', 'star', 'combo'])
  })

  it('limits I/ME assets to 30 mm proportionally for custom layouts without enlarging smaller groups', () => {
    const scope: any = {}
    new Function('globalThis', source('template-motifs.js'))(scope)
    const assets = {
      tall: { group: 'I ♥ ME 组合', nativeW: 30, nativeH: 32 },
      wide: { group: 'I ♥ ME 组合', nativeW: 36, nativeH: 30 },
      small: { group: 'I ♥ ME 组合', nativeW: 29, nativeH: 28 },
      heart: { type: 'heart', variant: '大款', nativeW: 32, nativeH: 31 },
      ive: { group: 'I ♥ VE 组合', nativeW: 31, nativeH: 32 },
    }
    scope.HeartStarMotifs.limitIMe?.(assets)
    expect(assets.tall).toMatchObject({ nativeW: 28.125, nativeH: 30 })
    expect(assets.wide).toMatchObject({ nativeW: 30, nativeH: 25 })
    expect(assets.small).toMatchObject({ nativeW: 29, nativeH: 28 })
    expect(assets.heart).toMatchObject({ nativeW: 32, nativeH: 31 })
    expect(assets.ive).toMatchObject({ nativeW: 31, nativeH: 32 })
    const start = toolHtml.indexOf('function buildCustomLayout(')
    const build = new Function(`${toolHtml.slice(start, toolHtml.indexOf('\n}', start) + 2)};return buildCustomLayout`)()
    const cfg = build([{ id: 'r', groups: [{ id: 'g', assetId: 'tall', count: 1 }] }],
      { tall: { ...assets.tall, frame: { x: .7, y: .25, w: .4, h: .5 } } }, 144, 210)
    expect(cfg.placements[0]).toMatchObject({ w: 281.25, h: 300 })
  })

  it('initializes all small hearts at 19.5 mm width and I/ME patterns within 30 mm without altering other artwork', () => {
    const scope: any = {}
    for (const file of ['motif-catalog.js', 'ive-motifs.js', 'brown-motifs.js', 'pink-motifs.js',
      'red-motifs.js', 'gold-leopard-motifs.js', 'yellow-motifs.js', 'sky-blue-motifs.js', 'light-blue-motifs.js', 'pattern-combos.js', 'template-motifs.js']) {
      new Function('globalThis', source(file))(scope)
    }
    const start = toolHtml.indexOf('const customAssets=')
    const initialize = toolHtml.slice(start, toolHtml.indexOf('\nObject.entries(templates)', start))
    const originals = new Function(...Object.keys(scope),
      `${initialize.slice(0, initialize.indexOf('HeartStarMotifs.limitSmallHearts'))};return customAssets`)(...Object.values(scope))
    const assets = new Function(...Object.keys(scope), `${initialize};return customAssets`)(...Object.values(scope))
    const groups = Object.values(assets).filter((asset: any) => asset.group === 'I ♥ ME 组合') as any[]
    expect(groups.length).toBeGreaterThan(10)
    groups.forEach(asset => {
      expect(asset.nativeW).toBeLessThanOrEqual(30)
      expect(asset.nativeH).toBeLessThanOrEqual(30)
    })
    const hearts = Object.entries(assets).filter(([, asset]: any) => asset.type === 'heart' && asset.variant === '小款') as [string, any][]
    expect(hearts.length).toBeGreaterThan(20)
    hearts.forEach(([id, asset]) => {
      expect(asset.nativeW).toBe(19.5)
      expect(asset.nativeH / asset.nativeW).toBeCloseTo(originals[id].nativeH / originals[id].nativeW)
    })
    for (const [id, asset] of Object.entries(assets) as [string, any][]) {
      if (asset.group !== 'I ♥ ME 组合' && !(asset.type === 'heart' && asset.variant === '小款')) expect(asset).toEqual(originals[id])
    }
  })

  it.each([[144, 210], [210, 144]])('fits original I/ME artwork and photo openings inside 30 mm on %s×%s paper', (widthMm, heightMm) => {
    const s = setup()
    Object.assign(s.env.base, { width: 1440, height: 2100 })
    Object.assign(s.cfg, { widthMm, heightMm, motifSlots: [
      { assetId: 'heart', variant: '小款', type: 'heart', box: [0, 0, 190, 190] },
      { assetId: 'star', variant: '小款', type: 'star', box: [240, 0, 200, 200] },
      { assetId: 'combo', variant: '原款', type: 'heart', box: [0, 500, 320, 320] },
    ] })
    const rendered = s.feature.source(s.env.base)
    const row = s.feature.rows(widthMm, heightMm)[2]
    expect(row.width).toBeLessThanOrEqual(30)
    expect(row.height).toBeLessThanOrEqual(30)
    const motif = s.env.states[2].motif
    expect(motif).toMatchObject({ assetId: 'combo', type: 'heart', backgroundPart: 'heart' })
    expect(motif.placement.x + motif.placement.w / 2).toBeCloseTo(160)
    expect(motif.placement.y + motif.placement.h / 2).toBeCloseTo(660)
    const factor = motif.placement.w / 320
    expect(motif.placement.h / 320).toBeCloseTo(factor)
    expect(motif.frame.x).toBeCloseTo(motif.placement.x + 210 * factor)
    expect(motif.frame.y).toBeCloseTo(motif.placement.y + 75 * factor)
    expect(motif.frame.w).toBeCloseTo(150 * factor)
    expect(s.env.states[2].size).toBe(.62)
    expect(s.draws).toContainEqual(['clear', 0, 500, 320, 320])
    expect(s.feature.source(s.env.base)).toBe(rendered)
    s.feature.restore([2])
    expect(s.feature.rows(widthMm, heightMm)[2].width).toBeLessThanOrEqual(30)
  })

  it('caps oversized I/ME replacements and saved artwork without losing photos, texture or edits', async () => {
    const s = setup()
    Object.assign(s.assets.combo, { nativeW: 40, nativeH: 32 })
    s.cfg.slots[2] = { x: 280, y: 600, w: 160, h: 200 }
    Object.assign(s.cfg, { motifSlots: [
      { assetId: 'heart', variant: '小款', box: [0, 0, 190, 190] },
      { assetId: 'star', variant: '小款', box: [240, 0, 200, 200] },
      { assetId: 'combo', variant: '原款', box: [0, 500, 400, 400] },
    ] })
    await s.feature.replace([2], 'combo')
    expect(s.env.states[2].motif.placement).toEqual({ x: 50, y: 580, w: 300, h: 240 })
    expect(s.env.states[2].motif.frame).toEqual({ x: 260, y: 640, w: 120, h: 120 })
    const savedImage = { name: 'saved-texture' }
    Object.assign(s.env.states[2], { imageDx: 9, background: { type: 'image' }, motif: {
      assetId: 'combo', image: savedImage, placement: { x: 0, y: 500, w: 400, h: 320 },
      frame: { x: 280, y: 580, w: 160, h: 160 }, type: 'heart', backgroundPart: 'heart',
    } })
    Object.assign(s.env.base, { width: 1440, height: 2100 })
    const row = s.feature.rows(144, 210)[2]
    expect(row.width).toBeCloseTo(29.8)
    expect(row.height).toBeCloseTo(23.84)
    expect(s.env.states[2].motif.image).toBe(savedImage)
    expect(s.env.states[2].motif.frame.w).toBeCloseTo(119.2)
    expect(s.env.states[2]).toMatchObject({ size: .62, imageDx: 9, background: { type: 'image' } })
    const normalized = s.env.states[2].motif
    s.feature.source(s.env.base)
    expect(s.env.states[2].motif).toBe(normalized)
  })

  it('normalizes all small-heart asset widths to 19.5 mm, scaling height proportionally even for smaller artwork', () => {
    const scope: any = {}
    new Function('globalThis', source('template-motifs.js'))(scope)
    const assets = {
      tall: { type: 'heart', variant: '小款', nativeW: 21, nativeH: 22 },
      wide: { type: 'heart', variant: '小款', nativeW: 25, nativeH: 20 },
      small: { type: 'heart', variant: '小款', nativeW: 19, nativeH: 18 },
      large: { type: 'heart', variant: '大款', nativeW: 30, nativeH: 31 },
      star: { type: 'star', variant: '小款', nativeW: 21, nativeH: 22 },
      combo: { type: 'heart', variant: '原款', nativeW: 30, nativeH: 31 },
    }
    scope.HeartStarMotifs.limitSmallHearts?.(assets)
    expect(assets.tall.nativeW).toBe(19.5)
    expect(assets.tall.nativeH).toBeCloseTo(20.428571)
    expect(assets.wide.nativeW).toBe(19.5)
    expect(assets.wide.nativeH).toBeCloseTo(15.6)
    expect(assets.small.nativeW).toBe(19.5)
    expect(assets.small.nativeH).toBeCloseTo(18.473684)
    expect(assets.large).toMatchObject({ nativeW: 30, nativeH: 31 })
    expect(assets.star).toMatchObject({ nativeW: 21, nativeH: 22 })
    expect(assets.combo).toMatchObject({ nativeW: 30, nativeH: 31 })
  })

  it('shrinks oversized original small hearts around their centers in the rendered template and photo frame', () => {
    const s = setup()
    Object.assign(s.env.base, { width: 1440, height: 2100 })
    Object.assign(s.cfg, { motifSlots: [
      { assetId: 'heart', variant: '小款', type: 'heart', box: [0, 0, 220, 210] },
      { assetId: 'star', variant: '小款', type: 'star', box: [240, 0, 220, 210] },
      { assetId: 'combo', variant: '原款', type: 'heart', box: [0, 500, 300, 300] },
    ] })
    const originalStar = structuredClone(s.env.states[1])
    const rendered = s.feature.source(s.env.base)
    const row = s.feature.rows(144, 210)[0]
    expect(row.width).toBeCloseTo(19.5)
    expect(row.height).toBeCloseTo(18.613636)
    const motif = s.env.states[0].motif
    expect(motif.placement.x + motif.placement.w / 2).toBeCloseTo(110)
    expect(motif.placement.y + motif.placement.h / 2).toBeCloseTo(105)
    expect(motif.frame.x).toBeCloseTo(101.136364)
    expect(motif.frame.y).toBeCloseTo(100.568182)
    expect(motif.frame.w).toBeCloseTo(106.363636)
    expect(s.env.states[0]).toMatchObject({ size: .62, imageDx: 8, background: { type: 'color' } })
    expect(s.env.states[1]).toEqual(originalStar)
    expect(s.feature.rows(144, 210)[2].width).toBeCloseTo(29.8)
    expect(s.feature.rows(144, 210)[2].height).toBeCloseTo(29.8)
    expect(s.env.states[2].motif.backgroundPart).toBe('heart')
    expect(s.draws.some(call => call[0] === 'clear' && call[3] === 220 && call[4] === 210)).toBe(true)
    expect(s.feature.source(s.env.base)).toBe(rendered)
    s.feature.restore([0])
    s.feature.source(s.env.base)
    expect(s.feature.rows(144, 210)[0].width).toBeCloseTo(19.5)
  })

  it.each([[144, 210], [210, 144]])('normalizes smaller and saved small hearts to a centered 19.5 mm width on %s×%s paper', (widthMm, heightMm) => {
    const s = setup()
    Object.assign(s.env.base, { width: 1440, height: 2100 })
    Object.assign(s.cfg, { widthMm, heightMm, motifSlots: [
      { assetId: 'heart', variant: '小款', type: 'heart', box: [0, 0, 180, 160] },
      { assetId: 'star', variant: '小款', type: 'star', box: [240, 0, 180, 160] },
      { assetId: 'combo', variant: '原款', type: 'heart', box: [0, 500, 280, 280] },
    ] })
    const image = { name: 'saved-heart' }
    s.env.states[0].motif = { assetId: 'heart', image, placement: { x: 0, y: 0, w: 180, h: 160 },
      frame: { x: 100, y: 100, w: 120, h: 120 }, type: 'heart', backgroundPart: 'whole' }
    s.feature.source(s.env.base)
    const motif = s.env.states[0].motif
    expect(s.feature.rows(widthMm, heightMm)[0].width).toBeCloseTo(19.5)
    expect(motif.placement.w / motif.placement.h).toBeCloseTo(1.125)
    expect(motif.placement.x + motif.placement.w / 2).toBeCloseTo(90)
    expect(motif.placement.y + motif.placement.h / 2).toBeCloseTo(80)
    expect(motif.frame.w / motif.placement.w).toBeCloseTo(2 / 3)
    expect(motif.image).toBe(image)
    expect(s.env.states[0]).toMatchObject({ size: .62, imageDx: 8, background: { type: 'color' } })
    s.feature.source(s.env.base)
    expect(s.env.states[0].motif).toBe(motif)
    expect(s.env.states[1].motif).toBeUndefined()
  })

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
  it('replaces only selected motifs, preserving photo transforms and original template geometry', async () => {
    const s = setup()
    await s.feature.replace([0], 'heart')
    expect(s.env.states[0]).toMatchObject({ size: .62, imageDx: 8, motif: { assetId: 'heart', placement: { x: 2.5, y: 2.5, w: 195, h: 195 },
      frame: { x: 100, y: 100, w: 117, h: 117 } } })
    expect(s.env.states[0].background).toBeUndefined()
    expect(s.env.states[1]).toEqual({ size: .8 })
    expect(s.cfg.slots[0]).toEqual({ x: 100, y: 100, w: 120, h: 120 })
    expect(s.feature.rows(144, 210)[0]).toMatchObject({ name: '新爱心', width: 19.5, height: 19.5 })
    expect(s.feature.rows(288, 420)[0]).toMatchObject({ width: 39, height: 39 })
  })

  it('replaces I ♥ ME as a complete group and derives its new photo opening', async () => {
    const s = setup()
    await s.feature.replace([2], 'combo')
    expect(s.env.states[2].motif.placement).toEqual({ x: 0, y: 500, w: 300, h: 300 })
    expect(s.env.states[2].motif.frame).toEqual({ x: 210, y: 575, w: 120, h: 150 })
    expect(s.cfg.slots[2].w).toBe(150)
  })

  it.each([
    ['heart', '小款', 20, 16], ['heart', '大款', 40, 32],
    ['star', '小款', 20, 16], ['star', '大款', 40, 32],
  ] as const)('replaces selected letter groups with a centered %s %s without retaining letters', async (type, variant, nativeW, nativeH) => {
    const s = setup()
    Object.assign(s.cfg, { motifSlots: [
      { variant: '原款', assetId: 'ime-original', box: [0, 0, 300, 300] },
      { variant: '小款', box: [340, 0, 200, 200] },
      { variant: '原款', assetId: 'ive-original', box: [0, 500, 300, 300] },
    ] })
    const asset = s.assets[type]
    Object.assign(asset, { variant, nativeW, nativeH, frame: { x: .5, y: .5, w: .6, h: .6 } })
    expect(s.feature.allowed(asset, [0, 2])).toBe(true)
    expect(s.feature.allowed(s.assets.combo, [0, 2])).toBe(true)
    expect(s.feature.allowed({ ...asset, type: 'circle' }, [0, 2])).toBe(true)
    expect(s.feature.allowed({ ...asset, type: 'square' }, [0, 2])).toBe(true)
    await s.feature.replace([0, 2], type)
    const w = type === 'heart' && variant === '小款' ? 195 : Math.min(nativeW * 10, 300), h = w * nativeH / nativeW
    for (const [id, y] of [[0, 0], [2, 500]] as const) {
      const motif = s.env.states[id].motif
      expect(motif).toMatchObject({ assetId: type, type, backgroundPart: 'whole' })
      const expected = { placement: { x: (300 - w) / 2, y: y + (300 - h) / 2, w, h },
        frame: { x: 150, y: y + 150, w: w * .6, h: h * .6 } }
      for (const key of ['placement', 'frame'] as const) {
        for (const field of ['x', 'y', 'w', 'h'] as const) expect(motif[key][field]).toBeCloseTo(expected[key][field])
      }
    }
    expect(s.env.states[0]).toMatchObject({ size: .62, imageDx: 8 })
    expect(s.env.states[0].background).toBeUndefined()
    expect(s.env.states[1]).toEqual({ size: .8 })
    s.feature.source(s.env.base)
    expect(s.draws.filter(call => call[0] === 'clear')).toEqual([
      ['clear', 0, 0, 300, 300], ['clear', 0, 500, 300, 300],
    ])
    s.feature.restore([0, 2])
    expect(s.feature.source(s.env.base)).toBe(s.env.base)
    expect(s.env.states[0]).toEqual({ size: .62, imageDx: 8 })
  })

  it.each(['小款', '大款'])('allows replacements across %s sizes and shapes, fitting the existing position', async variant => {
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
    expect(s.feature.allowed(s.assets.star, [0, 2])).toBe(true)
    expect(s.feature.allowed({ ...s.assets.star, variant: variant === '小款' ? '大款' : '小款', nativeW: 10, nativeH: 10 }, [0])).toBe(true)
    expect(s.feature.allowed({ ...s.assets.star, type: 'circle', nativeW: 10, nativeH: 10 }, [0])).toBe(true)
    expect(s.feature.allowed(undefined, [0])).toBe(false)
    expect(s.feature.allowed(s.assets.star, [])).toBe(false)
    expect(s.feature.allowed(s.assets.star, [0, 999])).toBe(false)
    await s.feature.replace([0], 'star')
    expect(s.env.states[0].motif).toMatchObject({ assetId: 'star', type: 'star', placement: { x: 0, y: 0, w: 200, h: 200 }, frame: { x: 140, y: 50, w: 80, h: 100 } })
    await s.feature.replace([1], 'combo')
    expect(s.env.states[1].motif).toMatchObject({ assetId: 'combo', placement: { x: 240, y: 0, w: 200, h: 200 },
      frame: { x: 380, y: 50, w: 80, h: 100 } })
    await s.feature.replace([0], 'heart')
    expect(s.env.states[0].motif.placement).toEqual(variant === '小款' ? { x: 2.5, y: 2.5, w: 195, h: 195 } : { x: 0, y: 0, w: 200, h: 200 })
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
    s.env.base = { complete: true, naturalWidth: templates[name].w, naturalHeight: templates[name].h }
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
    expect(s.feature.allowed({ ...(s.assets as any)[selectedAsset], variant: '大款' }, [0])).toBe(true)
    expect(s.feature.allowed((s.assets as any)[firstId], [0])).toBe(true)
    await s.feature.replace([0], selectedAsset)
    expect(s.env.states[0].motif.assetId).toBe(selectedAsset)
    expect(s.env.states[0].imageDx).toBe(8)
    expect(s.env.states[1].motif).toBeUndefined()
    s.feature.source(s.env.base)
    expect(s.draws).toContainEqual(['clear', bounds[0].x - 105, bounds[0].y - 110, 210, 220])
    s.feature.restore([0])
    s.feature.source(s.env.base)
    expect(s.env.states[0].motif?.assetId).toBe(type === 'heart' ? firstId : undefined)
    expect(s.env.states[0]).toMatchObject({ size: .62, imageDx: 8 })
    const restoredRows = s.feature.rows(144, 210)
    catalog.forEach((meta: any, i: number) => {
      if (meta.type === 'heart' && meta.variant === '小款') {
        expect(restoredRows[i].width).toBeCloseTo(19.5)
        expect(restoredRows[i].height / restoredRows[i].width).toBeCloseTo(220 / templates[name].h * 210 / (210 / templates[name].w * 144))
      }
    })
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
      expect(s.feature.allowed({ ...s.assets[assetId], variant: variant === '小款' ? '大款' : '小款' }, [0, 1])).toBe(true)
      expect(s.feature.allowed(s.assets[assetId], [0, 2])).toBe(true)
      await s.feature.replace([0, 1], assetId)
      const smallHeart = assetId === 'heart' && variant === '小款'
      expect(s.env.states[0].motif).toMatchObject({ assetId, type: assetId,
        placement: smallHeart ? { x: 2.5, y: 2.5, w: 195, h: 195 } : { x: 0, y: 0, w: 200, h: 200 } })
      expect(s.env.states[1].motif).toMatchObject({ assetId, type: assetId,
        placement: smallHeart ? { x: 242.5, y: 2.5, w: 195, h: 195 } : { x: 240, y: 0, w: 200, h: 200 } })
      expect(s.env.states[0].imageDx).toBe(8)
      expect(s.env.states[2].motif).toBeUndefined()
    }
    expect(s.feature.allowed(s.assets.combo, [0, 1])).toBe(true)
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

  it.each([
    ['heart', 40, 20, 180, 120, 180, 90, '大款'],
    ['heart', 20, 40, 180, 120, 60, 120, '大款'],
    ['heart', 18, 12, 180, 120, 180, 120, '大款'],
    ['heart', 10, 8, 180, 120, 100, 80, '大款'],
    ['heart', 19.5, 39, 180, 120, 60, 120, '小款'],
    ['heart', 10, 8, 180, 120, 100, 80, '小款'],
    ['star', 40, 20, 180, 120, 180, 90, '大款'],
    ['combo', 40, 20, 180, 120, 180, 90, '原款'],
  ] as const)('fits oversized custom %s %s×%s into %s×%s without enlarging artwork that already fits (%s)', async (assetId, nativeW, nativeH, boxW, boxH, wantW, wantH, variant) => {
    const s = setup()
    s.env.name = '自定义排版.png'
    s.env.cfg = { w: 1440, h: 2100, custom: true,
      slots: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
      placements: [{ assetId: 'heart', x: 100, y: 200, w: boxW, h: boxH },
        { assetId: 'star', x: 500, y: 200, w: 200, h: 200 }] }
    Object.assign(s.env.base, { width: 1440, height: 2100 })
    Object.assign(s.assets[assetId], { nativeW, nativeH, variant })
    const neighbor = structuredClone(s.env.states[1])
    expect(s.feature.allowed(s.assets[assetId], [0])).toBe(true)
    await s.feature.replace([0], assetId)
    const motif = s.env.states[0].motif
    expect(motif.placement.w).toBeCloseTo(wantW)
    expect(motif.placement.h).toBeCloseTo(wantH)
    expect(motif.placement.w / motif.placement.h).toBeCloseTo(nativeW / nativeH)
    expect(motif.placement.x + motif.placement.w / 2).toBeCloseTo(190)
    expect(motif.placement.y + motif.placement.h / 2).toBeCloseTo(260)
    expect(motif.frame.w).toBeCloseTo(wantW * .4)
    expect(s.env.states[0]).toMatchObject({ size: .62, imageDx: 8 })
    s.feature.source(s.env.base)
    expect(s.env.states[0].motif).toBe(motif)
    expect(s.env.states[1]).toEqual(neighbor)
    s.feature.reflow()
    expect(s.env.states[0].motif.placement.w).toBeCloseTo(wantW)
  })

  it('does not regrow fitted custom small hearts or letter groups during rendering or restore', () => {
    const s = setup()
    s.env.name = '自定义排版.png'
    s.env.cfg = { w: 1440, h: 2100, custom: true, slots: [{ row: 0, column: 0 }, { row: 1, column: 0 }],
      placements: [{ assetId: 'heart', x: 10, y: 20, w: 100, h: 90 }, { assetId: 'combo', x: 10, y: 300, w: 150, h: 150 }] }
    s.env.states = [{ size: .62 }, { size: .8 }]
    Object.assign(s.env.base, { width: 1440, height: 2100 })
    expect(s.feature.source(s.env.base)).toBe(s.env.base)
    expect(s.feature.rows(144, 210)[0]).toMatchObject({ width: 10, height: 9 })
    s.feature.restore([0])
    expect(s.feature.source(s.env.base)).toBe(s.env.base)
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
  it.each([
    ['solid', 'heart', '-small', 'rose-heart-small', '浅蓝纯色爱心'],
    ['solid', 'heart', '', 'rose-heart', '浅蓝纯色爱心'],
    ['solid', 'star', '-small', 'mint-star-small', '浅蓝纯色星星'],
    ['solid', 'star', '', 'mint-star', '浅蓝纯色星星'],
    ['stripe', 'heart', '-small', 'rose-heart-small', '浅蓝竖条纹爱心'],
    ['stripe', 'heart', '', 'rose-heart', '浅蓝竖条纹爱心'],
    ['stripe', 'star', '-small', 'mint-star-small', '浅蓝竖条纹星星'],
    ['stripe', 'star', '', 'mint-star', '浅蓝竖条纹星星'],
  ])('offers light-blue %s %s%s with preserved silhouette dimensions and usable selection geometry', async (pattern, type, suffix, originalId, label) => {
    const scope: any = {}
    new Function('globalThis', source('light-blue-motifs.js'))(scope)
    expect(scope.HeartStarLightBlue).toBeDefined()
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    const before = structuredClone(assets), entries = scope.HeartStarLightBlue.register(assets)
    const id = `light-blue-${pattern}-${type}${suffix}`, asset = entries[id], original = assets[originalId!]
    expect(Object.keys(entries)).toHaveLength(8)
    expect(asset).toMatchObject({ type, baseName: label, group: '浅蓝色款', variant: original.variant,
      nativeW: original.nativeW, nativeH: original.nativeH, frame: original.frame })
    const png = readFileSync(new URL(asset.src, directory))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([original.w * 4, original.h * 4])
    expect(png[25]).toBe(6)
    expect(assets).toEqual(before)
    const s = setup()
    Object.assign(s.assets, entries)
    await s.feature.replace([2], id)
    expect(s.env.states[2]).toMatchObject({ size: .62, motif: { assetId: id, type, backgroundPart: 'whole' } })
    expect(s.env.states[0]).toEqual({ size: .62, imageDx: 8, background: { type: 'color' } })
  })
  it.each([
    ['sky-blue-polka-heart-small', 'rose-heart-small', '天蓝波点爱心', '天蓝色款'],
    ['sky-blue-polka-heart', 'rose-heart', '天蓝波点爱心', '天蓝色款'],
    ['sky-blue-stripe-heart-small', 'rose-heart-small', '天蓝竖条纹爱心', '天蓝色款'],
    ['sky-blue-stripe-heart', 'rose-heart', '天蓝竖条纹爱心', '天蓝色款'],
    ['ime-sky-blue-polka', 'ime-rose', '天蓝波点 I ♥ ME', 'I ♥ ME 组合'],
    ['ive-sky-blue-polka', 'ive-rose', '天蓝波点 I ♥ VE', 'I ♥ VE 组合'],
    ['ime-sky-blue-stripe', 'ime-rose', '天蓝竖条纹 I ♥ ME', 'I ♥ ME 组合'],
    ['ive-sky-blue-stripe', 'ive-rose', '天蓝竖条纹 I ♥ VE', 'I ♥ VE 组合'],
  ])('offers %s with proportional artwork and photo geometry without altering existing motifs', async (id, originalId, label, group) => {
    const scope: any = {}
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    new Function('globalThis', source('ive-motifs.js'))(scope)
    Object.assign(assets, scope.HeartStarIVE.register(assets))
    const before = structuredClone(assets)
    new Function('globalThis', source('sky-blue-motifs.js'))(scope)
    expect(scope.HeartStarSkyBlue).toBeDefined()
    const entries = scope.HeartStarSkyBlue.register(assets), original = assets[originalId!], asset = entries[id!]
    expect(Object.keys(entries)).toHaveLength(8)
    expect(asset).toMatchObject({ baseName: label, group, type: 'heart', variant: original.variant,
      nativeW: original.nativeW, nativeH: original.nativeH, frame: original.frame })
    const png = readFileSync(new URL(asset.src, directory))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([original.w * 4, original.h * 4])
    expect(png[25]).toBe(6) // RGBA: retain transparent silhouettes for photo composition.
    expect(assets).toEqual(before)
    const s = setup()
    Object.assign(s.assets, entries)
    await s.feature.replace([2], id!)
    expect(s.env.states[2]).toMatchObject({ size: .62, motif: { assetId: id, type: 'heart',
      backgroundPart: original.variant === '原款' ? 'heart' : 'whole' } })
    expect(s.env.states[0]).toEqual({ size: .62, imageDx: 8, background: { type: 'color' } })
  })
  it.each([
    ['yellow-polka-heart-small', 'rose-heart-small', '黄色波点爱心', '黄色款'],
    ['yellow-polka-heart', 'rose-heart', '黄色波点爱心', '黄色款'],
    ['ime-yellow-polka', 'ime-yellow-glow', '黄色波点 I ♥ ME', 'I ♥ ME 组合'],
    ['ive-yellow-polka', 'ive-yellow-glow', '黄色波点 I ♥ VE', 'I ♥ VE 组合'],
  ])('offers %s with matching photo geometry and leaves other selected artwork unchanged', async (id, originalId, label, group) => {
    const scope: any = {}
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    new Function('globalThis', source('ive-motifs.js'))(scope)
    Object.assign(assets, scope.HeartStarIVE.register(assets))
    const before = structuredClone(assets)
    new Function('globalThis', source('yellow-motifs.js'))(scope)
    const entries = scope.HeartStarYellow?.register(assets) || {}
    const original = assets[originalId!], asset = entries[id!]
    expect(asset).toMatchObject({ baseName: label, group, type: 'heart', variant: original.variant,
      nativeW: original.nativeW, nativeH: original.nativeH, frame: original.frame })
    const png = readFileSync(new URL(asset.src, directory))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([original.w * 4, original.h * 4])
    expect(assets).toEqual(before)
    const s = setup()
    Object.assign(s.assets, entries)
    await s.feature.replace([2], id!)
    expect(s.env.states[2]).toMatchObject({ size: .62, motif: { assetId: id, type: 'heart',
      backgroundPart: original.variant === '原款' ? 'heart' : 'whole' } })
    expect(s.env.states[0]).toEqual({ size: .62, imageDx: 8, background: { type: 'color' } })
  })
  it.each([
    ['heart', '-small', 'rose-heart-small', '棕金豹纹爱心'],
    ['heart', '', 'rose-heart', '棕金豹纹爱心'],
    ['star', '-small', 'mint-star-small', '棕金豹纹星星'],
    ['star', '', 'mint-star', '棕金豹纹星星'],
  ])('offers a gold leopard %s%s without replacing existing black-and-white motifs', async (type, suffix, originalId, label) => {
    const scope: any = {}
    new Function('globalThis', source('gold-leopard-motifs.js'))(scope)
    expect(scope.HeartStarGoldLeopard).toBeDefined()
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    const before = structuredClone(assets), entries = scope.HeartStarGoldLeopard.register(assets)
    expect(Object.keys(entries)).toHaveLength(4)
    const id = `gold-leopard-${type}${suffix}`, asset = entries[id], original = assets[originalId!]
    expect(asset).toMatchObject({ type, baseName: label, variant: original.variant,
      nativeW: original.nativeW, nativeH: original.nativeH, frame: original.frame })
    expect([...readFileSync(new URL(asset.src, directory)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(assets).toEqual(before)
    const s = setup()
    Object.assign(s.assets, entries)
    await s.feature.replace([2], id)
    expect(s.env.states[2]).toMatchObject({ size: .62, motif: { assetId: id, type, backgroundPart: 'whole' } })
    expect(s.env.states[0].motif).toBeUndefined()
  })
  it.each([
    ['heart', '-small', 'rose-heart-small', '大红波点爱心'],
    ['heart', '', 'rose-heart', '大红波点爱心'],
    ['star', '-small', 'mint-star-small', '大红波点星星'],
    ['star', '', 'mint-star', '大红波点星星'],
  ])('offers a usable red polka %s%s with the existing silhouette geometry', async (type, suffix, originalId, label) => {
    const scope: any = {}
    new Function('globalThis', source('red-motifs.js'))(scope)
    expect(scope.HeartStarRed).toBeDefined()
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    const before = structuredClone(assets), entries = scope.HeartStarRed.register(assets)
    expect(Object.keys(entries)).toHaveLength(4)
    const id = `red-polka-${type}${suffix}`, asset = entries[id], original = assets[originalId!]
    expect(asset).toMatchObject({ type, baseName: label, variant: original.variant,
      nativeW: original.nativeW, nativeH: original.nativeH, frame: original.frame })
    expect([...readFileSync(new URL(asset.src, directory)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(assets).toEqual(before)
    const s = setup()
    Object.assign(s.assets, entries)
    await s.feature.replace([2], id)
    expect(s.env.states[2].motif).toMatchObject({ assetId: id, type, backgroundPart: 'whole' })
    expect(s.env.states[2].size).toBe(.62)
    const start = toolHtml.indexOf('function buildCustomLayout(')
    const build = new Function(`${toolHtml.slice(start, toolHtml.indexOf('\n}', start) + 2)};return buildCustomLayout`)()
    const layout = build([{ id: 'r', groups: [{ id: 'g', assetId: id, count: 2 }] }], entries, 144, 210)
    expect(layout.slots).toHaveLength(2)
    expect(layout.placements[0]).toMatchObject({ assetId: id, w: original.nativeW * 10, h: original.nativeH * 10 })
  })
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
    expect(assets.a).toMatchObject({ nativeW: 20, nativeH: 20 })
  })

  it('keeps custom rows at native size when they fit exactly or have extra space', () => {
    const start = toolHtml.indexOf('function buildCustomLayout(')
    const build = new Function(`${toolHtml.slice(start, toolHtml.indexOf('\n}', start) + 2)};return buildCustomLayout`)()
    const assets = { a: { nativeW: 20, nativeH: 10, frame: { x: .5, y: .5, w: .4, h: .6 } } }
    const rows = [{ id: 'r', groups: [{ id: 'g', assetId: 'a', count: 6 }] }]
    for (const width of [136, 144]) {
      const layout = build(rows, assets, width, 210)
      layout.placements.forEach((p: any) => expect(p).toMatchObject({ w: 200, h: 100 }))
      expect(layout.slots[0]).toMatchObject({ w: 80, h: 60 })
    }
  })

})
