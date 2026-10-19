import { describe, expect, it } from 'vitest'
import backgroundSource from '../../public/embedded/heart-star/slot-background.js?raw'

function api() {
  return new Function('globalThis', `${backgroundSource}\nreturn globalThis.HeartStarBackground;`)({})
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
  }
  return { ctx, calls }
}

describe('single-pattern background', () => {
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

  it('draws a rectangular replacement without retaining the old heart or star outline', () => {
    const { ctx, calls } = canvas()
    api().draw(ctx, { background: { type: 'color', color: '#ffccdd' } }, 100, 100, 40, 60,
      () => calls.push('heart'))
    expect(calls).toEqual(['save', ['fill', '#ffccdd', 80, 70, 40, 60], 'restore'])
  })

  it('fits an image proportionally and uses background transforms, not photo transforms', () => {
    const { ctx, calls } = canvas()
    const image = { naturalWidth: 200, naturalHeight: 100 }
    api().draw(ctx, { imageScale: 9, imageDx: 999, background: {
      type: 'image', image, scale: 2, dx: 5, dy: -3,
    } }, 100, 100, 40, 60, () => calls.push('star'))
    expect(calls).toEqual(['save', ['image', image, 65, 77, 80, 40], 'restore'])
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
