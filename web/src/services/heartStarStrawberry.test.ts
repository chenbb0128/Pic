import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
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

describe('strawberry template', () => {
  it('loads the full-resolution PNG with 36 non-overlapping artwork and photo positions', () => {
    const api = feature(), cfg = api.build()
    const bytes = readFileSync(new URL('../../public/embedded/heart-star/' + api.source.split('?')[0].replace('./', ''), import.meta.url))
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([cfg.w, cfg.h])
    expect([cfg.w, cfg.h, cfg.widthMm, cfg.heightMm]).toEqual([1748, 2480, 148, 210])
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
    expect(calls[0].slice(1)).toEqual([area.x + 10 - area.h / 4, area.y - 5 - area.h / 2, area.h / 2, area.h])
  })

  it('centers every row across the sheet and keeps photo frames inside their artwork', () => {
    const cfg = feature().build()
    for (let row = 0; row < 7; row++) {
      const ids = cfg.slots.flatMap((slot: any, index: number) => slot.row === row ? [index] : [])
      const left = Math.min(...ids.map((i: number) => cfg.placements[i].x))
      const right = cfg.w - Math.max(...ids.map((i: number) => cfg.placements[i].x + cfg.placements[i].w))
      // Some source boxes include a one-pixel transparent fringe.
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
      for (const i of ids) {
        const photo = cfg.slots[i].photoArea, artwork = cfg.placements[i]
        expect(cfg.slots[i].x).toBe(photo.x)
        expect(photo.x - photo.w / 2).toBeGreaterThanOrEqual(artwork.x)
        expect(photo.x + photo.w / 2).toBeLessThanOrEqual(artwork.x + artwork.w)
      }
    }
  })

  it('selects A5 dimensions and restores previous user dimensions when leaving the new template', () => {
    const scope: any = {}, width = { value: '160' }, height = { value: '220' }
    new Function('globalThis', presetSource)(scope)
    scope.HeartStarPreset.selectSize(feature().build(), width, height)
    expect([width.value, height.value]).toEqual(['148', '210'])
    scope.HeartStarPreset.selectSize({ preset: true, widthMm: 210, heightMm: 144 }, width, height)
    expect([width.value, height.value]).toEqual(['210', '144'])
    scope.HeartStarPreset.selectSize({}, width, height)
    expect([width.value, height.value]).toEqual(['160', '220'])
  })

  it('preserves calibrated frames without a temporary notice through a shared editable snapshot', async () => {
    const scope: any = {}, cfg = feature().build(), image = { naturalWidth: 1748, naturalHeight: 2480 }
    new Function('globalThis', editorSource)(scope)
    new Function('globalThis', snapshotSource)(scope)
    const editor = scope.HeartStarCloudEditor, states = cfg.slots.map(() => ({ size: .62, dx: 0, dy: 0 }))
    const settings = { width: 148, height: 210, dpi: 300 }
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
