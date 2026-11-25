import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sheetAlpha } from './heartStarSheetTestSupport.mts'
import source from '../../public/embedded/heart-star/christmas-template.js?raw'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function feature(templateScript = source) {
  const scope: any = {}
  new Function('globalThis', 'document', templateScript)(scope, { getElementById: () => null })
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

  it('keeps the default photo and selection frame inside all 38 artwork silhouettes', () => {
    const api = feature(), cfg = api.build()
    const name = api.source.split('?')[0]
    const webDir = new URL('../../public/embedded/heart-star/', import.meta.url)
    const desktopDir = new URL('../../../vagaga/public/embedded/heart-star/', import.meta.url)
    const webArt = readFileSync(new URL(name, webDir))
    expect(readFileSync(new URL(name, desktopDir)).equals(webArt)).toBe(true)
    expect(feature(readFileSync(new URL('christmas-template.js', desktopDir), 'utf8')).build()).toEqual(cfg)
    expect(readFileSync(new URL('index.html', desktopDir), 'utf8')).toContain('christmas-template.js?v=2')
    expect(toolHtml).toContain('christmas-template.js?v=2')

    const { alpha } = sheetAlpha(webArt)
    cfg.slots.forEach((slot: any, i: number) => {
      const photo = slot.photoArea
      expect([slot.x, slot.y]).toEqual([photo.x, photo.y])
      expect(slot.w * .62).toBeCloseTo(photo.w)
      expect(slot.h * .62).toBeCloseTo(photo.h)
      // The 6% larger dashed selection box has a 4 px stroke.
      const dx = photo.w * .53 + 2, dy = photo.h * .53 + 2
      let transparent = 0
      for (let y = Math.floor(photo.y - dy); y < Math.ceil(photo.y + dy); y++) {
        for (let x = Math.floor(photo.x - dx); x < Math.ceil(photo.x + dx); x++) {
          if (alpha(x, y) < 128) transparent++
        }
      }
      expect(transparent, `photo position ${i + 1}`).toBe(0)
    })
  })
})
