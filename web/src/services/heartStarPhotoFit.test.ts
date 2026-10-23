import { describe, expect, it } from 'vitest'
import backgroundSource from '../../public/embedded/heart-star/slot-background.js?raw'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'
import motifsSource from '../../public/embedded/heart-star/template-motifs.js?raw'

function image(rows: string[]) {
  const width = rows[0]!.length, height = rows.length, pixels = new Uint8ClampedArray(width * height * 4)
  rows.forEach((row, y) => [...row].forEach((value, x) => { if (value === '#') pixels[(y * width + x) * 4 + 3] = 255 }))
  return { width, height, naturalWidth: width, naturalHeight: height, pixels }
}

function setup() {
  let reads = 0
  const document = { createElement() {
    let current: any
    return { width: 0, height: 0, getContext: () => ({ drawImage(source: any) { current = source },
      getImageData() { reads++; return { data: current.pixels.slice() } },
    }) }
  } }
  const api = new Function('globalThis', 'document', `${backgroundSource};return globalThis.HeartStarBackground`)({}, document)
  return { api, reads: () => reads }
}

function checkInside(frame: any, source: ReturnType<typeof image>) {
  const left = frame.x - frame.w / 2, right = frame.x + frame.w / 2
  const top = frame.y - frame.h / 2, bottom = frame.y + frame.h / 2
  for (let y = Math.floor(top); y < Math.ceil(bottom); y++) for (let x = Math.floor(left); x < Math.ceil(right); x++) {
    expect(source.pixels[(y * source.width + x) * 4 + 3], `photo area reaches transparent pixel ${x},${y}`).toBe(255)
  }
}

describe('heart-star predefined photo placement', () => {
  it('leaves a six-pixel safety inset around a full-size photo area instead of touching its edges', () => {
    const { api } = setup(), source = image(Array(200).fill('#'.repeat(200)))
    const cfg = { w: 200, h: 200, custom: true, slots: [{ x: 100, y: 100, w: 200, h: 200 }], placements: [{ x: 0, y: 0, w: 200, h: 200 }] }
    const f = api.photoFrame(cfg, source, [{ size: .62 }], 0)
    expect(f.x - f.w * .62 / 2).toBeCloseTo(6)
    expect(f.y - f.h * .62 / 2).toBeCloseTo(6)
    expect(f.x + f.w * .62 / 2).toBeCloseTo(194)
    expect(f.y + f.h * .62 / 2).toBeCloseTo(194)
  })

  it.each([
    ['heart', ['..##.##..', '.#######.', '.#######.', '..#####..', '...###...', '....#....']],
    ['star', ['....#....', '...###...', '#########', '.#######.', '..#####..', '..##.##..', '.##...##.']],
    ['circle', ['..###..', '.#####.', '#######', '#######', '.#####.', '..###..']],
    ['square', ['######', '######', '######', '######', '######', '######']],
  ])('defines a reusable safe rectangle inside a %s before any photo is uploaded', (type, rows) => {
    const { api, reads } = setup(), source = image(rows as string[])
    const cfg = { w: source.width, h: source.height, custom: true,
      slots: [{ x: source.width / 2, y: source.height / 2, w: source.width, h: source.height, type }],
      placements: [{ x: 0, y: 0, w: source.width, h: source.height }] }
    const states = [{ size: .62 }]
    const frame = api.photoFrame(cfg, source, states, 0)
    expect(frame.w).toBeGreaterThan(0)
    expect(frame.h).toBeGreaterThan(0)
    checkInside({ ...frame, w: frame.w * .62, h: frame.h * .62 }, source)
    const before = reads()
    expect(api.photoFrame(cfg, source, states, 0)).toEqual(frame)
    expect(reads()).toBe(before)
  })

  it('keeps the photo at the fixed optical heart center even when a larger rectangle fits higher up', () => {
    const { api } = setup(), source = image([
      '.##...##.', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....', '.........',
    ])
    const cfg = { w: 9, h: 8, custom: true, slots: [{ x: 4.5, y: 4, w: 9, h: 8, type: 'heart' }],
      placements: [{ x: 0, y: 0, w: 9, h: 8 }] }
    const states = [{ size: .62 }], f = api.photoFrame(cfg, source, states, 0)
    expect(f.x).toBe(4.5)
    expect(f.y).toBeCloseTo(3.68)
    checkInside({ ...f, w: f.w * .62, h: f.h * .62 }, source)
    const photo = image(['##', '##', '##', '##']), calls: any[] = []
    api.drawFittedPhoto({ drawImage: (...args: any[]) => calls.push(args) }, cfg, source, states, 0, photo)
    const [, x, y, w, h] = calls[0]
    expect(x + w / 2).toBe(4.5)
    expect(y + h / 2).toBeCloseTo(3.68)
  })

  it.each([
    ['heart', 92, 5.52], ['star', 100, 6], ['circle', 100, 6], ['square', 100, 6],
  ])('fits %s photos at their prescribed visual center with a safety inset', (type, centerY, topInset) => {
    const { api } = setup(), source = image(Array(200).fill('#'.repeat(200)))
    const cfg = { w: 200, h: 200, custom: true, slots: [{ x: 100, y: 100, w: 200, h: 200, type }],
      placements: [{ x: 0, y: 0, w: 200, h: 200 }] }
    const f = api.photoFrame(cfg, source, [{ size: .62 }], 0)
    expect(f.x).toBe(100)
    expect(f.y).toBe(centerY)
    checkInside({ ...f, w: f.w * .62, h: f.h * .62 }, source)
    expect(f.y - f.h * .62 / 2).toBeCloseTo(topInset)
  })

  it.each([
    ['heart', 'star', 100], ['star', 'heart', 92],
  ])('uses the replacement motif shape for the optical lift: %s to %s', (type, replacement, centerY) => {
    const { api } = setup(), source = image(Array(200).fill('#'.repeat(200)))
    const cfg = { w: 200, h: 200, custom: true, slots: [{ x: 100, y: 100, w: 200, h: 200, type }],
      placements: [{ x: 0, y: 0, w: 200, h: 200 }] }
    const states = [{ size: .62, motif: { type: replacement, backgroundPart: 'whole', frame: { x: 100, y: 100, w: 200, h: 200 } } }]
    expect(api.photoFrame(cfg, source, states, 0).y).toBe(centerY)
  })

  it.each(['模板粉色.png', '模板蓝色.png', '模板黄色.png'])('does not lift original squares mislabeled as heart crop slots in %s', name => {
    const motifs = new Function('globalThis', `${motifsSource};return globalThis.HeartStarMotifs`)({})
    const assets = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
    expect(motifs.photoTypes).toBeTypeOf('function')
    const types = motifs.photoTypes(name, assets)
    expect([0, 1, 2, 12, 13].map(i => types[i])).toEqual(Array(5).fill('square'))
    expect(types[6]).toBe('heart')
    const { api } = setup(), source = image(Array(200).fill('#'.repeat(200)))
    const cfg = { w: 200, h: 200, custom: true, photoTypes: [types[0]],
      slots: [{ x: 100, y: 100, w: 200, h: 200, type: 'heart' }], placements: [{ x: 0, y: 0, w: 200, h: 200 }] }
    expect(api.photoFrame(cfg, source, [{ size: .62 }], 0).y).toBe(100)
    expect(cfg.slots[0]!.type).toBe('heart') // Do not change the old crop mode.
  })

  it('uses only the heart of an I / ME combination, not the letters or whole group', () => {
    const { api } = setup(), source = image(['.............', '.##...#####..', '.##...#####..', '.##...#####..',
      '.............', '.##########..', '.##########..', '.............'])
    const cfg = { w: 13, h: 8, slots: [{ x: 8, y: 2.5, w: 3, h: 3, bottom: true }] }
    const f = api.photoFrame(cfg, source, [{ size: .62 }], 0)
    expect(f.x).toBe(8.5)
    expect(f.y).toBeCloseTo(2.38)
    expect(f.w * .62).toBeCloseTo(4.7)
    expect(f.h * .62).toBeCloseTo(2.5944)
  })

  it('fits the complete visible photo into the fixed area, ignoring transparent padding and without a clip', () => {
    const { api } = setup(), source = image(Array(10).fill('##########'))
    const cfg = { w: 10, h: 10, custom: true, slots: [{ x: 5, y: 5, w: 10, h: 10 }], placements: [{ x: 0, y: 0, w: 10, h: 10 }] }
    const photo = image(['........', '...##...', '...##...', '...##...', '...##...', '........'])
    const calls: any[] = [], ctx = { drawImage: (...args: any[]) => calls.push(args) }
    api.drawFittedPhoto(ctx, cfg, source, [{ size: .62 }], 0, photo)
    expect(calls).toHaveLength(1)
    // Visible 2 × 4 content becomes 4.7 × 9.4 and is centered at (5, 5).
    expect(calls[0][0]).toBe(photo)
    expect(calls[0].slice(1)).toEqual([expect.closeTo(-4.4), expect.closeTo(-2.05), expect.closeTo(18.8), expect.closeTo(14.1)])
    const [, x, y, w, h] = calls[0]
    expect(w / h).toBeCloseTo(8 / 6)
    expect(x + 3 * w / 8).toBeCloseTo(2.65)
    expect(y + h / 6).toBeCloseTo(.3)
    expect(y + 5 * h / 6).toBeCloseTo(9.7)
  })

  it('keeps manual scaling and offsets, and invalidates the area when the motif changes', () => {
    const { api, reads } = setup(), source = image(Array(10).fill('##########'))
    const cfg = { w: 10, h: 10, custom: true, slots: [{ x: 5, y: 5, w: 10, h: 10 }], placements: [{ x: 0, y: 0, w: 10, h: 10 }] }
    const photo = image(['##', '##']), states = [{ size: .62, dx: 1, dy: -1, imageScale: 2, imageDx: 2, imageDy: 3 }]
    const calls: any[] = [], ctx = { drawImage: (...args: any[]) => calls.push(args) }
    api.drawFittedPhoto(ctx, cfg, source, states, 0, photo)
    expect(calls[0].slice(1)).toEqual([expect.closeTo(-1.4), expect.closeTo(-2.4), expect.closeTo(18.8), expect.closeTo(18.8)])
    const before = reads()
    api.drawFittedPhoto(ctx, cfg, source, states, 0, photo)
    expect(reads()).toBe(before)
    const replacement = image(['..........', '..........', '...####...', '...####...', '...####...', '...####...', '..........', '..........', '..........', '..........'])
    const next = api.photoFrame(cfg, replacement, states, 0)
    expect(next.w * .62).toBeCloseTo(3.76)
    expect(next.x).toBe(5)
    expect(next.y).toBe(5)
  })

  it('does not draw an entirely transparent photo', () => {
    const { api } = setup(), source = image(['####', '####', '####', '####'])
    const cfg = { w: 4, h: 4, custom: true, slots: [{ x: 2, y: 2, w: 4, h: 4 }], placements: [{ x: 0, y: 0, w: 4, h: 4 }] }
    const calls: any[] = []
    api.drawFittedPhoto({ drawImage: (...args: any[]) => calls.push(args) }, cfg, source, [{ size: .62 }], 0, image(['..', '..']))
    expect(calls).toEqual([])
  })

  it('does not move the photo off center or outside the silhouette when no centered area fits', () => {
    const { api } = setup(), source = image(['##...##', '##...##', '##...##'])
    const cfg = { w: 7, h: 3, custom: true, slots: [{ x: 3.5, y: 1.5, w: 7, h: 3 }],
      placements: [{ x: 0, y: 0, w: 7, h: 3 }] }
    const calls: any[] = []
    api.drawFittedPhoto({ drawImage: (...args: any[]) => calls.push(args) }, cfg, source, [{ size: .62 }], 0, image(['##', '##']))
    expect(calls).toEqual([])
  })

  it('uses uncropped auto-fitting in the editor and PNG renderer while leaving the original artwork and letters untouched', () => {
    const { api } = setup(), source = image(Array(10).fill('##########')), photo = image(['##', '##', '##', '##'])
    const cfg = { w: 10, h: 10, custom: true, background: source, slots: [{ x: 5, y: 5, w: 10, h: 10 }], placements: [{ x: 0, y: 0, w: 10, h: 10 }] }
    const calls: any[] = []
    let clips = 0
    const env = { photoFrameRequest: 0, sel: { value: 'test' }, templates: { test: cfg },
      states: [{ size: .62, dx: 0, dy: 0, imageScale: 1 }], slotBackgrounds: { update() {}, busy: () => false, hasAny: () => false },
      updateMotifControls() {}, updateCanvasSize: () => true, canvas: { width: 10, height: 10 },
      ctx: { clearRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() { clips++ }, scale() {}, drawImage: (...args: any[]) => calls.push(args) },
      renderConfig: () => ({ contentPxW: 10, contentPxH: 10 }), motifEditor: { source: () => source, busy: () => false },
      HeartStarBackground: api, slotPhoto: () => photo, selectedSlots: new Set(), clip: { checked: false },
      drawFooter() {}, updatePhotoControls() {}, backgroundDrag: { update() {} }, download: {}, watermarkDownload: {},
      hasSlotPhotos: () => true, customDirty: false, customBusy: false, exportBusy: false, photoUploadBusy: false, replacementBusy: false,
    }
    const code = toolHtml.slice(toolHtml.indexOf('function draw(showSelection'), toolHtml.indexOf('function chooseAtCanvas('))
    const draw = new Function('env', `with(env){${code};return draw}`)(env)
    draw(false)
    draw(false, true)
    expect(clips).toBe(2) // Only the overall sheet clip, never a photo/shape clip.
    expect(calls.filter(call => call[0] === source)).toEqual([[source, 0, 0, 10, 10], [source, 0, 0, 10, 10]])
    const photos = calls.filter(call => call[0] === photo)
    expect(photos).toHaveLength(2)
    expect(photos[0]!.slice(1)).toEqual([expect.closeTo(2.65), expect.closeTo(.3), expect.closeTo(4.7), expect.closeTo(9.4)])
    expect(photos[1]).toEqual(photos[0])
  })
})
