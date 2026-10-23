import { describe, expect, it } from 'vitest'
import source from '../../public/embedded/heart-star/cloud-snapshot.js?raw'

function setup() {
  const scope: any = {}
  new Function('globalThis', source)(scope)
  const files: any[] = []
  const codec = scope.HeartStarCloudSnapshot.create({
    isImage: (v: any) => v?.isImage === true,
    upload: async (image: any) => { files.push(image); return { fileId: (files.length + '').padStart(32, '0') } },
    loadImage: async (id: string) => ({ isImage: true, restoredId: id }),
  })
  const photo = { isImage: true, name: 'customer' }, base = { isImage: true, name: 'artwork' }
  const state = { size: .62, dx: 6, dy: -8, imageScale: 1.4,
    background: { type: 'image', image: base, scale: 2, dx: 20, dy: -4 },
    motif: { assetId: 'mint-star', image: base, frame: { x: 40, y: 50, w: 20, h: 30 } } }
  const input = { template: { w: 200, h: 300, slots: [{ x: 40, y: 50, w: 20, h: 30 }], image: base },
    states: [state], photos: [photo], settings: { dpi: 600, width: 144, height: 210, footerText: 'ABC', numberingEnabled: true },
    customRows: [{ groups: [{ assetId: 'mint-star', count: 1 }] }] }
  return { codec, input, files, photo, base }
}

describe('shared heart-star snapshots', () => {
  it('saves immutable file references once per image and preserves all layout values', async () => {
    const s = setup()
    const promise = s.codec.capture(s.input, 'project')
    s.input.states[0]!.dx = 99
    const snapshot = await promise
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.states[0].dx).toBe(6)
    expect(snapshot.settings).toMatchObject({ dpi: 600, footerText: 'ABC', numberingEnabled: true })
    expect(snapshot.states[0].background).toMatchObject({ scale: 2, dx: 20, dy: -4 })
    expect(snapshot.photos[0]).toEqual({ fileId: '00000000000000000000000000000002' })
    expect(s.files.map(f => f.name)).toEqual(['artwork', 'customer'])
    expect(JSON.stringify(snapshot)).not.toContain('isImage')
  })

  it('template saving never uploads or retains customer photos but keeps custom backgrounds', async () => {
    const s = setup(), snapshot = await s.codec.capture(s.input, 'template')
    expect(snapshot.photos).toEqual([null])
    expect(s.files).toEqual([s.base])
    expect(snapshot.states[0].background.image).toEqual({ fileId: '00000000000000000000000000000001' })
  })

  it('restores images, motif frames and transforms without computing a new layout', async () => {
    const s = setup(), snapshot = await s.codec.capture(s.input, 'project')
    const restored = await s.codec.restore(snapshot)
    expect(restored.states[0]).toMatchObject({ size: .62, dx: 6, dy: -8, imageScale: 1.4,
      motif: { assetId: 'mint-star', frame: { x: 40, y: 50, w: 20, h: 30 } } })
    expect(restored.photos[0].restoredId).toBe('00000000000000000000000000000002')
    expect(restored.template.image).toBe(restored.states[0].background.image)
  })

  it('rejects a bad file reference before requesting images', async () => {
    const s = setup(), snapshot = await s.codec.capture(s.input, 'project')
    snapshot.photos[0].fileId = '../../private'
    await expect(s.codec.restore(snapshot)).rejects.toThrow()
  })

  it('retries an image upload after a failed save instead of caching the failure', async () => {
    const s = setup(), scope: any = {}; new Function('globalThis', source)(scope)
    let failed = false
    const codec = scope.HeartStarCloudSnapshot.create({ isImage: (v: any) => v?.isImage,
      upload: async () => { if (!failed) { failed = true; throw Error('offline') }; return { fileId: '00000000000000000000000000000001' } } })
    await expect(codec.capture(s.input, 'template')).rejects.toThrow('offline')
    await expect(codec.capture(s.input, 'template')).resolves.toMatchObject({ photos: [null] })
  })
})
