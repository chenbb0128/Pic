import { describe, expect, it } from 'vitest'
import source from '../../public/embedded/heart-star/photo-lighting.js?raw'
import controlsSource from '../../public/embedded/heart-star/photo-lighting-controls.js?raw'

const scope: any = {}
new Function('globalThis', source)(scope)
const adjust = scope.HeartStarPhotoLighting.adjust
const pixels = (...colors: number[][]) => ({ width: colors.length, height: 1, data: new Uint8ClampedArray(colors.flat()) })

describe('portrait lighting', () => {
  it('lifts underexposed skin while protecting highlights, black and white', () => {
    const input = pixels([60, 45, 35, 255], [100, 75, 60, 255], [230, 230, 230, 255], [255, 255, 255, 255], [0, 0, 0, 255])
    const before = input.data.slice(), result = adjust(input)
    expect(result.data[0]).toBeGreaterThan(60)
    expect(result.data[1]).toBeGreaterThan(45)
    expect(result.data[0] - 60).toBeGreaterThan(result.data[8] - 230)
    expect(result.data[0] / result.data[1]).toBeCloseTo(60 / 45, 1)
    expect(Array.from(result.data.slice(12))).toEqual([255, 255, 255, 255, 0, 0, 0, 255])
    expect(input.data).toEqual(before)
  })

  it('gives midtone shadows a visible lift at the normal one-click strength', () => {
    const result = adjust(pixels([60, 45, 35, 255], [100, 75, 60, 255], [230, 230, 230, 255]))
    expect(result.data[0]).toBeGreaterThan(112)
    expect(result.data[4]).toBeGreaterThan(155)
    expect(result.data[8]).toBeLessThanOrEqual(235)
  })

  it('still lifts brighter skin midtones clearly at maximum strength', () => {
    const result = adjust(pixels([160, 125, 105, 255], [190, 160, 140, 255], [235, 220, 210, 255]), 200)
    expect(result.data[0]).toBeGreaterThan(180)
    expect(result.data[4]).toBeGreaterThan(205)
    expect(result.data[8]).toBeLessThan(245)
  })

  it('adds local edge contrast without changing transparency', () => {
    const result = adjust(pixels([80, 70, 60, 255], [120, 110, 100, 255], [80, 70, 60, 255]), 100)
    const luminance = (offset: number) => .2126 * result.data[offset] + .7152 * result.data[offset + 1] + .0722 * result.data[offset + 2]
    expect(luminance(4) - luminance(0)).toBeGreaterThan(24)
    expect([result.data[3], result.data[7], result.data[11]]).toEqual([255, 255, 255])
  })

  it('keeps every alpha value and fully transparent RGB intact, including cutout edges', () => {
    const input = pixels([50, 40, 30, 0], [60, 45, 35, 32], [60, 45, 35, 128], [60, 45, 35, 255])
    const result = adjust(input)
    expect(Array.from(result.data.slice(0, 4))).toEqual([50, 40, 30, 0])
    expect([3, 7, 11, 15].map(i => result.data[i])).toEqual([0, 32, 128, 255])
    expect([result.width, result.height]).toEqual([4, 1])
  })

  it('keeps dark hair dark instead of washing it out while lifting nearby skin', () => {
    const result = adjust(pixels([20, 16, 24, 255], [60, 45, 35, 255], [100, 75, 60, 255]))
    expect(result.data[2]).toBeLessThan(50)
    expect(result.data[4]).toBeGreaterThan(60)
  })

  it('still fills a dark portrait when an opaque white background occupies most of the photo', () => {
    const input = pixels(...Array(90).fill([255, 255, 255, 255]), ...Array(10).fill([80, 55, 40, 255]))
    const result = adjust(input)
    expect(result.data[result.data.length - 4]).toBeGreaterThan(105)
    expect(Array.from(result.data.slice(0, 4))).toEqual([255, 255, 255, 255])
  })

  it('restores exact original pixels at zero and increases fill with the strength without clipping', () => {
    const input = pixels([65, 45, 35, 255], [190, 130, 110, 255])
    expect(adjust(input, 0).data).toEqual(input.data)
    const mild = adjust(input, 50), normal = adjust(input, 100), strong = adjust(input, 200)
    expect(mild.data[0]).toBeLessThan(normal.data[0])
    expect(normal.data[0]).toBeLessThan(strong.data[0])
    expect(strong.data[4]).toBeLessThanOrEqual(255)
  })

  it('does not use invisible padding to choose exposure and rejects invalid inputs', () => {
    const face = [65, 45, 35, 255]
    const compact = adjust(pixels(face)), padded = adjust(pixels(...Array(50).fill([255, 255, 255, 0]), face))
    expect(padded.data.slice(-4)).toEqual(compact.data)
    for (const strength of [-1, 201, NaN, Infinity]) expect(() => adjust(pixels(face), strength)).toThrow()
    expect(() => adjust({ width: 10000, height: 10000, data: [] })).toThrow()
    expect(() => adjust({ width: 2, height: 2, data: [] })).toThrow()
  })
})

function setup() {
  const elements = new Map<string, any>()
  const node = (name: string) => {
    if (!elements.has(name)) elements.set(name, { value: '', textContent: '', disabled: false,
      style: { setProperty() {} }, addEventListener() {} })
    return elements.get(name)
  }
  const a = {}, b = {}, photos = [a, a, b], states: any[] = [{ dx: 10 }, { dx: -2 }, { dx: 0 }]
  const board = { token: states, ready: true, ids: [0, 1], states, photoAt: (id: number) => photos[id] }
  const calls: any[] = [], applied: any[] = [], messages: any[] = []
  let prepare = async (image: any, strength: number, cancelled: () => boolean) => {
    calls.push({ image, strength }); if (cancelled()) throw Error('cancelled'); return {}
  }
  const module: any = {}
  new Function('globalThis', controlsSource)(module)
  const feature = module.HeartStarPhotoLightingControls.mount({
    root: { querySelector: (query: string) => node(query), setAttribute() {} },
    processor: { prepare: (...args: any[]) => (prepare as any)(...args) }, getBoard: () => board,
    apply: (ids: number[], strength: number) => {
      applied.push({ ids, strength }); ids.forEach(id => { if (strength) states[id].photoLight = strength; else delete states[id].photoLight })
    }, changed() {}, report: (...args: any[]) => messages.push(args),
  })
  return { feature, board, photos, states, a, b, calls, applied, messages, node,
    setProcessor: (value: typeof prepare) => { prepare = value } }
}

describe('selected portrait lighting controls', () => {
  it('deduplicates repeated originals, changes only selected levels, and never replaces or accumulates on the photos', async () => {
    const s = setup(), before = s.photos.slice()
    await s.feature.setStrength(100)
    expect(s.calls).toEqual([{ image: s.a, strength: 100 }])
    expect(s.states.map(state => state.photoLight)).toEqual([100, 100, undefined])
    await s.feature.setStrength(100)
    expect(s.calls[1].image).toBe(s.a)
    expect(s.photos).toEqual(before)
    await s.feature.setStrength(0)
    expect(s.states).toEqual([{ dx: 10 }, { dx: -2 }, { dx: 0 }])
  })

  it('can target imported positions explicitly even when the canvas selection differs', async () => {
    const s = setup(); s.board.ids = [0, 1]
    await s.feature.setStrength(200, [2])
    expect(s.applied).toEqual([{ ids: [2], strength: 200 }])
    expect(s.states[2]).toHaveProperty('photoLight', 200)
    expect(s.states[0]).not.toHaveProperty('photoLight')
  })

  it('displays mixed strengths and disables controls without selected photos', () => {
    const s = setup()
    s.states[0].photoLight = 70; s.feature.update()
    expect(s.node('[data-light-value]').value).toBe('混合')
    s.board.ids = []; s.feature.update()
    expect(s.node('[data-light-auto]').disabled).toBe(true)
    expect(s.node('[data-light-strength]').disabled).toBe(true)
    expect(s.node('[data-light-value]').value).toBe('—')
  })

  it.each(['template', 'photo', 'failure'])('keeps the whole batch unchanged after %s changes during processing', async cause => {
    const s = setup(); s.board.ids = [0, 2]
    s.setProcessor(async () => {
      if (cause === 'template') s.board.token = []
      if (cause === 'photo') s.photos[0] = s.b
      if (cause === 'failure') throw Error('failed')
      return {}
    })
    await s.feature.setStrength(100)
    expect(s.applied).toEqual([])
    expect(s.states.every(state => state.photoLight === undefined)).toBe(true)
    expect(s.feature.busy()).toBe(false)
  })

  it('uses only the latest strength during fast slider changes', async () => {
    const s = setup()
    const first = s.feature.setStrength(100), second = s.feature.setStrength(160)
    await Promise.all([first, second])
    expect(s.applied).toEqual([{ ids: [0, 1], strength: 160 }])
    expect(s.feature.busy()).toBe(false)
  })
})
