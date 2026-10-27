import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function setup() {
  class Canvas {
    width = 0; height = 0; pixels = new Uint8ClampedArray()
    getContext() { return {
      drawImage: (image: any) => { this.pixels = image.pixels.slice() },
      getImageData: () => ({ width: this.width, height: this.height, data: this.pixels.slice() }),
      putImageData: (image: any) => { this.pixels = image.data.slice() },
    } }
  }
  const scope: any = {}, created: string[] = [], document = { createElement(tag: string) { created.push(tag); return new Canvas() } }
  class ImageData { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} }
  for (const file of ['solid-background.js', 'solid-background-quick.js']) {
    let code = ''
    try { code = readFileSync(new URL(`../../public/embedded/heart-star/${file}`, import.meta.url), 'utf8') } catch { /* Checked below. */ }
    new Function('globalThis', 'document', 'ImageData', code)(scope, document, ImageData)
  }
  const original = { width: 3, height: 1, pixels: new Uint8ClampedArray([255,255,255,255,0,0,0,255,255,255,255,255]) }
  const photos: any[] = [original, original, null], applied: any[] = [], messages: string[] = [], changes: boolean[] = []
  let token = {}
  const getBoard = () => ({ token, ready: true, ids: [2], photoAt: (id: number) => photos[id] })
  const store = scope.HeartStarSolidBackground.createStore({ getBoard,
    apply(items: any[]) { applied.push(items); items.forEach(item => { photos[item.id] = item.image }) } })
  const button = { disabled: false, textContent: '', addEventListener() {} }
  expect(scope.HeartStarSolidBackgroundQuick, 'quick processing controller is registered').toBeDefined()
  const feature = scope.HeartStarSolidBackgroundQuick.mount({ button, store, getBoard,
    report: (message: string) => messages.push(message), changed: () => changes.push(feature.busy()) })
  return { feature, button, store, photos, original, applied, messages, created, changes, changeTemplate: () => { token = {} } }
}

describe('one-click solid background removal without dialogs', () => {
  it('immediately applies the detected background removal and supports restoring without changing other positions', async () => {
    const s = setup()
    expect(s.applied).toHaveLength(0)
    await s.feature.process([0, 1])
    expect(s.created).not.toContain('dialog')
    expect(s.photos[0].pixels).toEqual(new Uint8ClampedArray([255,255,255,0,0,0,0,255,255,255,255,0]))
    expect(s.photos[1]).toBe(s.photos[0])
    expect(s.photos[2]).toBeNull()
    expect(s.applied[0].map((item: any) => item.processed)).toEqual([true, true])
    await s.feature.restore([0, 1])
    expect(s.photos).toEqual([s.original, s.original, null])
    expect(s.applied[1].map((item: any) => item.processed)).toEqual([false, false])
  })

  it('disables repeat processing while busy and does not commit results after a template switch', async () => {
    const s = setup()
    const pending = s.feature.process([0, 1])
    expect(s.feature.busy()).toBe(true)
    expect(s.button.disabled).toBe(true)
    await s.feature.process([0, 1])
    s.changeTemplate(); await pending
    expect(s.applied).toHaveLength(0)
    expect(s.photos[0]).toBe(s.original)
    expect(s.feature.busy()).toBe(false)
    expect(s.changes).toEqual([true, false])
  })

  it('preserves the original and does not mark success when no consistent background can be detected', async () => {
    const s = setup()
    s.original.width = 2; s.original.height = 2
    s.original.pixels = new Uint8ClampedArray([255,0,0,255,0,255,0,255,0,0,255,255,0,0,0,255])
    await s.feature.process([0])
    expect(s.applied).toHaveLength(0)
    expect(s.photos[0]).toBe(s.original)
    expect(s.messages.join('')).toContain('未识别到')
    expect(s.feature.busy()).toBe(false)
  })
})
