import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'
import catalogSource from '../../public/embedded/heart-star/motif-catalog.js?raw'

function setup() {
  const scope: any = {}
  new Function('globalThis', catalogSource)(scope)
  const assets = { ...JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!), ...scope.HeartStarMotifCatalog.assets }
  for (const [file, api] of [['ive-motifs.js', 'HeartStarIVE'], ['pink-motifs.js', 'HeartStarPink']]) {
    new Function('globalThis', readFileSync(new URL(`../../public/embedded/heart-star/${file}`, import.meta.url), 'utf8'))(scope)
    Object.assign(assets, scope[api!].register(assets))
  }
  new Function('globalThis', readFileSync(new URL('../../public/embedded/heart-star/template-motifs.js', import.meta.url), 'utf8'))(scope)
  scope.HeartStarMotifs.limitSmallHearts(assets)
  scope.HeartStarMotifs.limitIMe(assets)
  const path = new URL('../../public/embedded/heart-star/heart-preset.js', import.meta.url)
  if (existsSync(path)) new Function('globalThis', readFileSync(path, 'utf8'))(scope)
  const start = toolHtml.indexOf('function buildCustomLayout(')
  const build = new Function(`${toolHtml.slice(start, toolHtml.indexOf('\n}', start) + 2)};return buildCustomLayout`)()
  return { api: scope.HeartStarPreset, assets, build }
}

describe('heart-star independent 210×144 template', () => {
  it('creates two rows of six letter combinations and three rows of eight small motifs at their native dimensions', () => {
    const { api, assets, build } = setup()
    expect(api).toBeDefined()
    const cfg = api.build(assets, build)
    expect(cfg).toMatchObject({ w: 2100, h: 1440, widthMm: 210, heightMm: 144 })
    expect(cfg.slots).toHaveLength(36)
    expect([0, 1, 2, 3, 4].map(row => cfg.slots.filter((s: any) => s.row === row).length)).toEqual([6, 6, 8, 8, 8])
    cfg.placements.forEach((p: any, i: number) => {
      const a = assets[p.assetId]
      expect(p.w).toBeCloseTo(a.nativeW * 10)
      expect(p.h).toBeCloseTo(a.nativeH * 10)
      if (a.type === 'heart' && a.variant === '小款') expect(p.w).toBe(195)
      expect(p.x).toBeGreaterThanOrEqual(30)
      expect(p.y).toBeGreaterThanOrEqual(30)
      expect(p.x + p.w).toBeLessThanOrEqual(2070.001)
      expect(p.y + p.h).toBeLessThanOrEqual(1410.001)
      expect(cfg.motifSlots[i].variant).toBe(i < 12 ? '原款' : '小款')
      expect(['I ♥ ME 组合', 'I ♥ VE 组合'].includes(a.group)).toBe(i < 12)
    })
  })

  it('places the requested five rows in left-to-right order', () => {
    const { api, assets, build } = setup()
    const cfg = api.build(assets, build)
    const expected = [
      ['ime-rose', 'ime-rose', 'ime-rose', 'ime-teal', 'ime-teal', 'ime-teal'],
      ['ime-mint', 'ime-mint', 'ime-mint', 'ive-spiral', 'ive-spiral', 'ive-spiral'],
      ['rose-heart-small', 'rose-heart-small', 'rose-heart-small', 'rose-dot-star-small', 'teal-dot-star-small', 'teal-heart-small', 'teal-heart-small', 'teal-heart-small'],
      ['pink-stripe-heart-small', 'pink-stripe-heart-small', 'pink-stripe-heart-small', 'mint-star-small', 'white-mint-star-small', 'mint-plaid-heart-small', 'mint-plaid-heart-small', 'mint-plaid-heart-small'],
      ['purple-white-polka-heart-small', 'purple-white-polka-heart-small', 'purple-white-polka-heart-small', 'purple-white-polka-heart-small', 'polka-heart-small', 'polka-heart-small', 'polka-heart-small', 'polka-heart-small'],
    ]
    expect(expected.map((_, row) => cfg.placements.filter((_: any, i: number) => cfg.slots[i].row === row).map((p: any) => p.assetId))).toEqual(expected)
  })

  it('restores the previously configured paper size when leaving the independent template', () => {
    const { api, assets, build } = setup()
    const width = { value: '293' }, height = { value: '210' }
    api.selectSize(api.build(assets, build), width, height)
    expect([width.value, height.value]).toEqual(['210', '144'])
    api.selectSize({}, width, height)
    expect([width.value, height.value]).toEqual(['293', '210'])
  })
})
