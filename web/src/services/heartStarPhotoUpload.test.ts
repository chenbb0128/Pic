import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function setup(ids: number[]) {
  const old = { image: { name: 'old' }, url: 'old-url' }
  const states = Array.from({ length: 4 }, () => ({ imageScale: 2, imageDx: 7 }))
  const images: any[] = [], messages: string[] = [], revoked: string[] = []
  const controls: Record<string, any> = {}
  const control = (id: string) => controls[id] ||= { value: '', textContent: '', disabled: false }
  const env: any = {
    states, selectedSlots: new Set(ids), sel: { value: 'heart' }, templates: { heart: {} },
    replacedPhotos: new Map(Array.from({ length: 4 }, (_, i) => [i, old])),
    replacementUrls: new Set(['old-url']), replacementRequest: 0, replacementBusy: false,
    photoUploadRequest: 0, photoUploadBusy: false, photoUploadTarget: null, photos: [], urls: [], ignorePhotoClick: false,
    exportBusy: false, replacementTarget: null, replacePhotoFile: { value: '' }, filesEl: { value: '' },
    clip: { checked: false }, HeartStarBackground: { photoOnly: (state: any) => ['transparent', 'outline'].includes(state?.background?.type) },
    selectedSlot: ids[0] ?? 0, multiMode: ids.length > 1, updateCopyEditor() {},
    document: { getElementById: control, querySelectorAll: () => [] },
    slotSelect: control('slotSelect'), scale: control('scale'), sizeNumber: control('sizeNumber'), clipShape: control('clipShape'),
    Image: class { constructor() { images.push(this) } },
    URL: { createObjectURL: (file: any) => `url-${file.name}`, revokeObjectURL: (url: string) => revoked.push(url) },
    selectedPhotoTarget: () => ({ template: env.sel.value, states: env.states,
      request: env.replacementRequest, ids: [...env.selectedSlots].sort((a: any, b: any) => a - b) }),
    clearReplacedPhotos: () => { env.replacedPhotos.clear() },
    finishPhotoDrag() {}, updatePhotoControls() {}, draw() {}, renderThumbs() {},
    currentSlots: () => states,
    say: (message: string) => messages.push(message),
  }
  const source = toolHtml.slice(toolHtml.indexOf('function slotPhoto('), toolHtml.indexOf('function hasSlotPhotos(')) +
    toolHtml.slice(toolHtml.indexOf('function releaseUnusedReplacementUrls('), toolHtml.indexOf('function selectedPhotoTarget(')) +
    toolHtml.slice(toolHtml.indexOf('function setFiles('), toolHtml.indexOf('function renderThumbs(')) +
    toolHtml.slice(toolHtml.indexOf('function updateControls('), toolHtml.indexOf('function setSelectedSize('))
  const feature = new Function('env', `with(env){${source};return {upload:setFiles,slotPhoto,
    updateControls,applySolid:typeof applySolidPhotos==='function'?applySolidPhotos:null,
    remove:typeof removeSelectedPhotos==='function'?removeSelectedPhotos:null}}`)(env)
  const file = (name: string) => ({ name, type: 'image/png' })
  return { env, states, old, images, messages, revoked, controls, ...feature, file }
}

describe('heart-star selected photo upload', () => {
  it('persists the processed badge only after applying and clears it when restoring, uploading, or deleting', () => {
    const s = setup([1]), result = { name: 'transparent' }
    s.applySolid([{ id: 1, image: result, processed: true }])
    expect(s.states[1]).toHaveProperty('photoBackgroundRemoved', true)
    s.applySolid([{ id: 1, image: s.old.image, processed: false }])
    expect(s.states[1]).not.toHaveProperty('photoBackgroundRemoved')
    s.applySolid([{ id: 1, image: result, processed: true }])
    s.upload([s.file('new')]); s.images[0].onload()
    expect(s.states[1]).not.toHaveProperty('photoBackgroundRemoved')
    s.applySolid([{ id: 1, image: result, processed: true }])
    s.remove()
    expect(s.states[1]).not.toHaveProperty('photoBackgroundRemoved')
  })

  it('applies background-removed photos without resetting transforms, motifs, or unselected photos', () => {
    const s = setup([1])
    Object.assign(s.states[1]!, { size: .7, dx: 8, imageDy: -4, motif: { assetId: 'heart' }, background: { type: 'outline' } })
    const states = structuredClone(s.states), result = { name: 'transparent-result' }
    expect(s.applySolid).toBeTypeOf('function')
    s.applySolid([{ id: 1, image: result }])
    expect(s.slotPhoto(1)).toBe(result)
    expect([0, 2, 3].map(i => s.slotPhoto(i))).toEqual([s.old.image, s.old.image, s.old.image])
    expect(s.states).toEqual(states)
  })
  it('automatically resets only uploaded positions to the preset uncropped photo area', () => {
    const s = setup([1])
    Object.assign(s.states[1]!, { size: 1.2, dx: 30, dy: -20, imageDy: 12, background: { type: 'color', color: '#ffccdd' } })
    const before = structuredClone(s.states)
    s.upload([s.file('fit')])
    s.images[0].onload()
    expect(s.states[1]).toMatchObject({ size: .62, dx: 0, dy: 0, imageScale: 1, imageDx: 0, imageDy: 0,
      background: { type: 'color', color: '#ffccdd' } })
    expect(s.states[0]).toEqual(before[0])
    expect(s.states.slice(2)).toEqual(before.slice(2))
  })

  it('refreshes the placement size and offset controls after auto-fitting an uploaded photo', () => {
    const s = setup([1])
    Object.assign(s.states[1]!, { size: 1.2, dx: 30, dy: -20 })
    s.updateControls()
    expect(s.controls.sizeNumber.value).toBe('120')
    s.upload([s.file('fit')])
    s.images[0].onload()
    expect(s.controls.sizeNumber.value).toBe('62')
    expect(s.controls.offsetReadout.textContent).toBe('X 0 px　Y 0 px')
  })

  it.each(['transparent', 'outline', 'cropped'])('keeps the existing transforms in the separate %s mode', type => {
    const s = setup([1])
    if (type === 'cropped') s.env.clip.checked = true
    else Object.assign(s.states[1]!, { background: { type } })
    const before = structuredClone(s.states)
    s.upload([s.file('unchanged')])
    s.images[0].onload()
    expect(s.states).toEqual(before)
  })

  it('replaces only selected positions without resetting other photos or transforms', () => {
    const s = setup([1])
    s.upload([s.file('a')])
    s.images[0].onload()
    expect(s.env.replacedPhotos.get(1)?.image).toBe(s.images[0])
    expect([0, 2, 3].map(i => s.env.replacedPhotos.get(i))).toEqual([s.old, s.old, s.old])
    expect(s.states[0]).toEqual({ imageScale: 2, imageDx: 7 })
  })

  it('assigns multiple files in board order, regardless of selection order', () => {
    const s = setup([3, 1])
    s.upload([s.file('a'), s.file('b')])
    s.images[1].onload()
    s.images[0].onload()
    expect(s.env.replacedPhotos.get(1)?.image).toBe(s.images[0])
    expect(s.env.replacedPhotos.get(3)?.image).toBe(s.images[1])
    expect(s.env.replacedPhotos.get(0)).toBe(s.old)
  })

  it('repeats files across all positions only when all positions are selected', () => {
    const s = setup([0, 1, 2, 3])
    s.upload([s.file('a'), s.file('b')])
    s.images.forEach(image => image.onload())
    expect([0, 1, 2, 3].map(i => s.env.replacedPhotos.get(i)?.image))
      .toEqual([s.images[0], s.images[1], s.images[0], s.images[1]])
  })

  it('reports an empty selection without reading files or changing the board', () => {
    const s = setup([])
    s.upload([s.file('a')])
    expect(s.images).toHaveLength(0)
    expect(s.messages.join('')).toContain('先选择')
    expect(s.env.replacedPhotos.get(0)).toBe(s.old)
  })

  it('keeps the original selection during loading and preserves old photos on read failure', () => {
    const s = setup([1])
    s.upload([s.file('a')])
    s.env.selectedSlots = new Set([0, 1, 2, 3])
    s.images[0].onerror()
    expect([...s.env.replacedPhotos.values()]).toEqual([s.old, s.old, s.old, s.old])
    expect(s.revoked).toContain('url-a')
  })

  it('does not expand the target selection while images are loading', () => {
    const s = setup([1])
    s.upload([s.file('a')])
    s.env.selectedSlots = new Set([0, 1, 2, 3])
    s.images[0].onload()
    expect(s.env.replacedPhotos.get(1)?.image).toBe(s.images[0])
    expect([0, 2, 3].map(i => s.env.replacedPhotos.get(i))).toEqual([s.old, s.old, s.old])
  })

  it('removes only selected photos and preserves the motif, background, and transforms', () => {
    const s = setup([1])
    Object.assign(s.states[1]!, { motif: { id: 'heart' }, background: { type: 'color', color: '#ffccdd' } })
    const before = structuredClone(s.states)
    expect(s.remove).toBeTypeOf('function')
    s.remove()
    expect(s.slotPhoto(1)).toBeNull()
    expect([0, 2, 3].map(i => s.slotPhoto(i))).toEqual([s.old.image, s.old.image, s.old.image])
    expect(s.states).toEqual(before)
    expect(s.revoked).toEqual([])
  })

  it('does not fall back to an old source after deletion and supports uploading again', () => {
    const s = setup([1])
    s.env.replacedPhotos.clear()
    s.env.photos = [s.old.image]
    s.env.urls = ['old-url']
    s.env.replacementUrls.clear()
    expect(s.remove).toBeTypeOf('function')
    s.remove()
    expect(s.slotPhoto(1)).toBeNull()
    expect(s.slotPhoto(0)).toBe(s.old.image)
    s.upload([s.file('new')])
    s.images[0].onload()
    expect(s.slotPhoto(1)).toBe(s.images[0])
  })

  it('releases a shared replacement source only after its last photo is removed', () => {
    const s = setup([0, 1, 2])
    expect(s.remove).toBeTypeOf('function')
    s.remove()
    expect(s.revoked).toEqual([])
    s.env.selectedSlots = new Set([3])
    s.remove()
    expect(s.revoked).toEqual(['old-url'])
    expect(s.env.replacementUrls.size).toBe(0)
  })

  it('ignores a file picker opened before the selected photos were deleted', () => {
    const s = setup([1])
    const target = s.env.selectedPhotoTarget()
    s.remove()
    s.upload([s.file('stale')], target)
    expect(s.images).toHaveLength(0)
    expect(s.slotPhoto(1)).toBeNull()
  })

  it.each(['text', 'exportBusy', 'replacementBusy', 'photoUploadBusy', 'empty'])('does not delete while unavailable: %s', reason => {
    const s = setup([1])
    if (reason === 'text') s.env.templates.heart.text = true
    else if (reason === 'empty') s.env.selectedSlots.clear()
    else s.env[reason] = true
    expect(s.remove).toBeTypeOf('function')
    s.remove()
    expect(s.slotPhoto(1)).toBe(s.old.image)
    expect(s.revoked).toEqual([])
  })
})
