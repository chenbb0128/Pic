import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function section(start: string, end: string) {
  return toolHtml.slice(toolHtml.indexOf(start), toolHtml.indexOf(end))
}

function setup() {
  const controls = new Map<string, any>()
  const scheduled: (() => void)[] = [], paints: any[] = [], snapshots: any[] = [], downloads: string[] = []
  const output = { w: 144, h: 210, totalW: 144, totalH: 213, dpi: 600, pxW: 3402, pxH: 5031, contentPxW: 3402, contentPxH: 4961, footerPxW: 0, footerPxH: 70 }
  const env: any = {
    sharedLibrary: undefined,
    outputConfig: () => output,
    canvas: { width: 0, height: 0, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1082, height: 1600 }),
      toBlob(callback: (blob: Blob) => void) { snapshots.push([this.width, this.height]); callback(new Blob()) } },
    document: { getElementById(id: string) {
      if (!controls.has(id)) controls.set(id, {})
      return controls.get(id)
    }, createElement: () => ({ download: '', click() { downloads.push(this.download) } }) },
    HeartStarWatermark: { preview(source: any) { return { width: source.width, height: source.height,
      toBlob(callback: (blob: Blob) => void) { snapshots.push(['watermark', source.width, source.height]); callback(new Blob()) } } } },
    pngFilename: () => 'test.png', resizePreview() {}, sel: { value: 'test' }, clip: { checked: true },
    templates: { test: { w: 1400, h: 2048, slots: [] } }, base: { complete: true, naturalWidth: 1400 },
    slotBackgrounds: { update() {}, busy: () => false, hasAny: () => true },
    backgroundDrag: { update() {} },
    motifEditor: { source: (base: any) => base, busy: () => false }, updateMotifControls() {},
    HeartStarBackground: { drawTemplate() {}, frame: (cfg: any, _source: any, states: any[], i: number) => states[i]?.motif?.frame || cfg.slots[i] },
    ctx: { clearRect() {}, save() {}, beginPath() {}, clip() {}, restore() {},
      rect(...args: number[]) { paints.push(args) }, scale() {} },
    drawFooter() {}, updatePhotoControls() {}, download: {}, watermarkDownload: {}, states: [],
    exportBusy: false, photoUploadBusy: false, replacementBusy: false,
    photoFrameRequest: 0, requestAnimationFrame(callback: () => void) { scheduled.push(callback); return scheduled.length },
    cancelAnimationFrame() {}, numberingEnabled: { checked: true }, footerText: { value: 'test', focus() {} }, customBusy: false, customDirty: false,
    hasSlotPhotos: () => false, addDpiMetadata: async (blob: Blob, dpi: number) => { snapshots.push(dpi); return blob },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, setTimeout() {}, say() {},
    currentSlots: () => env.templates.test.slots, slotFrame: (i: number) => env.templates.test.slots[i],
  }
  const source = section('function renderConfig(', 'function loadTemplate(') +
    section('function draw(showSelection', 'function chooseAtCanvas(') +
    section('function requestPhotoDraw(', 'function startPhotoDrag(') +
    section('function slotFrame(', 'function requestPhotoDraw(') +
    section('async function exportPng(', 'const customAssets=') +
    section('function picturePreviewSnapshot(', 'function resizePreview(') +
    section('function selectionBoard(', 'HeartStarInteractions.createSelection(')
  const feature = new Function('env', `with(env){${source};return {renderConfig,draw,requestPhotoDraw,slotFrame,slotAtCanvas,exportPng,picturePreviewSnapshot,selectionBoard}}`)(env)
  return { env, feature, output, scheduled, paints, snapshots, downloads, controls }
}

describe('heart-star lightweight preview', () => {
  it('keeps landscape drawing and hit testing inside the content, excluding the right numbering strip', () => {
    const { env, feature, output, paints } = setup()
    Object.assign(output, { w: 210, h: 144, totalW: 213, totalH: 144, pxW: 5031, pxH: 3402,
      contentPxW: 4961, contentPxH: 3402, footerPxW: 70, footerPxH: 0 })
    env.templates.test = { w: 2100, h: 1440, slots: [{ x: 1050, y: 720, w: 200, h: 200 }] }
    env.states = [{ size: 1, dx: 0, dy: 0 }]
    env.selectedSlots = new Set()
    env.slotPhoto = () => null
    env.HeartStarBackground.has = () => false
    const scales: number[][] = []
    env.ctx.scale = (...args: number[]) => scales.push(args)
    feature.draw(false)
    feature.draw(false, true)
    expect(paints).toEqual([[0, 0, 1578, 1082], [0, 0, 4961, 3402]])
    expect(scales).toEqual([[1578 / 2100, 1082 / 1440], [4961 / 2100, 3402 / 1440]])
    const r = env.canvas.getBoundingClientRect()
    expect(feature.slotAtCanvas({ clientX: r.width * 1578 / 1600 / 2, clientY: r.height / 2 }))
      .toMatchObject({ index: 0, x: 1050, y: 720 })
    expect(feature.slotAtCanvas({ clientX: r.width - 1, clientY: r.height / 2 }).footer).toBe(true)
    expect(feature.selectionBoard()).toMatchObject({ contentWidthRatio: 1578 / 1600, contentRatio: 1 })
  })

  it('reports landscape total width and right-side numbering in the size summary', () => {
    const { feature, output, controls } = setup()
    Object.assign(output, { w: 210, h: 144, totalW: 213, totalH: 144, pxW: 5031, pxH: 3402,
      contentPxW: 4961, contentPxH: 3402, footerPxW: 70, footerPxH: 0, footerSide: 'right' })
    feature.draw(false)
    expect(controls.get('exportSize').textContent).toBe('213 × 144 mm')
    expect(controls.get('footerAreaLabel').textContent).toBe('右侧编号区')
    expect(controls.get('footerAreaSize').textContent).toBe('另加 3 mm 宽')
    expect(controls.get('footerSizeHint').textContent).toBe('含右侧编号区')
  })

  it('drags photos using the content width rather than the full width including the right strip', () => {
    const { env, feature, output } = setup()
    Object.assign(output, { w: 210, h: 144, totalW: 213, totalH: 144, pxW: 5031, pxH: 3402,
      contentPxW: 4961, contentPxH: 3402, footerPxW: 70, footerPxH: 0 })
    env.templates.test = { w: 2100, h: 1440, slots: [{ x: 1050, y: 720, w: 200, h: 200 }] }
    env.states = [{ size: 1, dx: 0, dy: 0 }]
    Object.assign(env, { selectedSlots: new Set([0]), photoDrag: null, photoDragMode: { checked: true },
      canEditPhoto: () => true, slotPhoto: () => ({}), slotAtCanvas: feature.slotAtCanvas,
      renderConfig: feature.renderConfig, updatePhotoControls() {}, draw() {}, requestPhotoDraw() {} })
    env.canvas.setPointerCapture = () => {}
    const drag = new Function('env', `with(env){${section('function startPhotoDrag(', 'function finishPhotoDrag(')};return {startPhotoDrag,movePhotoDrag}}`)(env)
    const r = env.canvas.getBoundingClientRect(), contentWidth = r.width * 1578 / 1600
    const start = { button: 0, isPrimary: true, pointerId: 1, clientX: contentWidth / 2, clientY: r.height / 2, preventDefault() {} }
    drag.startPhotoDrag(start)
    drag.movePhotoDrag({ ...start, clientX: start.clientX + contentWidth / 21, clientY: start.clientY + r.height / 144 })
    expect(env.states[0]).toMatchObject({ imageDx: 100, imageDy: 10 })
  })

  it('measures photo-only selection using the current replacement artwork, not the original template', () => {
    const { env, feature } = setup()
    const replacement = { width: 1400, height: 2048 }
    let measured: any
    env.templates.test.slots = [{ x: 30, y: 40, w: 20, h: 20 }]
    env.motifEditor.source = () => replacement
    env.HeartStarBackground.frame = (_cfg: any, source: any) => {
      measured = source
      return { x: 35, y: 45, w: 40, h: 40 }
    }
    expect(feature.slotFrame(0)).toEqual({ x: 35, y: 45, w: 40, h: 40 })
    expect(measured).toBe(replacement)
  })

  it('centers heart artwork and keeps photo frames and selection in the same coordinates at preview and export resolution', () => {
    const { env, feature } = setup()
    const templates = new Function(`${section('const templates=', 'const canvas=')};return templates`)()
    const original = templates['模板爱心.png']
    env.templates.test = { ...original, slots: [original.slots[0]] }
    env.states = [{ size: .62, dx: 0, dy: 0 }]
    env.selectedSlots = new Set()
    env.slotPhoto = () => null
    env.HeartStarBackground.has = () => false
    const translations: number[][] = []
    env.ctx.translate = (...args: number[]) => translations.push(args)
    expect(feature.slotFrame(0)).toMatchObject({ x: 113, y: 118, w: 190, h: 190 })
    expect(feature.selectionBoard().slots[0].x).toBe(113)
    expect(original.slots[0].x).toBe(95)
    // The original image occupies columns 0–1376 of a 1413 px canvas.
    expect(1413 - (1377 + feature.slotFrame(0).x - 95)).toBe(18)
    feature.draw(false)
    feature.draw(false, true)
    expect(translations).toEqual([[18, 0], [18, 0]])
    const r = env.canvas.getBoundingClientRect()
    const d = feature.renderConfig()
    const hit = feature.slotAtCanvas({ clientX: 113 / 1413 * r.width, clientY: 118 / 2048 * r.height * d.contentPxH / d.pxH })
    expect(hit.index).toBe(0)
    expect(hit.x).toBeCloseTo(113)
    env.states[0].motif = { frame: { x: 203, y: 1518, w: 136, h: 135 } }
    expect(feature.slotFrame(0).x).toBe(221)
  })

  it('uses the replaced whole-motif artwork for rendering and blocks export while a replacement is loading', async () => {
    const { env, feature, snapshots } = setup()
    const composite = { width: 1400, height: 2048 }
    let rendered: any
    env.motifEditor.source = () => composite
    env.HeartStarBackground.drawTemplate = (_ctx: any, _cfg: any, image: any) => { rendered = image }
    feature.draw()
    expect(rendered).toBe(composite)
    env.motifEditor.busy = () => true
    await feature.exportPng()
    expect(snapshots).toEqual([])
    expect(feature.selectionBoard().ready).toBe(false)
  })

  it('limits editing canvas pixels without changing the configured export dimensions', () => {
    const { feature, env, output } = setup()
    feature.draw()
    expect([env.canvas.width, env.canvas.height]).toEqual([1082, 1600])
    expect(feature.renderConfig().contentPxH).toBe(1578)
    expect(feature.renderConfig().footerPxH).toBe(22)
    expect(feature.renderConfig(true)).toBe(output)
    expect(output.dpi).toBe(600)
    expect(output.pxH).toBe(5031)
    expect(feature.renderConfig().dpi).toBeCloseTo(190.8169)
  })

  it('captures PNG at full resolution and restores the lightweight canvas afterward', async () => {
    const { feature, env, snapshots } = setup()
    await feature.exportPng()
    expect(snapshots).toEqual([[3402, 5031], 600])
    expect([env.canvas.width, env.canvas.height]).toEqual([1082, 1600])
    expect(env.exportBusy).toBe(false)
  })

  it('exports a lightweight watermarked proof instead of the full-resolution printing file', async () => {
    const { feature, env, snapshots, downloads } = setup()
    await feature.exportPng(true)
    expect(snapshots).toEqual([['watermark', 1082, 1600]])
    expect(downloads).toEqual(['test_水印预览.png'])
    expect([env.canvas.width, env.canvas.height]).toEqual([1082, 1600])
    expect(env.exportBusy).toBe(false)
  })

  it('keeps the regular download click event on the clean full-resolution export path', async () => {
    const { feature, snapshots, downloads } = setup()
    await feature.exportPng({ type: 'click' })
    expect(snapshots).toEqual([[3402, 5031], 600])
    expect(downloads).toEqual(['test.png'])
  })

  it('takes an isolated popup snapshot without changing selection or print dimensions', () => {
    const { feature, env, snapshots } = setup()
    env.selectedSlots = new Set([0, 2])
    env.templates.test.slots = [{ x: 700, y: 1024, w: 200, h: 200 }]
    env.states = [{ size: 1, dx: 0, dy: 0 }]
    env.slotPhoto = () => null
    env.HeartStarBackground.frame = () => env.templates.test.slots[0]
    env.HeartStarBackground.has = () => false
    let selectionPaints = 0, selectionPaintsAtSnapshot = -1
    env.ctx.setLineDash = () => {}
    env.ctx.strokeRect = () => { selectionPaints++ }
    env.HeartStarWatermark.preview = (source: any) => {
      selectionPaintsAtSnapshot = selectionPaints
      return { width: source.width, height: source.height }
    }
    const picture = feature.picturePreviewSnapshot()
    expect(selectionPaintsAtSnapshot).toBe(0)
    expect(selectionPaints).toBe(1)
    expect([picture.width, picture.height]).toEqual([1082, 1600])
    expect([...env.selectedSlots]).toEqual([0, 2])
    expect(env.outputConfig().dpi).toBe(600)
    expect([env.canvas.width, env.canvas.height]).toEqual([1082, 1600])
    expect(snapshots).toEqual([])
  })

  it('maps selection to preview coordinates and distinguishes the footer from the last row', () => {
    const { feature, env } = setup()
    feature.draw()
    env.templates.test.slots = [{ x: 700, y: 1024, w: 200, h: 200 }]
    env.states = [{ dx: 0, dy: 0 }]
    expect(feature.slotAtCanvas({ clientX: 541, clientY: 789 })).toMatchObject({ index: 0, x: 700, y: 1024 })
    expect(feature.slotAtCanvas({ clientX: 541, clientY: 1590 }).footer).toBe(true)
  })

  it('enables regular template selection even before a custom layout has been generated', () => {
    const { feature, env } = setup()
    env.customDirty = true
    expect(feature.selectionBoard().ready).toBe(true)
    expect(feature.selectionBoard().contentRatio).toBe(1578 / 1600)
    env.templates.test.custom = true
    expect(feature.selectionBoard().ready).toBe(false)
    env.templates.test.custom = false
    env.canvas.hidden = true
    expect(feature.selectionBoard().ready).toBe(false)
  })

  it('coalesces repeated preview requests into one paint per animation frame', () => {
    const { feature, scheduled, paints } = setup()
    feature.requestPhotoDraw()
    feature.requestPhotoDraw()
    feature.requestPhotoDraw()
    expect(scheduled).toHaveLength(1)
    expect(paints).toHaveLength(0)
    scheduled[0]!()
    expect(paints).toHaveLength(1)
    feature.requestPhotoDraw()
    expect(scheduled).toHaveLength(2)
  })
})
