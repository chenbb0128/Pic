import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'
import presetSource from '../../public/embedded/heart-star/heart-preset.js?raw'

function section(start: string, end: string) {
  const index = toolHtml.indexOf(start)
  return toolHtml.slice(index, toolHtml.indexOf(end, index))
}

function setup() {
  const imageA = { name: 'A' }, imageB = { name: 'B' }, images: any[] = [], revoked: string[] = []
  const controls = new Map<string, any>()
  const env: any = {
    states: [{}, {}, {}, {}], photos: [], urls: [], replacedPhotos: new Map([
      [0, { image: imageA, url: 'a' }], [1, { image: imageB, url: 'b' }],
      [2, { image: imageA, url: 'a' }], [3, { image: imageB, url: 'b' }],
    ]), replacementUrls: new Set(['a', 'b']), replacementRequest: 0, replacementBusy: false,
    replacementTarget: {}, replacePhotoFile: { value: '' }, photoUploadTarget: {},
    customRequest: 0, customTimer: 0, customBusy: false, fontInputTimer: 0, fontRequest: 0, fontBusy: false,
    replacePhoto: {}, finishPhotoDrag() {}, ignorePhotoClick: false, photoDragMode: {},
    sel: { value: 'star' }, templates: { star: { slots: Array.from({ length: 6 }, () => ({})) },
      heart: { slots: [{}, {}, {}] }, text: { text: true, slots: [{}, {}] } },
    templateSources: { star: 'star.png', heart: 'heart.png' },
    selectedSlot: 0, selectedSlots: new Set([0]), multiMode: false, base: null, canvas: {},
    Image: class { constructor() { images.push(this) } },
    URL: { revokeObjectURL(url: string) { revoked.push(url) } }, clearTimeout() {},
    document: { getElementById(id: string) {
      if (!controls.has(id)) controls.set(id, {})
      return controls.get(id)
    } },
    updateTemplateFields() {}, buildSlotSelect() {}, updateControls() {},
    updateCanvasSize: () => true, draw() {}, renderCopyJobs() {}, updateCopyHistory() {}, prepareCopyFont() {},
    ensureCopyStates: () => [{ text: 'A' }, { text: 'B' }], say() {},
    currentSlots: () => env.templates[env.sel.value].slots,
  }
  new Function('globalThis', presetSource)(env)
  const source = section('function slotPhoto(', 'function releaseUnusedReplacementUrls(') +
    section('function loadTemplate(', 'function buildSlotSelect(') +
    section('function loadCustomTemplate(', "document.getElementById('addCustomRow')")
  const feature = new Function('env', `with(env){${source};return {loadTemplate,slotPhoto,loadCustomTemplate}}`)(env)
  return { env, feature, imageA, imageB, images, revoked, controls }
}

describe('heart-star template switching', () => {
  it('does not carry deleted photos or empty placeholders to the next template', () => {
    const { env, feature, images, imageB, revoked } = setup()
    env.replacedPhotos.set(0, { image: null, url: null })
    env.replacedPhotos.set(2, { image: null, url: null })
    feature.loadTemplate()
    images[0].onload()
    expect(env.photos).toEqual([imageB])
    expect([0, 1, 2].map(i => feature.slotPhoto(i))).toEqual([imageB, imageB, imageB])
    expect(revoked).toEqual(['a'])
  })

  it('does not restore old photo sources after every photo has been deleted', () => {
    const { env, feature, images, imageA, revoked } = setup()
    env.photos = [imageA]
    env.urls = ['a']
    env.replacementUrls = new Set(['b'])
    env.replacedPhotos = new Map([0, 1, 2, 3].map(i => [i, { image: null, url: null }]))
    feature.loadTemplate()
    images[0].onload()
    expect(env.photos).toEqual([])
    expect(feature.slotPhoto(0)).toBeNull()
    expect(revoked).toEqual(['a', 'b'])
  })

  it('carries uploaded photos to every position of the next template and selects all positions', () => {
    const { env, feature, imageA, imageB, images, revoked, controls } = setup()
    feature.loadTemplate()
    images[0].onload()
    expect(Array.from({ length: 6 }, (_, i) => feature.slotPhoto(i))).toEqual([imageA, imageB, imageA, imageB, imageA, imageB])
    expect([...env.selectedSlots]).toEqual([0, 1, 2, 3, 4, 5])
    expect(env.multiMode).toBe(true)
    expect(controls.get('multiMode').checked).toBe(true)
    expect(revoked).toEqual([])
    expect(env.photos).toEqual([imageA, imageB])
    expect(env.urls).toEqual(['a', 'b'])
    env.sel.value = 'heart'
    feature.loadTemplate()
    images[1].onload()
    expect([0, 1, 2].map(i => feature.slotPhoto(i))).toEqual([imageA, imageB, imageA])
    expect([...env.selectedSlots]).toEqual([0, 1, 2])
    expect(revoked).toEqual([])
  })

  it('keeps photos across a text template without filling or deleting text content', () => {
    const { env, feature, images, imageA, imageB, revoked } = setup()
    env.sel.value = 'text'
    feature.loadTemplate()
    expect(env.states).toEqual([{ text: 'A' }, { text: 'B' }])
    expect([...env.selectedSlots]).toEqual([0, 1])
    env.sel.value = 'heart'
    feature.loadTemplate()
    images.at(-1).onload()
    expect([0, 1, 2].map(i => feature.slotPhoto(i))).toEqual([imageA, imageB, imageA])
    expect(revoked).toEqual([])
  })

  it('retains partial replacements alongside existing photo sources and releases discarded sources', () => {
    const { env, feature, imageA, imageB, images, revoked } = setup()
    const old = { name: 'old' }
    env.photos = [imageA, old]
    env.urls = ['a', 'old']
    env.replacedPhotos = new Map([[1, { image: imageB, url: 'b' }], [3, { image: imageB, url: 'b' }]])
    env.replacementUrls = new Set(['b', 'pending'])
    feature.loadTemplate()
    images[0].onload()
    expect(env.photos).toEqual([imageA, imageB])
    expect(revoked).toEqual(['old', 'pending'])
    expect(env.replacementBusy).toBe(false)
    expect(env.photoUploadTarget).toBeNull()
  })

  it('ignores stale template loads and supports starting without uploaded photos', () => {
    const { env, feature, images } = setup()
    env.replacedPhotos.clear()
    env.replacementUrls.clear()
    feature.loadTemplate()
    env.sel.value = 'heart'
    feature.loadTemplate()
    images[1].onload()
    images[0].onload()
    expect(env.states).toHaveLength(3)
    expect([...env.selectedSlots]).toEqual([0, 1, 2])
    expect(feature.slotPhoto(0)).toBeNull()
  })

  it('selects all saved custom-template patterns and requests all-selection after layout generation', () => {
    const { env, feature, controls } = setup()
    env.CUSTOM_TEMPLATE = 'custom'
    env.templates.custom = { savedStates: [{}, {}, {}], background: {} }
    env.renderCustomRows = () => {}
    const layoutCalls: any[] = []
    env.applyCustomLayout = (all: boolean) => layoutCalls.push(all)
    feature.loadCustomTemplate()
    expect([...env.selectedSlots]).toEqual([0, 1, 2])
    expect(env.multiMode).toBe(true)
    expect(controls.get('multiMode').checked).toBe(true)
    expect(layoutCalls).toEqual([true])
  })

  it('selects every generated custom pattern on entry but preserves manual selection on later layout updates', async () => {
    const { env } = setup()
    env.CUSTOM_TEMPLATE = 'custom'
    env.sel.value = 'custom'
    env.templates.custom = { slots: [], savedStates: [] }
    env.replacedPhotos.clear()
    const layout = { w: 1440, h: 2100, slots: [0, 1, 2, 3].map(key => ({ key })), placements: [] }
    Object.assign(env, {
      buildCustomLayout: () => layout, customRows: [{}], customAssets: {},
      widthInput: { value: '144' }, heightInput: { value: '210' },
      customSummary: { classList: { add() {}, remove() {} } }, download: {},
      releaseUnusedReplacementUrls() {}, loadCustomImage() {},
      motifEditor: { reflow() {} },
    })
    env.document.createElement = () => ({ getContext: () => ({ drawImage() {} }) })
    const source = section('function customInitialState(', 'function loadCustomTemplate(')
    const apply = new Function('env', `with(env){${source};return applyCustomLayout}`)(env)
    await apply(true)
    expect([...env.selectedSlots]).toEqual([0, 1, 2, 3])
    env.selectedSlots = new Set([1])
    await apply()
    expect([...env.selectedSlots]).toEqual([1])
  })
})
