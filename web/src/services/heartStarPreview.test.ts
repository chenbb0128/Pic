import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function section(start: string, end: string) {
  return toolHtml.slice(toolHtml.indexOf(start), toolHtml.indexOf(end))
}

function setup() {
  const controls = new Map<string, any>()
  const scheduled: (() => void)[] = [], paints: any[] = [], snapshots: any[] = []
  const output = { w: 144, h: 210, totalH: 213, dpi: 600, pxW: 3402, pxH: 5031, contentPxH: 4961, footerPxH: 70 }
  const env: any = {
    outputConfig: () => output,
    canvas: { width: 0, height: 0, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1082, height: 1600 }),
      toBlob(callback: (blob: Blob) => void) { snapshots.push([this.width, this.height]); callback(new Blob()) } },
    document: { getElementById(id: string) {
      if (!controls.has(id)) controls.set(id, {})
      return controls.get(id)
    }, createElement: () => ({ click() {} }) },
    pngFilename: () => 'test.png', resizePreview() {}, sel: { value: 'test' },
    templates: { test: { w: 1400, h: 2048, slots: [] } }, base: { complete: true, naturalWidth: 1400 },
    slotBackgrounds: { update() {}, busy: () => false, hasAny: () => true },
    HeartStarBackground: { drawTemplate() {} },
    ctx: { clearRect() {}, save() {}, beginPath() {}, clip() {}, restore() {},
      rect(...args: number[]) { paints.push(args) }, scale() {} },
    drawFooter() {}, updatePhotoControls() {}, download: {}, states: [],
    exportBusy: false, photoUploadBusy: false, replacementBusy: false,
    photoFrameRequest: 0, requestAnimationFrame(callback: () => void) { scheduled.push(callback); return scheduled.length },
    cancelAnimationFrame() {}, footerText: { value: 'test' }, customBusy: false, customDirty: false,
    hasSlotPhotos: () => false, addDpiMetadata: async (blob: Blob, dpi: number) => { snapshots.push(dpi); return blob },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, setTimeout() {}, say() {},
    currentSlots: () => env.templates.test.slots, slotFrame: (i: number) => env.templates.test.slots[i],
  }
  const source = section('function renderConfig(', 'function loadTemplate(') +
    section('function draw(showSelection', 'function chooseAtCanvas(') +
    section('function requestPhotoDraw(', 'function startPhotoDrag(') +
    section('function slotAtCanvas(', 'function requestPhotoDraw(') +
    section('async function exportPng(', 'const customAssets=')
  const feature = new Function('env', `with(env){${source};return {renderConfig,draw,requestPhotoDraw,slotAtCanvas,exportPng}}`)(env)
  return { env, feature, output, scheduled, paints, snapshots }
}

describe('heart-star lightweight preview', () => {
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

  it('maps selection to preview coordinates and distinguishes the footer from the last row', () => {
    const { feature, env } = setup()
    feature.draw()
    env.templates.test.slots = [{ x: 700, y: 1024, w: 200, h: 200 }]
    env.states = [{ dx: 0, dy: 0 }]
    expect(feature.slotAtCanvas({ clientX: 541, clientY: 789 })).toMatchObject({ index: 0, x: 700, y: 1024 })
    expect(feature.slotAtCanvas({ clientX: 541, clientY: 1590 }).footer).toBe(true)
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
