import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function setup(ids = [0]) {
  const controls = new Map<string, any>(), canvases: any[] = [], messages: string[] = []
  class Element {
    listeners: Record<string, Function> = {}
    children: any[] = []
    disabled = false; hidden = false; open = false; value = ''; textContent = ''; innerHTML = ''; style = {}
    width = 0; height = 0; pixels = new Uint8ClampedArray()
    addEventListener(name: string, fn: Function) { this.listeners[name] = fn }
    async fire(name: string, event: any = {}) { await this.listeners[name]?.(event) }
    append(...items: any[]) { this.children.push(...items) }
    replaceChildren(...items: any[]) { this.children = items }
    querySelector(selector: string) {
      if (!controls.has(selector)) controls.set(selector, new Element())
      return controls.get(selector)
    }
    querySelectorAll() { return [...controls.values()] }
    setAttribute() {}
    showModal() { this.open = true }
    close() { this.open = false; this.listeners.close?.() }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height } }
    getContext() {
      return {
        drawImage: (image: any) => { this.pixels = image.pixels.slice() },
        getImageData: (x: number, y: number, w: number, h: number) => ({
          width: w, height: h, data: w === 1 && h === 1 ? this.pixels.slice((y * this.width + x) * 4, (y * this.width + x) * 4 + 4) : this.pixels.slice(),
        }),
        putImageData: (image: any) => { this.pixels = image.data.slice() },
      }
    }
  }
  const document = { body: new Element(), createElement: (tag: string) => {
    const node = new Element(); if (tag === 'canvas') canvases.push(node); return node
  } }
  const scope: any = {}
  class ImageData { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} }
  for (const file of ['solid-background.js', 'solid-background-dialog.js']) {
    const path = new URL(`../../public/embedded/heart-star/${file}`, import.meta.url)
    let code = ''
    try { code = readFileSync(path, 'utf8') } catch { /* Fails below until the module is implemented. */ }
    new Function('globalThis', 'document', 'ImageData', code)(scope, document, ImageData)
  }
  const original = { width: 3, height: 1, pixels: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]) }
  const photos: any[] = [original, original], applied: any[] = []
  let token: any = {}
  const board = () => ({ token, ready: true, ids, photoAt: (id: number) => photos[id] })
  const store = scope.HeartStarSolidBackground.createStore({ getBoard: board,
    apply(items: any[]) { applied.push(items); items.forEach(item => { photos[item.id] = item.image }) } })
  expect(scope.HeartStarSolidBackgroundDialog).toBeDefined()
  const button = new Element()
  const feature = scope.HeartStarSolidBackgroundDialog.mount({ button, store, getBoard: board, report: (message: string) => messages.push(message) })
  const flush = async () => { await new Promise(resolve => setTimeout(resolve, 160)) }
  return { button, feature, controls, document, original, photos, applied, messages, flush,
    changeTemplate: () => { token = {} } }
}

describe('solid background preview dialog', () => {
  it('opens from a thumbnail without applying to the unrelated current selection', async () => {
    const s = setup([0])
    expect(s.feature.open).toBeTypeOf('function')
    s.feature.open([1]); await s.flush()
    expect(s.applied).toHaveLength(0)
    await s.controls.get('[data-apply]').fire('click')
    expect(s.photos[0]).toBe(s.original)
    expect(s.photos[1]).not.toBe(s.original)
    expect(s.applied[0][0]).toMatchObject({ id: 1, processed: true })
  })

  it('previews without changing photos, then applies only the selected positions and can restore the original', async () => {
    const s = setup()
    await s.button.fire('click'); await s.flush()
    expect(s.applied).toHaveLength(0)
    await s.controls.get('[data-apply]').fire('click')
    expect(s.photos[0].pixels).toEqual(new Uint8ClampedArray([255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0]))
    expect(s.photos[1]).toBe(s.original)
    await s.button.fire('click'); await s.flush()
    await s.controls.get('[data-restore]').fire('click')
    expect(s.photos).toEqual([s.original, s.original])
  })

  it('closing or changing template after preview never writes results back', async () => {
    const s = setup()
    await s.button.fire('click'); await s.flush()
    await s.controls.get('[data-close]').fire('click')
    expect(s.applied).toHaveLength(0)
    await s.button.fire('click'); await s.flush()
    s.changeTemplate()
    await s.controls.get('[data-apply]').fire('click')
    expect(s.applied).toHaveLength(0)
    expect(s.messages.join('')).toMatch(/变化|取消/)
  })

  it('uses a manually chosen color and can reset it to automatic detection', async () => {
    const s = setup()
    await s.button.fire('click'); await s.flush()
    const color = s.controls.get('[data-color]')
    color.value = '#000000'; await color.fire('input'); await s.flush()
    const preview = s.controls.get('[data-result]')
    expect([...preview.pixels].filter((_: number, i: number) => i % 4 === 3)).toEqual([255, 0, 255])
    await s.controls.get('[data-auto]').fire('click'); await s.flush()
    expect([...preview.pixels].filter((_: number, i: number) => i % 4 === 3)).toEqual([0, 255, 0])
    await s.controls.get('[data-close]').fire('click')
    expect(s.photos[0]).toBe(s.original)
  })

  it('calculates the preview at native resolution so thin edges match the final output', async () => {
    const s = setup()
    s.original.width = 721; s.original.height = 3
    s.original.pixels = new Uint8ClampedArray(721 * 3 * 4).fill(255)
    const center = (721 + 360) * 4
    s.original.pixels.set([0, 0, 0, 255], center)
    await s.button.fire('click'); await s.flush()
    const preview = s.controls.get('[data-result]')
    expect([preview.width, preview.height]).toEqual([721, 3])
    expect(preview.pixels[center + 3]).toBe(255)
    const expected = preview.pixels.slice()
    await s.controls.get('[data-apply]').fire('click')
    expect(s.photos[0].pixels).toEqual(expected)
  })

  it('does not pick the previous photo color while the next photo preview is pending', async () => {
    const s = setup([0, 1])
    s.photos[1] = { width: 3, height: 1, pixels: new Uint8ClampedArray([0, 170, 0, 255, 0, 0, 0, 255, 0, 170, 0, 255]) }
    await s.button.fire('click'); await s.flush()
    const picker = s.controls.get('[data-photo]')
    picker.value = '1'; await picker.fire('change')
    await s.controls.get('[data-original]').fire('click', { clientX: 0, clientY: 0 })
    await s.flush()
    expect(s.controls.get('[data-color]').value).toBe('#00aa00')
    expect([...s.controls.get('[data-result]').pixels].filter((_: number, i: number) => i % 4 === 3)).toEqual([0, 255, 0])
  })
})
