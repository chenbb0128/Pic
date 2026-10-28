import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'
import catalogSource from '../../public/embedded/heart-star/motif-catalog.js?raw'

function setup() {
  const scope: any = {}
  new Function('globalThis', catalogSource)(scope)
  const assets = { ...JSON.parse(toolHtml.match(/const customAssets=(\{[^\n]+\});/)![1]!), ...scope.HeartStarMotifCatalog.assets }
  for (const [file, api] of [['ive-motifs.js', 'HeartStarIVE'], ['brown-motifs.js', 'HeartStarBrown'], ['pink-motifs.js', 'HeartStarPink'], ['red-motifs.js', 'HeartStarRed'], ['caramel-leopard-motifs.js', 'HeartStarCaramelLeopard'], ['autumn-maple-leopard-motifs.js', 'HeartStarAutumnMapleLeopard'], ['black-pink-leopard-motifs.js', 'HeartStarBlackPinkLeopard'], ['cream-pink-leopard-motifs.js', 'HeartStarCreamPinkLeopard'], ['light-blue-motifs.js', 'HeartStarLightBlue'], ['pattern-combos.js', 'HeartStarPatternCombos']]) {
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
  it('adds a separate black-pink and cream-pink leopard preset with equal quantities and the classic mixed geometry', () => {
    const { api, assets, build } = setup()
    const before = JSON.stringify(assets)
    const classic = api.buildClassicLeopard(assets, build)
    const cfg = api.buildBlackPinkCreamLeopard(assets, build)
    expect(api.blackPinkCreamLeopardName).not.toBe(api.classicLeopardName)
    expect(cfg).not.toBe(classic)
    expect(cfg).toMatchObject({ preset: true, w: 1440, h: 2100, widthMm: 144, heightMm: 210 })
    expect(cfg.slots).toHaveLength(40)
    expect(cfg.placements).toEqual(classic.placements.map((p: any) => ({ ...p,
      assetId: p.assetId.replace('caramel-leopard', 'black-pink-leopard').replace('autumn-maple-leopard', 'cream-pink-leopard'),
    })))
    for (const family of ['black-pink-leopard', 'cream-pink-leopard']) {
      expect(cfg.placements.filter((p: any) => p.assetId.includes(family))).toHaveLength(20)
      for (const [suffix, count] of [['star-small', 6], ['heart-small', 6], ['heart', 2], ['star', 2]] as const) {
        expect(cfg.placements.filter((p: any) => p.assetId === `${family}-${suffix}`)).toHaveLength(count)
      }
      expect(cfg.placements.filter((p: any) => p.assetId === `ime-${family}`)).toHaveLength(4)
    }
    cfg.placements.forEach((p: any, i: number) => {
      const asset = assets[p.assetId]
      const factor = cfg.slots[i].row < 4 ? 1 : Math.min(1, 27.5 / Math.max(asset.nativeW, asset.nativeH))
      expect(p.w).toBeCloseTo(asset.nativeW * factor * 10)
      expect(p.h).toBeCloseTo(asset.nativeH * factor * 10)
      expect(cfg.motifSlots[i]).toMatchObject({ name: asset.baseName, variant: asset.variant, box: [p.x, p.y, p.w, p.h] })
      expect(cfg.slots[i].assetId).toBe(p.assetId)
      expect(api.initialState(cfg, i).background).toBeUndefined()
    })
    expect(JSON.stringify(assets)).toBe(before)
    expect(toolHtml).toContain(`<option value="${api.blackPinkCreamLeopardName}">黑粉奶油混合豹纹</option>`)
    expect(toolHtml).toContain('templates[HeartStarPreset.blackPinkCreamLeopardName]=HeartStarPreset.buildBlackPinkCreamLeopard(customAssets,buildCustomLayout);')
  })

  it('builds the classic leopard mixed preset with 40 proportional motifs and consistent row spacing', () => {
    const { api, assets, build } = setup()
    const before = JSON.stringify(assets)
    const cfg = api.buildClassicLeopard(assets, build)
    expect(cfg).toMatchObject({ preset: true, w: 1440, h: 2100, widthMm: 144, heightMm: 210 })
    const expected = [
      [...Array(3).fill('caramel-leopard-star-small'), ...Array(3).fill('autumn-maple-leopard-star-small')],
      [...Array(3).fill('caramel-leopard-star-small'), ...Array(3).fill('autumn-maple-leopard-star-small')],
      [...Array(3).fill('caramel-leopard-heart-small'), ...Array(3).fill('autumn-maple-leopard-heart-small')],
      [...Array(3).fill('caramel-leopard-heart-small'), ...Array(3).fill('autumn-maple-leopard-heart-small')],
      ['caramel-leopard-heart', 'autumn-maple-leopard-heart', 'caramel-leopard-star', 'autumn-maple-leopard-star'],
      ['caramel-leopard-heart', 'autumn-maple-leopard-heart', 'caramel-leopard-star', 'autumn-maple-leopard-star'],
      ['ime-caramel-leopard', 'ime-caramel-leopard', 'ime-autumn-maple-leopard', 'ime-autumn-maple-leopard'],
      ['ime-caramel-leopard', 'ime-caramel-leopard', 'ime-autumn-maple-leopard', 'ime-autumn-maple-leopard'],
    ]
    expect(cfg.slots).toHaveLength(40)
    const rows = expected.map((_, row) => cfg.placements.filter((_: any, i: number) => cfg.slots[i].row === row))
    expect(rows.map((row: any[]) => row.map(p => p.assetId))).toEqual(expected)
    for (const family of ['caramel-leopard', 'autumn-maple-leopard']) {
      expect(cfg.placements.filter((p: any) => p.assetId.includes(family))).toHaveLength(20)
      for (const [suffix, count] of [['star-small', 6], ['heart-small', 6], ['heart', 2], ['star', 2]] as const) {
        expect(cfg.placements.filter((p: any) => p.assetId === `${family}-${suffix}`)).toHaveLength(count)
      }
      expect(cfg.placements.filter((p: any) => p.assetId === `ime-${family}`)).toHaveLength(4)
    }
    rows.forEach((row: any[], r: number) => {
      expect(row[0].x).toBeCloseTo(cfg.w - row.at(-1).x - row.at(-1).w)
      row.forEach((p, column) => {
        const asset = assets[p.assetId]
        const factor = r < 4 ? 1 : Math.min(1, 27.5 / Math.max(asset.nativeW, asset.nativeH))
        expect(p.w).toBeCloseTo(asset.nativeW * factor * 10)
        expect(p.h).toBeCloseTo(asset.nativeH * factor * 10)
        expect(p.w / p.h).toBeCloseTo(asset.nativeW / asset.nativeH)
        if (r < 4 && asset.type === 'heart') expect(p.w / 10).toBe(19.5)
        if (r >= 4) {
          expect(Math.max(p.w, p.h) / 10).toBeLessThanOrEqual(27.5 + 1e-10)
          expect(cfg.motifSlots[cfg.placements.indexOf(p)].maxSizeMm).toBe(27.5)
        }
        expect(p.x).toBeGreaterThanOrEqual(29.999)
        expect(p.y).toBeGreaterThanOrEqual(29.999)
        expect(p.x + p.w).toBeLessThanOrEqual(1410.001)
        expect(p.y + p.h).toBeLessThanOrEqual(2070.001)
        if (column) expect(p.x - row[column - 1].x - row[column - 1].w).toBeGreaterThanOrEqual(19.999)
        expect(api.initialState(cfg, cfg.placements.indexOf(p)).background).toBeUndefined()
        expect(existsSync(new URL('../../public/embedded/heart-star/' + asset.src.replace('./', '').split('?')[0], import.meta.url))).toBe(true)
      })
      if (r) expect(Math.min(...row.map(p => p.y)) - Math.max(...rows[r - 1].map(p => p.y + p.h))).toBeGreaterThanOrEqual(19.999)
    })
    expect(JSON.stringify(assets)).toBe(before)
    expect(toolHtml).toContain(`<option value="${api.classicLeopardName}">经典豹纹款 · 爱心＋星星</option>`)
    expect(toolHtml).toContain('templates[HeartStarPreset.classicLeopardName]=HeartStarPreset.buildClassicLeopard(customAssets,buildCustomLayout);')
  })

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

  it('builds the separate big portrait preset with all 36 motifs in the requested order', () => {
    const { api, assets, build } = setup()
    const cfg = api.buildPortrait(assets, build)
    expect(cfg).toMatchObject({ w: 2100, h: 1440, widthMm: 210, heightMm: 144 })
    const expected = [
      ['ime-pink-stripe', 'ime-red-polka', 'ime-brown-polka', 'ime-rose', 'ime-rose', 'ime-brown-stripe'],
      ['ime-rose', 'ime-pink-dot', 'ime-light-blue-stripe', 'ive-rose', 'ive-rose', 'ive-rose'],
      ['pink-dot-heart-small', 'brown-polka-heart-small', 'brown-stripe-heart-small', 'rose-dot-star-small', 'rose-dot-star-small', 'rose-heart-small', 'rose-heart-small', 'pink-dot-heart-small'],
      ['pink-dot-heart-small', 'light-blue-stripe-heart-small', 'light-blue-stripe-heart-small', 'teal-dot-star-small', 'teal-dot-star-small', 'pink-stripe-heart-small', 'red-polka-heart-small', 'rose-heart-small'],
      ['rose-heart-small', 'rose-heart-small', 'teal-heart-small', 'teal-heart-small', 'polka-heart-small', 'rose-heart-small', 'purple-white-polka-heart-small', 'purple-white-polka-heart-small'],
    ]
    expect(expected.map((_, row) => cfg.placements.filter((_: any, i: number) => cfg.slots[i].row === row).map((p: any) => p.assetId))).toEqual(expected)
    cfg.placements.forEach((p: any) => {
      expect(p.x).toBeGreaterThanOrEqual(30)
      expect(p.y).toBeGreaterThanOrEqual(30)
      expect(p.x + p.w).toBeLessThanOrEqual(2070.001)
      expect(p.y + p.h).toBeLessThanOrEqual(1410.001)
      expect(p.w / p.h).toBeCloseTo(assets[p.assetId].nativeW / assets[p.assetId].nativeH)
      expect(existsSync(new URL('../../public/embedded/heart-star/' + assets[p.assetId].src.split('?')[0].replace('./', ''), import.meta.url))).toBe(true)
    })
    const states = cfg.slots.map((_: any, i: number) => api.initialState(cfg, i))
    expect(states.flatMap((st: any, i: number) => st.background ? [i] : [])).toEqual([10, 11, 17, 18, 33])
    for (const i of [10, 11]) expect(states[i]).toMatchObject({ imageScale: 1.2, background: { type: 'transparent', photoBaseSize: .62, keepLetters: true } })
    for (const i of [17, 18, 33]) {
      expect(states[i].background.type).toBe('transparent')
      expect(states[i].background.keepLetters).not.toBe(true)
      expect(Math.max(cfg.placements[i].w, cfg.placements[i].h)).toBeLessThanOrEqual(200)
    }
    expect(api.initialState(api.build(assets, build), 10).background).toBeUndefined()
    expect(api.initialState(cfg, 10).background).not.toBe(api.initialState(cfg, 10).background)
  })

  it('builds the eight-row macaron preset on portrait paper without stretching or changing shared assets', () => {
    const { api, assets, build } = setup()
    const before = JSON.stringify(assets)
    const cfg = api.buildMacaron(assets, build)
    expect(cfg).toMatchObject({ w: 1440, h: 2100, widthMm: 144, heightMm: 210 })
    const expected = [
      Array(6).fill('pink-dot-heart-small'),
      Array(6).fill('yellow-grid-heart-small'),
      ['pink-glow-heart-small', 'pink-glow-heart-small', 'polka-heart-small', 'polka-heart-small', 'pink-glow-heart-small', 'pink-glow-heart-small'],
      ['yellow-glow-heart-small', 'yellow-glow-heart-small', 'polka-heart-small', 'polka-heart-small', 'yellow-glow-heart-small', 'yellow-glow-heart-small'],
      [...Array(3).fill('pink-dot-heart-small'), ...Array(3).fill('polka-heart-small'), ...Array(3).fill('yellow-glow-heart-small')],
      ['pink-dot-heart', 'pink-dot-heart', 'polka-heart', 'pink-dot-heart'],
      ['yellow-grid-heart', 'yellow-grid-heart', 'polka-heart', 'yellow-grid-heart'],
      ['ime-pink-glow', 'ime-pink-dot', 'ime-polka', 'ime-yellow-grid'],
    ]
    expect(cfg.slots).toHaveLength(45)
    const rows = expected.map((_, row) => cfg.placements.filter((_: any, i: number) => cfg.slots[i].row === row))
    expect(rows.map((row: any[]) => row.map(p => p.assetId))).toEqual(expected)
    rows.forEach((row: any[], rowIndex: number) => {
      expect(row[0].x).toBeCloseTo(cfg.w - row.at(-1).x - row.at(-1).w)
      row.forEach((p, column) => {
        const asset = assets[p.assetId]
        expect(p.w / p.h).toBeCloseTo(asset.nativeW / asset.nativeH)
        expect(p.x).toBeGreaterThanOrEqual(29.999)
        expect(p.y).toBeGreaterThanOrEqual(29.999)
        expect(p.x + p.w).toBeLessThanOrEqual(1410.001)
        expect(p.y + p.h).toBeLessThanOrEqual(2070.001)
        if (column) expect(p.x - row[column - 1].x - row[column - 1].w).toBeGreaterThanOrEqual(19.999)
        if (rowIndex < 4) expect(p.w).toBeCloseTo(195)
        if (rowIndex === 4) {
          expect(Math.max(p.w, p.h)).toBeCloseTo(100)
          expect(cfg.motifSlots[cfg.placements.indexOf(p)]).toMatchObject({ maxSizeMm: 10, assetId: p.assetId })
        }
        if (rowIndex === 5 || rowIndex === 6) {
          expect(row).toHaveLength(4)
          expect(Math.max(p.w, p.h)).toBeCloseTo(300)
          expect(p.w).toBeLessThanOrEqual(asset.nativeW * 10)
          expect(p.h).toBeLessThanOrEqual(asset.nativeH * 10)
          expect(cfg.motifSlots[cfg.placements.indexOf(p)].maxSizeMm).toBe(30)
        }
        if (rowIndex === 7) expect(p.w).toBeCloseTo(asset.nativeW * 10)
        expect(api.initialState(cfg, cfg.placements.indexOf(p)).background).toBeUndefined()
        expect(existsSync(new URL('../../public/embedded/heart-star/' + asset.src.replace('./', ''), import.meta.url))).toBe(true)
      })
      if (rowIndex) expect(Math.min(...row.map(p => p.y)) - Math.max(...rows[rowIndex - 1].map(p => p.y + p.h))).toBeGreaterThanOrEqual(19.999)
    })
    expect(JSON.stringify(assets)).toBe(before)
    const width = { value: '210' }, height = { value: '144' }
    api.selectSize(cfg, width, height)
    expect([width.value, height.value]).toEqual(['144', '210'])
    api.selectSize({}, width, height)
    expect([width.value, height.value]).toEqual(['210', '144'])
    expect(toolHtml).toContain(`<option value="${api.macaronName}">爱心心动马卡龙 · 144×210 mm</option>`)
  })

  it('keeps macaron large hearts at their original size when both dimensions are within 30 mm', () => {
    const { api, assets, build } = setup()
    Object.assign(assets['pink-dot-heart'], { nativeW: 24, nativeH: 28 })
    const cfg = api.buildMacaron(assets, build)
    const hearts = cfg.placements.filter((p: any) => p.assetId === 'pink-dot-heart')
    expect(hearts).toHaveLength(3)
    hearts.forEach((p: any) => {
      expect(p.w).toBe(240)
      expect(p.h).toBe(280)
    })
    expect(assets['pink-dot-heart']).toMatchObject({ nativeW: 24, nativeH: 28 })
  })
})
