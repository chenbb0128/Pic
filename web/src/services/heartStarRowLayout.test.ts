import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function planner() {
  const path = new URL('../../public/embedded/heart-star/row-layout.js', import.meta.url)
  const scope: any = {}
  new Function('globalThis', existsSync(path) ? readFileSync(path, 'utf8') : '')(scope)
  return scope.HeartStarRowLayout?.plan
}

function fixture() {
  const boxes = [[30, 500, 300, 300], [390, 500, 300, 300], [750, 500, 300, 300], [1110, 500, 300, 300]]
  const catalog = [
    { index: 0, row: 0, column: 0, box: [30, 100, 200, 200], assetId: 'old' },
    ...boxes.map((box, i) => ({ index: i + 1, row: 1, column: i, box, assetId: 'old' })),
    { index: 5, row: 2, column: 0, box: [30, 900, 200, 200], assetId: 'old' },
  ]
  return { cfg: { w: 1440, h: 2100, slots: catalog.map(meta => ({ x: meta.box[0]! + 100, y: meta.box[1]! + 100, w: 120, h: 120, type: 'heart' })) },
    catalog, ids: [2], count: 6, widthMm: 144, heightMm: 210, assetId: 'small',
    asset: { nativeW: 19.5, nativeH: 18, frame: { x: .5, y: .5, w: .5, h: .5 }, type: 'heart', baseName: '小爱心', variant: '小款' } }
}

describe('heart-star whole row layout', () => {
  it('changes four large motifs into six small motifs within the original row, preserving neighbors and photo order', () => {
    const input = fixture(), plan = planner()
    expect(plan, '整排调整功能尚未实现').toBeTypeOf('function')
    const result = plan(input)
    expect(result.catalog).toHaveLength(8)
    expect(result.sourceIndices).toEqual([0, 1, 2, 3, 4, 1, 2, 5])
    expect(result.selected).toEqual([1, 2, 3, 4, 5, 6])
    expect(result.slots[0]).toBe(input.cfg.slots[0])
    expect(result.slots[7]).toBe(input.cfg.slots[5])
    expect(result.catalog[7]).toMatchObject({ index: 7, row: 2, box: [30, 900, 200, 200] })
    const row = result.catalog.slice(1, 7)
    row.forEach((meta: any) => {
      expect(meta.box[2]).toBeCloseTo(195)
      expect(meta.box[3]).toBeCloseTo(180)
      expect(meta.box[1]).toBeCloseTo(560)
      expect(meta.rowBounds).toEqual([30, 500, 1380, 300])
    })
    expect(row[0].box[0]).toBeCloseTo(30)
    expect(row[5].box[0]).toBeCloseTo(1215)
    expect(result.slots[1]).toMatchObject({ x: 127.5, y: 650, w: 97.5, h: 90, type: 'heart' })
    expect(input.cfg.slots).toHaveLength(6)
    expect(input.catalog[5]!.index).toBe(5)
  })

  it('keeps the original row capacity across repeated edits and centers a single motif', () => {
    const input = fixture(), plan = planner()
    expect(plan).toBeTypeOf('function')
    const first = plan({ ...input, count: 1 })
    expect(first.catalog[1].box).toEqual([622.5, 560, 195, 180])
    const next = plan({ ...input, cfg: { ...input.cfg, slots: first.slots }, catalog: first.catalog, ids: [1], count: 4,
      asset: { ...input.asset, nativeW: 30, nativeH: 30 } })
    expect(next.catalog).toHaveLength(6)
    expect(next.catalog[1].box).toEqual([30, 500, 300, 300])
    expect(next.sourceIndices).toEqual([0, 1, 1, 1, 1, 2])
  })

  it.each([
    { count: 12 }, { count: 0 }, { count: 2.5 }, { ids: [0, 1] },
    { asset: { ...fixture().asset, nativeH: 31 } },
  ])('rejects invalid or overflowing requests without changing the template: %j', changes => {
    const input = fixture(), plan = planner(), before = structuredClone(input)
    expect(plan).toBeTypeOf('function')
    expect(() => plan({ ...input, ...changes })).toThrow()
    expect(input).toEqual(before)
  })

  it('updates custom placements and stable slot keys for subsequent row configuration edits', () => {
    const input = fixture(), plan = planner()
    expect(plan).toBeTypeOf('function')
    const placements = input.catalog.map(meta => ({ assetId: 'old', x: meta.box[0], y: meta.box[1], w: meta.box[2], h: meta.box[3], key: `old-${meta.index}` }))
    const result = plan({ ...input, cfg: { ...input.cfg, custom: true, placements }, keyPrefix: 'r1:g1' })
    expect(result.placements).toHaveLength(8)
    expect(result.placements[0]).toBe(placements[0])
    expect(result.placements[7]).toBe(placements[5])
    expect(result.slots[6].key).toBe('r1:g1:5')
    expect(result.placements[6]).toMatchObject({ assetId: 'small', key: 'r1:g1:5', x: 1215, y: 560, w: 195, h: 180 })
  })

  it('retains neighbor state identities and processed photo flags while fitting photos in the rebuilt row', () => {
    const input = fixture(), result = planner()(input), scope: any = {}
    new Function('globalThis', readFileSync(new URL('../../public/embedded/heart-star/row-layout.js', import.meta.url), 'utf8'))(scope)
    const states = Array.from({ length: 6 }, (_, index) => ({ size: 2, imageScale: 3, imageDx: 17, dx: 12, photoBackgroundRemoved: index === 1,
      motif: { assetId: 'old' }, background: { type: 'color' } }))
    const next = scope.HeartStarRowLayout.remapStates(states, result)
    expect(next[0]).toBe(states[0])
    expect(next[7]).toBe(states[5])
    expect(next[1]).toMatchObject({ size: .62, dx: 0, imageScale: 1, imageDx: 0, photoBackgroundRemoved: true })
    expect(next[5].photoBackgroundRemoved).toBe(true)
    expect(next[1]).not.toHaveProperty('motif')
    expect(next[1]).not.toHaveProperty('background')
    expect(next[1]).not.toBe(next[5])
  })
})

function editorSetup() {
  const scope: any = {}, input = fixture(), messages: string[] = []
  const paint = { drawImage() {}, clearRect() {} }
  const document = { createElement: () => ({ getContext: () => paint, width: 0, height: 0 }) }
  for (const name of ['row-layout.js', 'template-motifs.js'])
    new Function('globalThis', 'document', readFileSync(new URL(`../../public/embedded/heart-star/${name}`, import.meta.url), 'utf8'))(scope, document)
  const env: any = { cfg: { ...input.cfg, motifSlots: input.catalog }, states: Array.from({ length: 6 }, () => ({ size: .62 })),
    base: { naturalWidth: 1440, naturalHeight: 2100 }, commits: [], width: 144 }
  let load = async () => ({ naturalWidth: 195, naturalHeight: 180 })
  const feature = scope.HeartStarMotifs.create({ getName: () => 'test', getTemplate: () => env.cfg, getStates: () => env.states,
    getSelection: () => new Set([2]), getSource: () => env.base, assets: { small: input.asset },
    getSize: () => [env.width, 210], loadImage: () => load(), redraw() {}, report: (message: string) => messages.push(message),
    loadRowSource: async () => ({ naturalWidth: 1440, naturalHeight: 2100 }),
    applyRow: (result: any, source: any) => { env.commits.push(result); env.cfg.slots = result.slots; env.cfg.motifSlots = result.catalog;
      env.states = scope.HeartStarRowLayout.remapStates(env.states, result); env.base = source },
  })
  return { feature, env, messages, set load(value: typeof load) { load = value } }
}

describe('heart-star row replacement transaction', () => {
  it('commits the complete new row once after loading the artwork', async () => {
    const s = editorSetup()
    expect(s.feature.replaceRow).toBeTypeOf('function')
    expect(await s.feature.replaceRow([2], 'small', 6)).toBe(true)
    expect(s.env.commits).toHaveLength(1)
    expect(s.env.states).toHaveLength(8)
    expect(s.feature.busy()).toBe(false)
    expect(s.feature.catalog()[7]).toMatchObject({ index: 7, row: 2 })
  })

  it.each(['template', 'paper size'])('does not apply a delayed row edit after changing %s', async change => {
    const s = editorSetup()
    expect(s.feature.replaceRow).toBeTypeOf('function')
    let resolve!: (image: any) => void
    s.load = () => new Promise(done => { resolve = done })
    const pending = s.feature.replaceRow([2], 'small', 6)
    expect(s.feature.busy()).toBe(true)
    if (change === 'template') s.env.states = []
    else s.env.width = 210
    resolve({ naturalWidth: 195, naturalHeight: 180 })
    await pending
    expect(s.env.commits).toHaveLength(0)
    expect(s.feature.busy()).toBe(false)
  })

  it('leaves all artwork and photos unchanged when the requested row cannot fit', async () => {
    const s = editorSetup(), before = s.env.states
    expect(s.feature.replaceRow).toBeTypeOf('function')
    expect(await s.feature.replaceRow([2], 'small', 12)).toBe(false)
    expect(s.env.commits).toHaveLength(0)
    expect(s.env.states).toBe(before)
    expect(s.messages.some(message => message.includes('放不下'))).toBe(true)
  })
})
