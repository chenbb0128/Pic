import { describe, expect, it } from 'vitest'
import backgroundSource from '../../public/embedded/heart-star/slot-background.js?raw'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function surface(pixels = new Uint8ClampedArray(12 * 10 * 4)) {
  const calls: any[] = []
  const ctx: any = {
    save() {}, restore() {}, beginPath() {}, clearRect() {}, scale() {},
    rect(...args: number[]) { calls.push(['rect', ...args]) },
    clip(rule?: string) { calls.push(['clip', rule]) },
    drawImage(...args: any[]) { calls.push(['image', ...args]) },
    fillRect(...args: number[]) { calls.push(['fill', ...args]) },
    getTransform: () => ({ a: 1, d: 1 }),
    getImageData: () => ({ data: pixels.slice() }), putImageData() {},
    set globalCompositeOperation(mode: string) { calls.push(['composite', mode]) },
  }
  const element = { width: 0, height: 0, getContext: () => ctx }
  return { ctx, calls, element }
}

function setup(pixels?: Uint8ClampedArray) {
  const controls = new Map<string, any>(), surfaces: ReturnType<typeof surface>[] = []
  const document = {
    getElementById(id: string) {
      if (!controls.has(id)) controls.set(id, Object.assign(new EventTarget(), { value: '', disabled: false }))
      return controls.get(id)
    },
    createElement() { const item = surface(pixels); surfaces.push(item); return item.element },
  }
  const api = new Function('globalThis', 'document', `${backgroundSource};return globalThis.HeartStarBackground`)({}, document)
  return { api, document, surfaces }
}

function combination(custom: boolean) {
  const pixels = new Uint8ClampedArray(12 * 10 * 4)
  for (const [left, top, right, bottom] of [[1, 1, 3, 5], [6, 1, 11, 5], [1, 6, 11, 9]]) {
    for (let y = top!; y < bottom!; y++) for (let x = left!; x < right!; x++) pixels[(y * 12 + x) * 4 + 3] = 255
  }
  // A photo opening in the heart must be filled by the outline, not punched out.
  pixels[(2 * 12 + 8) * 4 + 3] = 0
  const cfg = { w: 12, h: 10, custom, slots: [
    { x: 8, y: 3, w: 3, h: 2, bottom: !custom, backgroundPart: custom ? 'heart' : undefined },
  ], placements: [{ x: 1, y: 1, w: 10, h: 8 }] }
  return { pixels, cfg, source: { naturalWidth: 12, naturalHeight: 10 } }
}

describe('heart-star photo-only modes', () => {
  it.each(['transparent', 'outline'])('applies %s only to selected slots and restores the original photo settings', type => {
    const { api, document } = setup()
    const states: any[] = [{ size: .62, dx: 4, imageScale: 2 }, { size: .8 }, { size: .4 }]
    const controller = api.create({ getStates: () => states, getSelection: () => new Set([0, 2]),
      getTemplate: () => ({}), redraw() {}, report() {} })
    const mode = document.getElementById('slotBackgroundMode')
    mode.value = type
    mode.dispatchEvent(new Event('change'))
    expect(api.has(states[0])).toBe(true)
    expect(states[0].background.type).toBe(type)
    expect(states[2].background.type).toBe(type)
    expect(states[1]).toEqual({ size: .8 })
    expect(states[0]).toMatchObject({ size: .62, dx: 4, imageScale: 2 })
    expect(controller.hasAny()).toBe(false) // An empty mode cannot enable blank PNG downloads.
    expect(document.getElementById('slotBackgroundNote').textContent).toContain('字母')
    document.getElementById('slotBackgroundClear').dispatchEvent(new Event('click'))
    expect(states).toEqual([{ size: .62, dx: 4, imageScale: 2 }, { size: .8 }, { size: .4 }])
  })

  it.each([false, true])('removes the entire selected combination, including I / ME lettering (custom: %s)', custom => {
    const { pixels, cfg, source } = combination(custom)
    const { api } = setup(pixels)
    for (const type of ['transparent', 'outline']) {
      const target = surface()
      api.drawTemplate(target.ctx, cfg, source, [{ background: { type } }])
      expect(target.calls).toContainEqual(['rect', 1, 1, 10, 8])
      expect(target.calls).not.toContainEqual(['rect', 6, 1, 5, 4])
      expect(target.calls).toContainEqual(['clip', 'evenodd'])
    }
  })

  it('uses the full slot at entry size and contains cutouts without clipping, stretching, or painting a background', () => {
    const { api, surfaces } = setup()
    const cfg = { w: 100, h: 60, custom: true, slots: [{ x: 20, y: 30, w: 10, h: 10 }],
      placements: [{ x: 0, y: 0, w: 40, h: 60 }] }
    const state = { size: .62, dx: 4, dy: -2, imageScale: 1, imageDx: 0, imageDy: 0 }
    api.apply([state], [0], { type: 'transparent' })
    const source = {}, photo = { width: 200, height: 100 }, target = surface()
    const frame = api.frame(cfg, source, [state], 0)
    expect(frame.x).toBe(20)
    expect(frame.y).toBe(30)
    expect(frame.w * state.size).toBeCloseTo(40)
    expect(frame.h * state.size).toBeCloseTo(60)
    api.drawPhoto(target.ctx, cfg, source, [state], 0, photo)
    expect(target.calls).toEqual([['image', photo, 4, 18, 40, 20]])
    expect(surfaces).toHaveLength(0)
    state.size = .93
    const resized = api.frame(cfg, source, [state], 0)
    expect(resized.w * state.size).toBeCloseTo(60)
    expect(resized.h * state.size).toBeCloseTo(90)
  })

  it('masks the photo with only the heart silhouette, excluding letters and old texture; reuses unchanged layers', () => {
    const { pixels, cfg, source } = combination(false)
    const { api, surfaces } = setup(pixels)
    const state = { size: .62, dx: 2, dy: 1, imageScale: 1, imageDx: 0, imageDy: 0 }
    api.apply([state], [0], { type: 'outline' })
    const target = surface(), photo = { width: 10, height: 10 }
    api.drawPhoto(target.ctx, cfg, source, [state], 0, photo)
    const layer = surfaces.find(item => item.calls.some(call => call[0] === 'composite'))!
    expect(layer.calls).toContainEqual(['composite', 'destination-in'])
    expect(layer.calls).toContainEqual(['image', expect.any(Object), 6, 1, 5, 4, 0, 0, 5, 4])
    expect(layer.calls.some(call => call[0] === 'fill')).toBe(false)
    expect(target.calls).toContainEqual(['image', layer.element, 8, 2, 5, 4])
    const created = surfaces.length
    api.drawPhoto(target.ctx, cfg, source, [state], 0, photo)
    expect(surfaces).toHaveLength(created)
    const before = layer.calls.length
    state.imageScale = 2
    api.drawPhoto(target.ctx, cfg, source, [state], 0, photo)
    expect(layer.calls.length).toBeGreaterThan(before)
  })

  it('keeps the two new modes independent of old color/image backgrounds, and restores neighboring original motifs', () => {
    const { api } = setup()
    const cfg = { w: 100, h: 60, custom: true, slots: [{}, {}], placements: [
      { x: 0, y: 0, w: 40, h: 60 }, { x: 60, y: 0, w: 40, h: 60 },
    ] }
    const states: any[] = [{ size: .62, background: { type: 'image', image: { naturalWidth: 100, naturalHeight: 100 } } }, { size: .62 }]
    api.apply(states, [0], { type: 'transparent' })
    const target = surface(), source = {}
    api.drawTemplate(target.ctx, cfg, source, states)
    expect(target.calls).toContainEqual(['rect', 0, 0, 40, 60])
    expect(target.calls).not.toContainEqual(['rect', 60, 0, 40, 60])
    api.draw(target.ctx, states[0], 20, 30, 40, 60, source)
    expect(target.calls.some(call => call[0] === 'fill')).toBe(false)
    api.apply(states, [0], { type: 'none' })
    const restored = surface()
    api.drawTemplate(restored.ctx, cfg, source, states)
    expect(restored.calls).toEqual([['image', source, 0, 0, 100, 60]])
  })

  it('uses the photo-only renderer in editing, popup snapshots and print rendering instead of legacy shape clipping', () => {
    const { api } = setup()
    const source = { complete: true, naturalWidth: 100 }, photo = { width: 200, height: 100 }, target = surface()
    const cfg = { w: 100, h: 60, custom: true, background: source, slots: [{ x: 20, y: 30, w: 10, h: 10 }],
      placements: [{ x: 0, y: 0, w: 40, h: 60 }] }
    const states = [{ size: .62, dx: 0, dy: 0, imageScale: 1 }]
    api.apply(states, [0], { type: 'transparent' })
    let legacyClips = 0
    const env: any = { sharedLibrary: undefined, photoFrameRequest: 0, sel: { value: 'test' }, templates: { test: cfg }, states,
      slotBackgrounds: { update() {}, busy: () => false, hasAny: () => false }, updateMotifControls() {},
      updateCanvasSize: () => true, canvas: { width: 100, height: 60 }, ctx: target.ctx,
      renderConfig: () => ({ pxW: 100, pxH: 60, contentPxW: 100, contentPxH: 60 }),
      motifEditor: { source: () => source, busy: () => false }, HeartStarBackground: api,
      slotPhoto: () => photo, selectedSlots: new Set(), clip: { checked: true },
      clipPath() { legacyClips++ }, slotShape: () => 'star', drawFooter() {}, updatePhotoControls() {},
      backgroundDrag: { update() {} }, download: {}, watermarkDownload: {}, hasSlotPhotos: () => true,
      customDirty: false, customBusy: false, exportBusy: false, photoUploadBusy: false, replacementBusy: false,
    }
    const drawSource = toolHtml.slice(toolHtml.indexOf('function draw(showSelection'), toolHtml.indexOf('function chooseAtCanvas('))
    const draw = new Function('env', `with(env){${drawSource};return draw}`)(env)
    for (const [guides, fullResolution] of [[true, false], [false, false], [false, true]]) draw(guides, fullResolution)
    expect(legacyClips).toBe(0)
    expect(target.calls.filter(call => call[0] === 'image' && call[1] === photo)).toEqual([
      ['image', photo, 0, 20, 40, 20], ['image', photo, 0, 20, 40, 20], ['image', photo, 0, 20, 40, 20],
    ])
  })
})
