import { describe, expect, it } from 'vitest'
import backgroundSource from '../../public/embedded/heart-star/slot-background.js?raw'

function api(layer?: ReturnType<typeof canvas>) {
  const document = { createElement: () => layer?.element }
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
  }
  const element = { width: 0, height: 0, getContext: () => ctx }
  return { ctx, calls, element }
}

describe('single-pattern background', () => {
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

  it('uses the original template alpha as the outline instead of producing a rectangular background', () => {
    const { ctx, calls } = canvas()
    const layer = canvas(), source = { width: 500, height: 500 }
    api(layer).draw(ctx, { background: { type: 'color', color: '#ffccdd' } }, 100, 100, 40, 60, source)
    expect(layer.calls).toEqual([['scale', 1, 1], ['fill', '#ffccdd', 0, 0, 40, 60],
      ['composite', 'destination-in'], ['image', source, 80, 70, 40, 60, 0, 0, 40, 60]])
    expect(calls).toEqual([['image', layer.element, 80, 70, 40, 60]])
  })

  it('covers the original silhouette proportionally and uses background transforms, not photo transforms', () => {
    const { ctx, calls } = canvas()
    const layer = canvas(), source = { width: 500, height: 500 }
    const image = { naturalWidth: 200, naturalHeight: 100 }
    api(layer).draw(ctx, { imageScale: 9, imageDx: 999, background: {
      type: 'image', image, scale: 2, dx: 5, dy: -3,
    } }, 100, 100, 40, 60, source)
    expect(layer.calls).toEqual([['scale', 1, 1], ['image', image, -95, -33, 240, 120],
      ['composite', 'destination-in'], ['image', source, 80, 70, 40, 60, 0, 0, 40, 60]])
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
