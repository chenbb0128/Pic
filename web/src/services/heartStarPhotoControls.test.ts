import { describe, expect, it } from 'vitest'
import html from '../../public/embedded/heart-star/index.html?raw'

function setup() {
  const controls = new Map<string, any>()
  const element = (id: string) => {
    if (!controls.has(id)) controls.set(id, { value: '', textContent: '', style: { setProperty() {} }, setAttribute() {} })
    return controls.get(id)
  }
  const env: any = { templates: { test: { w: 1440, h: 2100, slots: [{ w: 120, h: 130 }, { w: 150, h: 160 }] } }, sel: { value: 'test' },
    selectedSlots: new Set([0]), states: [{ size: .62, imageScale: .95, imageDx: 0, imageDy: 0 }, { size: .62, imageScale: 1.2, imageDx: 12, imageDy: -8 }],
    slotPhoto: () => ({}), hasSlotPhotos: () => true, replacementBusy: false, photoUploadBusy: false, exportBusy: false,
    photoDrag: null, finishPhotoDrag() {}, draw() {}, requestPhotoDraw() {}, canvas: { style: {} },
    document: { getElementById: element, querySelectorAll: () => [] }, replacePhoto: element('replacePhoto'),
    photoScale: element('photoScale'), photoScaleNumber: element('photoScaleNumber'), photoOffsetX: element('photoOffsetX'), photoOffsetY: element('photoOffsetY'), photoDragMode: element('photoDragMode') }
  const start = html.indexOf('function canEditPhoto('), source = html.slice(start, html.indexOf('function slotFrame(', start))
  const feature = new Function('env', `with(env){${source};return {updatePhotoControls,setPhotoScale,setPhotoOffset,resetSelectedPhoto}}`)(env)
  return { env, feature, element }
}

describe('heart-star portrait fine tuning', () => {
  it('shows centered position sliders and updates only selected photos without moving artwork', () => {
    const { env, feature, element } = setup(), untouched = structuredClone(env.states[1])
    feature.updatePhotoControls()
    expect(element('photoScaleOut').value).toBe('95%')
    expect(element('photoOffsetXOut').value).toBe('居中')
    expect(element('photoOffsetYOut').value).toBe('居中')
    feature.setPhotoOffset('y', -24)
    feature.setPhotoScale(110)
    expect(env.states[0]).toMatchObject({ imageDy: -24, imageScale: 1.1, size: .62 })
    expect(env.states[1]).toEqual(untouched)
    expect(element('photoOffsetYOut').value).toBe('上 24 px')
  })

  it('shows mixed selections and resets only the selected portraits', () => {
    const { env, feature, element } = setup()
    env.selectedSlots = new Set([0, 1]); feature.updatePhotoControls()
    expect(element('photoScaleOut').value).toBe('混合')
    expect(element('photoOffsetXOut').value).toBe('混合')
    env.selectedSlots = new Set([1]); feature.resetSelectedPhoto()
    expect(env.states[1]).toMatchObject({ imageScale: 1, imageDx: 0, imageDy: 0 })
    expect(env.states[0].imageScale).toBe(.95)
    expect(element('photoOffsetYOut').value).toBe('居中')
  })

  it('keeps saved large offsets representable without clamping them while displaying the panel', () => {
    const { env, feature, element } = setup()
    env.states[0].imageDx = 700; env.states[0].imageDy = -800; feature.updatePhotoControls()
    expect(Number(element('photoOffsetX').max)).toBeGreaterThanOrEqual(700)
    expect(Number(element('photoOffsetY').min)).toBeLessThanOrEqual(-800)
    expect(element('photoOffsetXOut').value).toBe('右 700 px')
    expect(env.states[0].imageDy).toBe(-800)
  })

  it('disables the sliders and clears readouts when there is no selected photo', () => {
    const { env, feature, element } = setup()
    env.selectedSlots.clear(); feature.updatePhotoControls()
    expect(element('photoOffsetX').disabled).toBe(true)
    expect(element('photoScale').disabled).toBe(true)
    expect(element('photoOffsetXOut').value).toBe('—')
    expect(element('photoOffsetYOut').value).toBe('—')
  })
})
