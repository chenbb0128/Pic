import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import source from '../../public/embedded/heart-star/christmas-template.js?raw'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function feature() {
  const scope: any = {}
  new Function('globalThis', 'document', source)(scope, { getElementById: () => null })
  return scope.HeartStarChristmas
}

describe('Christmas template', () => {
  it('loads the centered 144 mm sheet with 38 non-overlapping photo positions', () => {
    const api = feature(), cfg = api.build()
    const bytes = readFileSync(new URL('../../public/embedded/heart-star/' + api.source.split('?')[0].replace('./', ''), import.meta.url))
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([cfg.w, cfg.h])
    expect([cfg.w, cfg.h, cfg.widthMm, cfg.heightMm]).toEqual([1701, 2480, 144, 210])
    expect(cfg.clipFittedPhotos).toBe(true)
    expect(cfg.slots).toHaveLength(38)
    expect(Array.from({ length: 7 }, (_, row) => cfg.slots.filter((slot: any) => slot.row === row).length)).toEqual([4, 4, 6, 6, 6, 6, 6])
    cfg.slots.forEach((slot: any, i: number) => {
      const artwork = cfg.placements[i], photo = slot.photoArea
      expect(artwork.x).toBeGreaterThanOrEqual(0)
      expect(artwork.y).toBeGreaterThanOrEqual(0)
      expect(artwork.x + artwork.w).toBeLessThanOrEqual(cfg.w)
      expect(artwork.y + artwork.h).toBeLessThanOrEqual(cfg.h)
      expect(photo.x - photo.w / 2).toBeGreaterThanOrEqual(artwork.x)
      expect(photo.y - photo.h / 2).toBeGreaterThanOrEqual(artwork.y)
      expect(photo.x + photo.w / 2).toBeLessThanOrEqual(artwork.x + artwork.w)
      expect(photo.y + photo.h / 2).toBeLessThanOrEqual(artwork.y + artwork.h)
      for (const other of cfg.placements.slice(i + 1))
        expect(artwork.x + artwork.w <= other.x || other.x + other.w <= artwork.x || artwork.y + artwork.h <= other.y || other.y + other.h <= artwork.y).toBe(true)
    })
    expect(toolHtml).toContain('<option value="圣诞.png">圣诞款 · A5 竖版</option>')
    expect(toolHtml).toContain('templates[HeartStarChristmas.name]=HeartStarChristmas.build()')
  })

  it('centers every row and keeps both sides above 5 mm', () => {
    const cfg = feature().build()
    for (let row = 0; row < 7; row++) {
      const ids = cfg.slots.flatMap((slot: any, index: number) => slot.row === row ? [index] : [])
      const left = Math.min(...ids.map((i: number) => cfg.placements[i].x))
      const right = cfg.w - Math.max(...ids.map((i: number) => cfg.placements[i].x + cfg.placements[i].w))
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
      expect(left / cfg.w * cfg.widthMm).toBeGreaterThan(5)
      expect(right / cfg.w * cfg.widthMm).toBeGreaterThan(5)
    }
  })
})
