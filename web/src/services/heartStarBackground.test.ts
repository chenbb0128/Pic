import { describe, expect, it } from 'vitest'
import backgroundSource from '../../public/embedded/heart-star/slot-background.js?raw'

function api(layer?: ReturnType<typeof canvas>, outline = canvas()) {
  let created = 0
  const document = { createElement: () => created++ === 0 ? layer?.element : outline.element }
  return new Function('globalThis', 'document', `${backgroundSource}\nreturn globalThis.HeartStarBackground;`)({}, document)
}

function canvas() {
  const calls: any[] = []
  const ctx = {
    fillStyle: '',
    save() { calls.push('save') }, restore() { calls.push('restore') },
    beginPath() { calls.push('beginPath') },
    rect(...args: number[]) { calls.push(['rect', ...args]) },
    clip(rule?: string) { calls.push(rule ? ['clip', rule] : 'clip') },
    fillRect(...args: number[]) { calls.push(['fill', this.fillStyle, ...args]) },
    drawImage(...args: any[]) { calls.push(['image', ...args]) },
    set globalCompositeOperation(value: string) { calls.push(['composite', value]) },
    getTransform() { return { a: 1, d: 1 } },
    scale(...args: number[]) { calls.push(['scale', ...args]) },
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: new Uint8ClampedArray(w * h * 4) }
    },
    putImageData() {},
  }
  const element = { width: 0, height: 0, getContext: () => ctx }
  return { ctx, calls, element }
}

describe('single-pattern background', () => {
  it('reuses unchanged background layers and refreshes only for background, outline or resolution changes', () => {
    const layer = canvas(), feature = api(layer), target = canvas(), source = { width: 500, height: 500 }
    const state = { imageScale: 1, background: { type: 'color', color: '#ffccdd', dx: 0 } }
    feature.draw(target.ctx, state, 100, 100, 40, 60, source)
    const firstPass = layer.calls.length
    state.imageScale = 2
    feature.draw(target.ctx, state, 100, 100, 40, 60, source)
    expect(layer.calls).toHaveLength(firstPass)
    expect(target.calls).toHaveLength(2)
    state.background.color = '#abcdef'
    feature.draw(target.ctx, state, 100, 100, 40, 60, source)
    expect(layer.calls.length).toBeGreaterThan(firstPass)
    const afterColor = layer.calls.length
    state.background.dx = 5
    feature.draw(target.ctx, state, 100, 100, 40, 60, source)
    expect(layer.calls.length).toBeGreaterThan(afterColor)
    const afterOffset = layer.calls.length
    target.ctx.getTransform = () => ({ a: 2, d: 2 })
    feature.draw(target.ctx, state, 100, 100, 40, 60, source)
    expect(layer.element.width).toBe(80)
    expect(layer.element.height).toBe(120)
    expect(layer.calls.length).toBeGreaterThan(afterOffset)
    const afterResolution = layer.calls.length
    feature.draw(target.ctx, state, 120, 100, 40, 60, source)
    expect(layer.calls.length).toBeGreaterThan(afterResolution)
    const afterPosition = layer.calls.length
    feature.draw(target.ctx, state, 120, 100, 40, 60, { width: 500, height: 500 })
    expect(layer.calls.length).toBeGreaterThan(afterPosition)
  })

  it('fills old pattern holes and interior transparency while retaining only the outer silhouette', () => {
    const pixels = new Uint8ClampedArray(7 * 7 * 4)
    for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) {
      const i = (y * 7 + x) * 4
      pixels[i] = 220
      pixels[i + 3] = x === 3 && y === 3 ? 0 : x === 2 && y === 3 ? 50 : 255
    }
    pixels[(1 * 7 + 1) * 4 + 3] = 64
    const before = pixels.slice()
    const mask = api().outerMask(pixels, 7, 7)
    expect(mask[(3 * 7 + 3) * 4 + 3]).toBe(255)
    expect(mask[(3 * 7 + 2) * 4 + 3]).toBe(255)
    expect(mask[(1 * 7 + 1) * 4 + 3]).toBe(64)
    expect(mask[(0 * 7 + 3) * 4 + 3]).toBe(0)
    expect(mask[(3 * 7 + 0) * 4 + 3]).toBe(0)
    expect(mask[(3 * 7 + 2) * 4]).toBe(0)
    expect(pixels).toEqual(before)
  })

  it('does not fill exterior notches or the transparent space between separate shapes', () => {
    const pixels = new Uint8ClampedArray(9 * 5 * 4)
    for (let y = 0; y < 5; y++) for (let x = 0; x < 9; x++) {
      if (x < 3 || x > 5) pixels[(y * 9 + x) * 4 + 3] = 255
    }
    pixels[(1 * 9 + 1) * 4 + 3] = 0
    pixels[(0 * 9 + 1) * 4 + 3] = 0
    const mask = api().outerMask(pixels, 9, 5)
    expect(mask[(1 * 9 + 1) * 4 + 3]).toBe(0)
    expect(mask[(2 * 9 + 4) * 4 + 3]).toBe(0)
    expect(mask[(2 * 9 + 1) * 4 + 3]).toBe(255)
    expect(mask[(2 * 9 + 7) * 4 + 3]).toBe(255)
  })

  it('resizes selected background patterns live with synchronized slider and number controls', () => {
    const controls = new Map<string, any>()
    const document = { getElementById(id: string) {
      if (!controls.has(id)) controls.set(id, Object.assign(new EventTarget(), { value: '' }))
      return controls.get(id)
    } }
    const layer = canvas(), outline = canvas()
    let created = 0
    const feature = new Function('globalThis', 'document',
      `${backgroundSource}\nreturn globalThis.HeartStarBackground;`)({}, {
        ...document, createElement: () => created++ === 0 ? layer.element : outline.element,
      })
    const image = { naturalWidth: 200, naturalHeight: 100 }, source = { width: 500, height: 500 }
    const states = [
      { imageScale: 2, imageDx: 15, background: { type: 'image', image, scale: 1, dx: 0, dy: 0 } },
      { background: { type: 'image', image, scale: 1, dx: 0, dy: 0 } },
    ]
    const controller = feature.create({ getStates: () => states, getSelection: () => new Set([0]),
      getTemplate: () => ({}), report() {},
      redraw() { feature.draw(canvas().ctx, states[0], 100, 100, 40, 60, source) },
    })
    controller.update()
    const slider = document.getElementById('slotBackgroundScaleRange')
    const number = document.getElementById('slotBackgroundScale')
    slider.value = '800'
    slider.dispatchEvent(new Event('input'))
    expect(states[0]!.background.scale).toBe(8)
    expect(states[1]!.background.scale).toBe(1)
    expect(number.value).toBe('800')
    expect(layer.calls).toContainEqual(['image', image, -460, -210, 960, 480])
    expect(layer.calls).toContainEqual(['image', outline.element, 80, 70, 40, 60, 0, 0, 40, 60])
    expect(states[0]!.imageScale).toBe(2)
    expect(states[0]!.imageDx).toBe(15)
    number.value = '250'
    number.dispatchEvent(new Event('input'))
    expect(states[0]!.background.scale).toBe(2.5)
    expect(slider.value).toBe('250')
    number.value = ''
    number.dispatchEvent(new Event('input'))
    expect(states[0]!.background.scale).toBe(2.5)
    number.value = '1200'
    number.dispatchEvent(new Event('change'))
    expect(states[0]!.background.scale).toBe(10)
    expect(slider.value).toBe('1000')
    document.getElementById('slotBackgroundReset').dispatchEvent(new Event('click'))
    expect(states[0]!.background.scale).toBe(1)
    expect(slider.value).toBe('100')
    expect(number.value).toBe('100')
  })

  it('uses the selection from opening the background file picker, not a later selection', () => {
    const controls = new Map<string, any>(), images: any[] = []
    const document = { getElementById(id: string) {
      if (!controls.has(id)) controls.set(id, Object.assign(new EventTarget(), {
        value: '', files: null, click(this: EventTarget) { this.dispatchEvent(new Event('click')) },
      }))
      return controls.get(id)
    } }
    const Image = class { constructor() { images.push(this) } }
    const feature = new Function('globalThis', 'document', 'Image', 'URL',
      `${backgroundSource}\nreturn globalThis.HeartStarBackground;`)({}, document, Image,
      { createObjectURL: () => 'bg-url', revokeObjectURL() {} })
    const states: any[] = [{}, {}, {}]
    let selection = new Set([0, 2])
    feature.create({ getStates: () => states, getSelection: () => selection,
      getTemplate: () => ({}), redraw() {}, report() {} })
    document.getElementById('slotBackgroundUpload').click()
    selection = new Set([1])
    const file = document.getElementById('slotBackgroundFile')
    file.files = [{ type: 'image/png' }]
    file.dispatchEvent(new Event('change'))
    images[0].naturalWidth = 100
    images[0].naturalHeight = 100
    images[0].onload()
    expect(states[0].background?.image).toBe(images[0])
    expect(states[2].background?.image).toBe(images[0])
    expect(states[1].background).toBeUndefined()
  })

  it('does not draw anything by default, preserving the original template', () => {
    const { ctx, calls } = canvas()
    api().draw(ctx, {}, 100, 100, 40, 60, () => calls.push('shape'))
    expect(calls).toEqual([])
  })

  it('only updates selected patterns with independent settings and preserves photo transforms', () => {
    const feature = api()
    const states: any[] = [{ imageScale: 2 }, {}, {}]
    feature.apply(states, new Set([0, 2]), { type: 'color', color: '#ffccdd' })
    expect(states[0].imageScale).toBe(2)
    expect(states[1].background).toBeUndefined()
    expect(states[0].background.color).toBe('#ffccdd')
    states[0].background.color = '#ffffff'
    expect(states[2].background.color).toBe('#ffccdd')
    feature.apply(states, new Set([0]), { type: 'none' })
    expect(feature.has(states[0])).toBe(false)
    expect(feature.has(states[2])).toBe(true)
  })

  it('clips the new background with the filled outline rather than the old template texture', () => {
    const { ctx, calls } = canvas()
    const layer = canvas(), outline = canvas(), source = { width: 500, height: 500 }
    api(layer, outline).draw(ctx, { background: { type: 'color', color: '#ffccdd' } }, 100, 100, 40, 60, source)
    expect(layer.calls).toEqual([['scale', 1, 1], ['fill', '#ffccdd', 0, 0, 40, 60],
      ['composite', 'destination-in'], ['image', outline.element, 80, 70, 40, 60, 0, 0, 40, 60]])
    expect(calls).toEqual([['image', layer.element, 80, 70, 40, 60]])
  })

  it('covers the original silhouette proportionally and uses background transforms, not photo transforms', () => {
    const { ctx, calls } = canvas()
    const layer = canvas(), outline = canvas(), source = { width: 500, height: 500 }
    const image = { naturalWidth: 200, naturalHeight: 100 }
    api(layer, outline).draw(ctx, { imageScale: 9, imageDx: 999, background: {
      type: 'image', image, scale: 2, dx: 5, dy: -3,
    } }, 100, 100, 40, 60, source)
    expect(layer.calls).toEqual([['scale', 1, 1], ['image', image, -95, -33, 240, 120],
      ['composite', 'destination-in'], ['image', outline.element, 80, 70, 40, 60, 0, 0, 40, 60]])
    expect(calls).toEqual([['image', layer.element, 80, 70, 40, 60]])
  })

  it('does not expand or move the photo frame when a background is enabled on a combination pattern', () => {
    const cfg = { custom: true, slots: [{ x: 30, y: 15, w: 10, h: 12, type: 'heart' }],
      placements: [{ x: 0, y: 0, w: 40, h: 50 }] }
    const states = [{ background: { type: 'color', color: '#ffccdd' } }]
    expect(api().frame(cfg, {}, states, 0)).toEqual({ x: 30, y: 15, w: 10, h: 12, type: 'heart' })
  })

  it('removes only replaced artwork from the base and restores the untouched base after clearing', () => {
    const feature = api()
    const { ctx, calls } = canvas()
    const cfg = { w: 100, h: 50, custom: true, slots: [{}, {}], placements: [
      { x: 0, y: 0, w: 40, h: 50 }, { x: 60, y: 0, w: 40, h: 50 },
    ] }
    const source = {}
    const states = [{ background: { type: 'color', color: '#ffccdd' } }, {}]
    feature.drawTemplate(ctx, cfg, source, states)
    expect(calls).toEqual(['save', 'beginPath', ['rect', 0, 0, 100, 50], ['rect', 0, 0, 40, 50],
      ['clip', 'evenodd'], ['image', source, 0, 0, 100, 50], 'restore'])
    calls.length = 0
    feature.apply(states, [0], { type: 'none' })
    feature.drawTemplate(ctx, cfg, source, states)
    expect(calls).toEqual([['image', source, 0, 0, 100, 50]])
  })

  it('finds the complete artwork including text outside the original photo opening', () => {
    const feature = api()
    const cfg = { w: 12, h: 10, slots: [
      { x: 2, y: 2, w: 2, h: 2 }, { x: 10, y: 2, w: 2, h: 2 },
      { x: 4, y: 7, w: 2, h: 2, bottom: true }, { x: 10, y: 7, w: 2, h: 2, bottom: true },
    ] }
    const pixels = new Uint8ClampedArray(12 * 10 * 4)
    for (const [x, y] of [[0, 6], [4, 9], [8, 6], [10, 9]]) pixels[(y! * 12 + x!) * 4 + 3] = 255
    const bounds = feature.measureRegions(cfg, pixels)
    expect(bounds[2]).toEqual({ x: 2.5, y: 8, w: 5, h: 4 })
    expect(bounds[3]).toEqual({ x: 9.5, y: 8, w: 3, h: 4 })
  })

  it('keeps the top of a larger next-row pattern out of the previous row background', () => {
    const cfg = { w: 20, h: 30, slots: [
      { x: 3, y: 5, w: 4, h: 4 }, { x: 15, y: 5, w: 4, h: 4 },
      { x: 5, y: 19, w: 8, h: 8 }, { x: 15, y: 19, w: 8, h: 8 },
    ] }
    const pixels = new Uint8ClampedArray(20 * 30 * 4)
    for (const [left, top, right, bottom] of [[1, 3, 5, 9], [13, 3, 17, 9], [1, 11, 10, 27], [12, 11, 20, 27]]) {
      for (let y = top!; y < bottom!; y++) for (let x = left!; x < right!; x++) pixels[(y * 20 + x) * 4 + 3] = 255
    }
    expect(api().measureRegions(cfg, pixels)).toEqual([
      { x: 3, y: 6, w: 4, h: 6 }, { x: 15, y: 6, w: 4, h: 6 },
      { x: 5.5, y: 19, w: 9, h: 16 }, { x: 16, y: 19, w: 8, h: 16 },
    ])
  })

  it('keeps complete neighboring patterns when their artwork crosses the column midpoint', () => {
    const cfg = { w: 20, h: 12, slots: [
      { x: 4, y: 6, w: 2, h: 2 }, { x: 14, y: 6, w: 2, h: 2 },
    ] }
    const pixels = new Uint8ClampedArray(20 * 12 * 4)
    for (let y = 2; y < 10; y++) for (let x = 0; x < 20; x++) {
      if (x < 6 || x >= 7) pixels[(y * 20 + x) * 4 + 3] = 255
    }
    expect(api().measureRegions(cfg, pixels)).toEqual([
      { x: 3, y: 6, w: 6, h: 8 }, { x: 13.5, y: 6, w: 13, h: 8 },
    ])
  })

  it('does not export a background image before it has successfully loaded', () => {
    const feature = api()
    const { ctx, calls } = canvas()
    const state = { background: { type: 'image', image: { naturalWidth: 0, naturalHeight: 0 } } }
    expect(feature.has(state)).toBe(false)
    feature.draw(ctx, state, 100, 100, 40, 60, () => calls.push('shape'))
    expect(calls).toEqual([])
    expect(feature.has({ background: { type: 'color', color: 'invalid' } })).toBe(false)
  })
})
