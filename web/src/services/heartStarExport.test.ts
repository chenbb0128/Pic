import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function section(start: string, end: string) {
  const index = toolHtml.indexOf(start)
  return toolHtml.slice(index, toolHtml.indexOf(end, index))
}

function setup() {
  const downloads: string[] = [], messages: string[] = [], paintedText: string[] = [], metadata: number[] = [], geometry: any[] = []
  const env: any = {
    widthInput: { value: '144' }, heightInput: { value: '210' }, dpiInput: { value: '600' },
    footerHeightMm: 3, numberingEnabled: { checked: true }, footerText: { value: '订单001', focus() {} },
    sel: { value: 'heart.png' }, templates: { 'heart.png': {} },
    exportBusy: false, customBusy: false, customDirty: false, slotBackgrounds: { busy: () => false },
    motifEditor: { busy: () => false },
    draw() {}, say: (message: string) => messages.push(message), updateCanvasSize() {},
    canvas: { width: 1082, height: 1600, toBlob(callback: (blob: Blob | null) => void) { callback(new Blob()) } },
    HeartStarWatermark: { preview: () => env.canvas },
    addDpiMetadata: async (blob: Blob, dpi: number) => { metadata.push(dpi); return blob },
    document: { getElementById: () => ({}), createElement: () => ({
      download: '', click() { downloads.push(this.download) },
    }) },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, setTimeout() {},
    ctx: { save() {}, beginPath() {}, rect: (...args: number[]) => geometry.push(['rect', ...args]), clip() {}, restore() {},
      translate: (...args: number[]) => geometry.push(['translate', ...args]), rotate: (angle: number) => geometry.push(['rotate', angle]),
      measureText: () => ({ width: 20 }), fillText: (text: string) => paintedText.push(text) },
  }
  const source = section('function localDateLabel(', 'async function copyFooterLabel(') +
    section('function outputConfig(', 'function updateCanvasSize(') +
    section('async function exportPng(', 'const customAssets=')
  const feature = new Function('env', `with(env){${source};return {outputConfig,renderConfig,drawFooter,pngFilename,exportPng}}`)(env)
  env.outputConfig = feature.outputConfig
  return { env, feature, downloads, messages, paintedText, metadata, geometry }
}

describe('heart-star numbering and DPI export', () => {
  it('adds a 3 mm strip on the right for landscape output without shrinking the artwork', async () => {
    const { env, feature, downloads, geometry, paintedText } = setup()
    env.widthInput.value = '210'
    env.heightInput.value = '144'
    const d = feature.outputConfig()
    expect(d).toMatchObject({ totalW: 213, totalH: 144, pxW: 5031, pxH: 3402,
      contentPxW: 4961, contentPxH: 3402, footerPxW: 70, footerPxH: 0, footerSide: 'right' })
    expect(feature.renderConfig()).toMatchObject({ pxW: 1600, pxH: 1082, contentPxW: 1578,
      contentPxH: 1082, footerPxW: 22, footerPxH: 0 })
    feature.drawFooter(d)
    expect(geometry).toEqual([['rect', 4961, 0, 70, 3402], ['translate', 4996, 0], ['rotate', Math.PI / 2]])
    expect(paintedText).toEqual(['订单001'])
    await feature.exportPng()
    expect(downloads).toEqual(['订单001_heart_213x144mm_600dpi.png'])
  })

  it('does not add width or height to landscape output when numbering is disabled', () => {
    const { env, feature, geometry } = setup()
    env.widthInput.value = '210'
    env.heightInput.value = '144'
    env.numberingEnabled.checked = false
    expect(feature.outputConfig()).toMatchObject({ totalW: 210, totalH: 144, pxW: 4961, pxH: 3402,
      contentPxW: 4961, contentPxH: 3402, footerPxW: 0, footerPxH: 0 })
    feature.drawFooter(feature.outputConfig())
    expect(geometry).toEqual([])
  })

  it('accepts 500 DPI and keeps the configured physical size and PNG density', async () => {
    const { env, feature, metadata, downloads } = setup()
    env.dpiInput.value = '500'
    expect(feature.outputConfig()).toMatchObject({ totalH: 213, pxW: 2835, pxH: 4193, dpi: 500 })
    await feature.exportPng()
    expect(metadata).toEqual([500])
    expect(downloads[0]).toContain('_144x213mm_500dpi.png')
  })

  it('removes the entire footer when numbering is disabled, including in the lightweight preview and filename', async () => {
    const { env, feature, paintedText, downloads } = setup()
    env.numberingEnabled.checked = false
    expect(feature.outputConfig()).toMatchObject({ totalH: 210, pxH: 4961, contentPxH: 4961, footerPxH: 0 })
    expect(feature.renderConfig()).toMatchObject({ pxH: 1600, contentPxH: 1600, footerPxH: 0 })
    feature.drawFooter(feature.outputConfig())
    expect(paintedText).toEqual([])
    expect(feature.pngFilename()).not.toContain('订单001')
    await feature.exportPng()
    expect(downloads[0]).not.toContain('订单001')
    expect(env.footerText.value).toBe('订单001')
  })

  it('rejects an empty or whitespace-only number before starting a formal export', async () => {
    const { env, feature, downloads, messages } = setup()
    env.footerText.value = '  '
    await feature.exportPng()
    expect(downloads).toEqual([])
    expect(messages.join('')).toContain('编号')
    expect(env.exportBusy).toBe(false)
  })

  it('clears the number after a successful formal download and requires a new one for the next order', async () => {
    const { env, feature, downloads } = setup()
    await feature.exportPng()
    expect(downloads).toEqual(['订单001_heart_144x213mm_600dpi.png'])
    expect(env.footerText.value).toBe('')
    await feature.exportPng()
    expect(downloads).toHaveLength(1)
  })

  it('does not consume the number when downloading a watermarked preview, and allows a preview without a number', async () => {
    const { env, feature, downloads } = setup()
    await feature.exportPng(true)
    expect(env.footerText.value).toBe('订单001')
    env.footerText.value = ''
    await feature.exportPng(true)
    expect(downloads).toHaveLength(2)
    expect(downloads.every(name => name.endsWith('_水印预览.png'))).toBe(true)
  })

  it('retains the number after PNG generation fails', async () => {
    const { env, feature, downloads, messages } = setup()
    env.canvas.toBlob = (callback: (blob: null) => void) => callback(null)
    await feature.exportPng()
    expect(downloads).toEqual([])
    expect(env.footerText.value).toBe('订单001')
    expect(messages.join('')).toContain('失败')
    expect(env.exportBusy).toBe(false)
  })

  it('does not download or clear a new number entered while the PNG is being generated', async () => {
    const { env, feature, downloads } = setup()
    let finish!: (blob: Blob) => void
    env.canvas.toBlob = (callback: (blob: Blob) => void) => { finish = callback }
    const pending = feature.exportPng()
    env.footerText.value = '订单002'
    finish(new Blob())
    await pending
    expect(downloads).toEqual([])
    expect(env.footerText.value).toBe('订单002')
  })
})
