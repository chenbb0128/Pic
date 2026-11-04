import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'
import presetSource from '../../public/embedded/heart-star/heart-preset.js?raw'
import motifSource from '../../public/embedded/heart-star/template-motifs.js?raw'

function setup() {
  const scope: any = {}
  new Function('globalThis', presetSource)(scope)
  const path = new URL('../../public/embedded/heart-star/candy-motifs.js', import.meta.url)
  if (existsSync(path)) new Function('globalThis', readFileSync(path, 'utf8'))(scope)
  const originals = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)
  const assets = scope.HeartStarCandy?.register(originals) || {}
  new Function('globalThis', motifSource)(scope)
  scope.HeartStarMotifs.limitSmallHearts(assets)
  scope.HeartStarMotifs.limitSmallStars(assets)
  scope.HeartStarMotifs.limitIMe(assets)
  const start = toolHtml.indexOf('function buildCustomLayout(')
  const build = new Function(`${toolHtml.slice(start, toolHtml.indexOf('\n}', start) + 2)};return buildCustomLayout`)()
  return { api: scope.HeartStarPreset, assets, build }
}

const expectedRows = [
  ['奶油黄粉波点', '粉色野餐格', '薰衣草田', '抹茶棋盘格', '奶油黄粉波点', '粉色野餐格'],
  ['奶油黄粉波点', '粉色野餐格', '薰衣草田', '抹茶棋盘格', '奶油黄粉波点', '粉色野餐格'],
  ['蓝色可可波点', '草莓牛奶', '柠檬苏打', '葡萄棋盘格', '桃子心动', '奶油黄粉波点'],
  ['蓝色可可波点', '草莓牛奶', '柠檬苏打', '葡萄棋盘格', '桃子心动', '奶油黄粉波点'],
  ['草莓奶星', '葡萄大波点', '蜜桃沙冰', '雏菊花园'],
  ['草莓奶星', '葡萄大波点', '蜜桃沙冰', '雏菊花园'],
  ['粉色小花', '蓝色情书', '星河晚安', '紫色心事'],
  ['樱桃情书', '奶油花圃', '薰衣草田', '向日葵大波点'],
]

describe('缤纷糖果 A5 独立模板', () => {
  it('保留修正后的 40 个图案顺序、20mm 小款和 29.5mm 大款，并留足页边距与排间距', () => {
    const { api, assets, build } = setup()
    expect(typeof api.buildCandy).toBe('function')
    const before = JSON.stringify(assets)
    const cfg = api.buildCandy(assets, build)
    expect(cfg).toMatchObject({ preset: true, widthMm: 144, heightMm: 210, w: 1440, h: 2100 })
    expect(cfg.slots).toHaveLength(40)
    const types = ['circle', 'circle', 'heart', 'heart', 'heart', 'star', 'flower', 'scallop']
    const rows = expectedRows.map((_, r) => cfg.placements.filter((_: any, i: number) => cfg.slots[i].row === r))
    expect(rows.map((row: any[]) => row.map(p => assets[p.assetId].patternName))).toEqual(expectedRows)
    rows.forEach((row: any[], r: number) => {
      expect(row[0].x).toBeCloseTo(cfg.w - row.at(-1).x - row.at(-1).w)
      row.forEach((p, column) => {
        const asset = assets[p.assetId], index = cfg.placements.indexOf(p), max = r < 4 ? 20 : 29.5
        expect(asset.type).toBe(types[r])
        expect(Math.max(p.w, p.h) / 10).toBeCloseTo(max)
        expect(p.w / p.h).toBeCloseTo(asset.nativeW / asset.nativeH)
        expect(p.x).toBeGreaterThanOrEqual(29.999)
        expect(p.y).toBeGreaterThanOrEqual(29.999)
        expect(p.x + p.w).toBeLessThanOrEqual(1410.001)
        expect(p.y + p.h).toBeLessThanOrEqual(2070.001)
        if (column) expect(p.x - row[column - 1].x - row[column - 1].w).toBeGreaterThanOrEqual(19.999)
        expect(cfg.motifSlots[index]).toMatchObject({ assetId: p.assetId, type: asset.type, maxSizeMm: max })
        expect(cfg.slots[index].type).toBe(asset.type)
        expect(api.initialState(cfg, index).shape).toBe('template')
      })
      if (r) expect(Math.min(...row.map(p => p.y)) - Math.max(...rows[r - 1].map(p => p.y + p.h))).toBeGreaterThanOrEqual(19.999)
    })
    expect(JSON.stringify(assets)).toBe(before)
    expect(toolHtml).toContain(`<option value="${api.candyName}">缤纷糖果 · A5 竖版</option>`)
    expect(toolHtml).toContain('templates[HeartStarPreset.candyName]=HeartStarPreset.buildCandy(customAssets,buildCustomLayout);')
  })

  it('提供透明背景的独立矢量素材，供更换图案与自定义排版复用', () => {
    const { assets } = setup()
    const motifs = Object.values(assets).filter((asset: any) => asset.group === '缤纷糖果') as any[]
    expect(motifs).toHaveLength(27)
    for (const asset of motifs) {
      expect(asset.frame).toEqual({ x: .5, y: .5, w: 1, h: 1 })
      expect(asset.src).toMatch(/^data:image\/svg\+xml/)
      const svg = decodeURIComponent(asset.src.slice(asset.src.indexOf(',') + 1))
      expect(svg).toContain('<pattern')
      expect(svg).not.toMatch(/<image|<text|https?:\/\/(?!www.w3.org)/)
      const bounds = svg.match(/viewBox="([\d. -]+)"/)![1]!.split(' ').map(Number)
      expect(bounds[2]! / bounds[3]!).toBeCloseTo(asset.nativeW / asset.nativeH)
      expect(asset.w / asset.h).toBeCloseTo(asset.nativeW / asset.nativeH, 2)
    }
  })

  it('提供十款 I/ME，沿用原字母组合的比例和头像框，并限制在 30mm 内', () => {
    const { assets } = setup()
    const expected = [
      ['blue-cocoa', '蓝色可可波点'], ['strawberry-milk', '草莓牛奶'], ['lemon-soda', '柠檬苏打'],
      ['grape-checker', '葡萄棋盘格'], ['peach-heart', '桃子心动'], ['cream-pink-dot', '奶油黄粉波点'],
      ['strawberry-star', '草莓奶星'], ['grape-dot', '葡萄大波点'], ['peach-sorbet', '蜜桃沙冰'], ['daisy', '雏菊花园'],
    ]
    const original = JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!)['ime-rose']
    expect(Object.values(assets).filter((a: any) => a.group === 'I ♥ ME 组合')).toHaveLength(10)
    for (const [key, label] of expected) {
      const id = `ime-candy-${key}`, asset = assets[id]
      expect(asset).toBeDefined()
      expect(asset).toMatchObject({ baseName: `${label} I ♥ ME`, group: 'I ♥ ME 组合', type: 'heart', variant: '原款', frame: original.frame })
      expect(asset.nativeW / asset.nativeH).toBeCloseTo(original.nativeW / original.nativeH)
      expect(Math.max(asset.nativeW, asset.nativeH)).toBeLessThanOrEqual(30)
      expect(existsSync(new URL('../../public/embedded/heart-star/' + asset.src.replace('./', ''), import.meta.url))).toBe(true)
    }
    expect(toolHtml).toContain('Object.assign(customAssets,HeartStarCandy.register(customAssets));')
  })
})
