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
    clip() { calls.push('clip') },
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

  it('clips a solid background to the current pattern and restores the canvas afterwards', () => {
    const { ctx, calls } = canvas()
    api().draw(ctx, { background: { type: 'color', color: '#ffccdd' } }, 100, 100, 40, 60,
      () => calls.push('heart'))
    expect(calls).toEqual(['save', 'heart', 'clip', ['fill', '#ffccdd', 80, 70, 40, 60], 'restore'])
  })

  it('fits an image proportionally and uses background transforms, not photo transforms', () => {
    const { ctx, calls } = canvas()
    const image = { naturalWidth: 200, naturalHeight: 100 }
    api().draw(ctx, { imageScale: 9, imageDx: 999, background: {
      type: 'image', image, scale: 2, dx: 5, dy: -3,
    } }, 100, 100, 40, 60, () => calls.push('star'))
    expect(calls).toEqual(['save', 'star', 'clip', ['image', image, -15, 37, 240, 120], 'restore'])
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
