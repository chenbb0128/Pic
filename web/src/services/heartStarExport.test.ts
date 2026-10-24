import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function section(start: string, end: string) {
  const index = toolHtml.indexOf(start)
  return toolHtml.slice(index, toolHtml.indexOf(end, index))
}

function setup() {
  const downloads: string[] = [], messages: string[] = [], paintedText: string[] = [], metadata: number[] = [], geometry: any[] = [], snapshots: number[][] = []
  const env: any = {
    widthInput: { value: '144' }, heightInput: { value: '210' }, dpiInput: { value: '600' },
    footerHeightMm: 3, numberingEnabled: { checked: true }, footerText: { value: '订单001', focus() {} },
    sel: { value: 'heart.png' }, templates: { 'heart.png': {} },
    exportBusy: false, customBusy: false, customDirty: false, slotBackgrounds: { busy: () => false },
    motifEditor: { busy: () => false },
    draw(_selection = true, fullResolution = false) {
      const d = env.renderConfig(fullResolution)
      env.canvas.width = d.pxW; env.canvas.height = d.pxH
    }, say: (message: string) => messages.push(message), updateCanvasSize() {},
    canvas: { width: 1082, height: 1600, toBlob(callback: (blob: Blob | null) => void) { callback(new Blob()) } },
    HeartStarWatermark: { preview: (source: any) => source },
    addDpiMetadata: async (blob: Blob, dpi: number) => { metadata.push(dpi); return blob },
    document: { getElementById: () => ({}), createElement: (tag: string) => tag === 'canvas' ? {
      width: 0, height: 0, getContext: () => env.ctx,
      toBlob(callback: (blob: Blob) => void) { snapshots.push([this.width, this.height]); callback(new Blob()) },
    } : ({
      download: '', click() { downloads.push(this.download) },
    }) },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, setTimeout() {},
    ctx: { save() {}, beginPath() {}, rect: (...args: number[]) => geometry.push(['rect', ...args]), clip() {}, restore() {},
      drawImage: (...args: any[]) => geometry.push(['drawImage', ...args]),
      clearRect: (...args: number[]) => geometry.push(['clearRect', ...args]),
      translate: (...args: number[]) => geometry.push(['translate', ...args]), rotate: (angle: number) => geometry.push(['rotate', angle]),
      measureText: () => ({ width: 20 }), fillText: (text: string) => paintedText.push(text) },
  }
  const source = section('function localDateLabel(', 'async function copyFooterLabel(') +
    section('function outputConfig(', 'function updateCanvasSize(') +
    section('async function exportPng(', 'const customAssets=') +
    section('async function getCloudResult(', 'var sharedLibrary=')
  const feature = new Function('env', `with(env){${source};return {outputConfig,renderConfig,drawFooter,pngFilename,exportPng,getCloudResult}}`)(env)
  env.outputConfig = feature.outputConfig
  env.renderConfig = feature.renderConfig
  return { env, feature, downloads, messages, paintedText, metadata, geometry, snapshots }
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
    expect(downloads).toEqual(['订单001_heart_144x213mm_600dpi.png'])
  })

  it('rotates landscape PNG clockwise without scaling and redraws the footer upright at the bottom', async () => {
    const { env, feature, snapshots, geometry, paintedText, metadata } = setup()
    env.widthInput.value = '210'
    env.heightInput.value = '144'
    await feature.exportPng()
    expect(snapshots).toEqual([[3402, 5031]])
    expect(geometry).toEqual([
      ['translate', 3402, 0], ['rotate', Math.PI / 2], ['drawImage', env.canvas, 0, 0],
      ['clearRect', 0, 4961, 3402, 70], ['rect', 0, 4961, 3402, 70],
    ])
    expect(paintedText).toEqual(['订单001'])
    expect(metadata).toEqual([600])
    expect([env.canvas.width, env.canvas.height]).toEqual([1600, 1082])
  })

  it('exports landscape without numbering as portrait content without adding blank space', async () => {
    const { env, feature, snapshots, downloads, paintedText } = setup()
    env.widthInput.value = '210'
    env.heightInput.value = '144'
    env.numberingEnabled.checked = false
    await feature.exportPng()
    expect(snapshots).toEqual([[3402, 4961]])
    expect(downloads[0]).toMatch(/_144x210mm_600dpi.png$/)
    expect(paintedText).toEqual([])
  })

  it('rotates lightweight watermarked exports while keeping the order number', async () => {
    const { env, feature, snapshots, downloads, geometry } = setup()
    env.widthInput.value = '210'
    env.heightInput.value = '144'
    const watermarks: number[][] = []
    env.HeartStarWatermark.preview = (source: any) => { watermarks.push([source.width, source.height]); return source }
    await feature.exportPng(true)
    expect(watermarks).toEqual([[1082, 1600]])
    expect(snapshots).toEqual([[1082, 1600]])
    expect(geometry).toContainEqual(['clearRect', 0, 1578, 1082, 22])
    expect(downloads[0]).toBe('订单001_heart_144x213mm_600dpi_水印预览.png')
    expect(env.footerText.value).toBe('订单001')
  })

  it('saves the same portrait high-resolution result to the shared library and restores landscape editing', async () => {
    const { env, feature, snapshots, metadata } = setup()
    env.widthInput.value = '210'
    env.heightInput.value = '144'
    const blob = await feature.getCloudResult()
    expect(blob).toBeInstanceOf(Blob)
    expect(snapshots).toEqual([[3402, 5031]])
    expect(metadata).toEqual([600])
    expect([env.canvas.width, env.canvas.height]).toEqual([1600, 1082])
    expect(env.footerText.value).toBe('订单001')
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
