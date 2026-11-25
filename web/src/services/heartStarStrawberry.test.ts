import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sheetAlpha } from './heartStarSheetTestSupport.mts'
import source from '../../public/embedded/heart-star/strawberry-template.js?raw'
import backgroundSource from '../../public/embedded/heart-star/slot-background.js?raw'
import presetSource from '../../public/embedded/heart-star/heart-preset.js?raw'
import editorSource from '../../public/embedded/heart-star/cloud-editor.js?raw'
import snapshotSource from '../../public/embedded/heart-star/cloud-snapshot.js?raw'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function feature() {
  const scope: any = {}
  new Function('globalThis', source)(scope)
  return scope.HeartStarStrawberry
}

function sheetBytes() {
  const api = feature()
  return readFileSync(new URL('../../public/embedded/heart-star/' + api.source.split('?')[0].replace('./', ''), import.meta.url))
}

// The sheet is decoded once per run; two tests read its pixels.
let decoded: ReturnType<typeof sheetAlpha> | undefined
function baseSheet() {
  decoded ??= sheetAlpha(sheetBytes())
  return decoded
}

describe('strawberry template', () => {
  it('loads the full-resolution PNG with 36 non-overlapping artwork and photo positions', () => {
    const api = feature(), cfg = api.build()
    const bytes = sheetBytes()
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([cfg.w, cfg.h])
    expect([cfg.w, cfg.h, cfg.widthMm, cfg.heightMm]).toEqual([1701, 2480, 144, 210])
    expect(cfg.slots).toHaveLength(36)
    expect(Array.from({ length: 7 }, (_, row) => cfg.slots.filter((slot: any) => slot.row === row).length)).toEqual([4, 4, 6, 6, 6, 5, 5])
    cfg.slots.forEach((slot: any, i: number) => {
      const p = cfg.placements[i], f = slot.photoArea
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.x + p.w).toBeLessThanOrEqual(cfg.w)
      expect(p.y + p.h).toBeLessThanOrEqual(cfg.h)
      expect(f.x - f.w / 2).toBeGreaterThanOrEqual(p.x)
      expect(f.y - f.h / 2).toBeGreaterThanOrEqual(p.y)
      expect(f.x + f.w / 2).toBeLessThanOrEqual(p.x + p.w)
      expect(f.y + f.h / 2).toBeLessThanOrEqual(p.y + p.h)
      for (const other of cfg.placements.slice(i + 1)) {
        expect(p.x + p.w <= other.x || other.x + other.w <= p.x || p.y + p.h <= other.y || other.y + other.h <= p.y).toBe(true)
      }
    })
    expect(toolHtml).toContain(`<option value="${api.name}">草莓款 · A5 竖版</option>`)
    expect(toolHtml).toContain('templates[HeartStarStrawberry.name]=HeartStarStrawberry.build()')
    expect(cfg.notice).toBeUndefined()
  })

  it('fits photos at the calibrated visual centers and keeps manual tuning', () => {
    const cfg = feature().build(), scope: any = {}
    // An explicit photo area must not depend on detecting transparent gutters.
    new Function('globalThis', 'document', backgroundSource)(scope, { createElement() { throw Error('unexpected template pixel scan') } })
    const api = scope.HeartStarBackground, states = cfg.slots.map(() => ({ size: .62, dx: 0, dy: 0 }))
    expect(api.photoAreas(cfg, {}, states)).toEqual(cfg.slots.map((slot: any) => slot.photoArea))
    cfg.slots.forEach((slot: any, i: number) => {
      const frame = api.photoFrame(cfg, {}, states, i)
      expect(frame.x).toBe(slot.photoArea.x)
      expect(frame.y).toBe(slot.photoArea.y)
      expect(frame.w * .62).toBeCloseTo(slot.photoArea.w)
      expect(frame.h * .62).toBeCloseTo(slot.photoArea.h)
    })
    const photo = { width: 100, height: 200 }, calls: any[] = [], area = cfg.slots[4].photoArea
    states[4] = { size: .62, dx: 10, dy: -5 }
    api.drawFittedPhoto({ drawImage: (...args: any[]) => calls.push(args) }, cfg, {}, states, 4, photo)
    // A 100 x 200 photo is limited by the area height: it becomes half as wide as the area is tall.
    expect(calls[0].slice(1)).toEqual([expect.closeTo(area.x + 10 - area.h / 4), expect.closeTo(area.y - 5 - area.h / 2),
      expect.closeTo(area.h / 2), expect.closeTo(area.h)])
  })

  it('centers every row with more than 5 mm on each side and keeps photo frames inside their artwork', () => {
    const cfg = feature().build()
    for (let row = 0; row < 7; row++) {
      const ids = cfg.slots.flatMap((slot: any, index: number) => slot.row === row ? [index] : [])
      const left = Math.min(...ids.map((i: number) => cfg.placements[i].x))
      const right = cfg.w - Math.max(...ids.map((i: number) => cfg.placements[i].x + cfg.placements[i].w))
      // Some source boxes include a one-pixel transparent fringe.
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
      expect(left / cfg.w * cfg.widthMm).toBeGreaterThan(5)
      expect(right / cfg.w * cfg.widthMm).toBeGreaterThan(5)
      for (const i of ids) {
        const photo = cfg.slots[i].photoArea, artwork = cfg.placements[i]
        expect(cfg.slots[i].x).toBe(photo.x)
        expect(photo.x - photo.w / 2).toBeGreaterThanOrEqual(artwork.x)
        expect(photo.x + photo.w / 2).toBeLessThanOrEqual(artwork.x + artwork.w)
      }
    }
  })

  it('fits every default photo frame inside its artwork, including the enlarged heart frames', () => {
    const cfg = feature().build(), { width, height, alpha } = baseSheet()
    // true when every pixel the rectangle touches is painted on the sheet
    const painted = (left: number, top: number, right: number, bottom: number) => {
      for (let y = Math.floor(top + 1e-9); y < Math.ceil(bottom - 1e-9); y++)
        for (let x = Math.floor(left + 1e-9); x < Math.ceil(right - 1e-9); x++)
          if (x < 0 || y < 0 || x >= width || y >= height || alpha(x, y) < 128) return false
      return true
    }
    cfg.slots.forEach((slot: any, i: number) => {
      const artwork = cfg.placements[i], photo = slot.photoArea
      // Centre of area of the motif as it is actually painted on the sheet.
      let sumX = 0, sumY = 0, count = 0
      for (let y = Math.floor(artwork.y - 6); y < Math.ceil(artwork.y + artwork.h + 6); y++)
        for (let x = Math.floor(artwork.x - 6); x < Math.ceil(artwork.x + artwork.w + 6); x++)
          if (alpha(x, y) >= 128) { sumX += x + .5; sumY += y + .5; count++ }
      expect(count, `slot ${i} artwork`).toBeGreaterThan(1000)
      expect(Math.abs(photo.x - sumX / count), `slot ${i} horizontal centre`).toBeLessThanOrEqual(1.5)
      const heart = slot.row === 3 || slot.row === 4
      const verticalOffset = heart ? 6 * .95 : 0
      expect(Math.abs(photo.y - sumY / count - verticalOffset), `slot ${i} vertical position`).toBeLessThanOrEqual(1.5)
      if (heart) {
        expect(photo.w * cfg.widthMm / cfg.w).toBeCloseTo(9.09)
        expect(photo.h * cfg.heightMm / cfg.h).toBeCloseTo(9.69)
      }
      // The editor draws a 4 px dashed selection frame 6% larger than the photo area.
      // The dashed line, half its stroke width included, must stay on the artwork.
      expect(painted(photo.x - photo.w * .53 - 2, photo.y - photo.h * .53 - 2, photo.x + photo.w * .53 + 2, photo.y + photo.h * .53 + 2), `slot ${i} frame`).toBe(true)
    })
  })

  it('centres every row of the base image on the sheet', () => {
    const cfg = feature().build(), { width, alpha } = baseSheet()
    for (let row = 0; row < 7; row++) {
      const boxes = cfg.placements.filter((_: any, i: number) => cfg.slots[i].row === row)
      const top = Math.floor(Math.min(...boxes.map((box: any) => box.y)) - 6), bottom = Math.ceil(Math.max(...boxes.map((box: any) => box.y + box.h)) + 6)
      let left = width, right = -1
      for (let y = top; y < bottom; y++) for (let x = 0; x < width; x++) if (alpha(x, y) >= 128) { left = Math.min(left, x); right = Math.max(right, x) }
      left = left as number; right = right as number
      expect(Math.abs(left - (width - 1 - right)), `row ${row + 1} margins`).toBeLessThanOrEqual(1)
      expect(left / width * cfg.widthMm, `row ${row + 1} margin`).toBeGreaterThan(5)
    }
  })

  it('shrinks artwork and photos by 5% in both print dimensions from the original 148 mm layout', () => {
    const cfg = feature().build(), artwork = cfg.placements[28], photo = cfg.slots[28].photoArea
    // Pixel rounding at 300 DPI must not visibly distort uploaded photos.
    expect(Math.abs((cfg.widthMm / cfg.w) / (cfg.heightMm / cfg.h) - 1)).toBeLessThan(.001)
    // First whole strawberry: original artwork 229 x 236 px, photo 126 x 134 px.
    expect(artwork.w / cfg.w * cfg.widthMm).toBeCloseTo(229 / 1748 * 148 * .95)
    expect(artwork.h / cfg.h * cfg.heightMm).toBeCloseTo(236 / 2480 * 210 * .95)
    expect(photo.w / cfg.w * cfg.widthMm).toBeCloseTo(126 / 1748 * 148 * .95)
    expect(photo.h / cfg.h * cfg.heightMm).toBeCloseTo(134 / 2480 * 210 * .95)
  })

  it('selects the shared 144 mm export width and restores previous user dimensions when leaving the template', () => {
    const scope: any = {}, width = { value: '160' }, height = { value: '220' }
    new Function('globalThis', presetSource)(scope)
    scope.HeartStarPreset.selectSize(feature().build(), width, height)
    expect([width.value, height.value]).toEqual(['144', '210'])
    const outputSource = toolHtml.slice(toolHtml.indexOf('function outputConfig('), toolHtml.indexOf('function renderConfig('))
    const output = new Function('widthInput', 'heightInput', 'dpiInput', 'numberingEnabled', 'footerHeightMm',
      `${outputSource};return outputConfig();`)(width, height, { value: '600' }, { checked: true }, 3)
    expect(output).toMatchObject({ totalW: 144, totalH: 213, pxW: 3402, pxH: 5031 })
    scope.HeartStarPreset.selectSize({ preset: true, widthMm: 210, heightMm: 144 }, width, height)
    expect([width.value, height.value]).toEqual(['210', '144'])
    scope.HeartStarPreset.selectSize({}, width, height)
    expect([width.value, height.value]).toEqual(['160', '220'])
  })

  it('preserves calibrated frames without a temporary notice through a shared editable snapshot', async () => {
    const scope: any = {}, cfg = feature().build(), image = { naturalWidth: 1701, naturalHeight: 2480 }
    new Function('globalThis', editorSource)(scope)
    new Function('globalThis', snapshotSource)(scope)
    const editor = scope.HeartStarCloudEditor, states = cfg.slots.map(() => ({ size: .62, dx: 0, dy: 0 }))
    const settings = { width: 144, height: 210, dpi: 300 }
    const captured = editor.capture({ name: feature().name, cfg, base: image, states, photoAt: () => null, catalog: [], settings })
    const codec = scope.HeartStarCloudSnapshot.create({ isImage: (value: any) => value === image,
      upload: async () => ({ fileId: '1'.repeat(32) }), loadImage: async () => image })
    const restored = await codec.restore(await codec.capture(captured, 'project'))
    expect(() => editor.validate(restored, {})).not.toThrow()
    expect(restored.template.slots).toEqual(cfg.slots)
    expect(restored.template.placements).toEqual(cfg.placements)
    expect(restored.template.notice).toBeUndefined()
    restored.template.slots[0].photoArea.w = Number.NaN
    expect(() => editor.validate(restored, {})).toThrow()
  })
})
