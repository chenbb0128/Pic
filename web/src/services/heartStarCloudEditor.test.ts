import { describe, expect, it } from 'vitest'
import source from '../../public/embedded/heart-star/cloud-editor.js?raw'

function feature() { const scope: any = {}; new Function('globalThis', source)(scope); return scope.HeartStarCloudEditor }
describe('heart-star cloud editor bridge', () => {
  it('captures measured motif catalog and template dimensions without renderer caches', () => {
    const image = { naturalWidth: 200, naturalHeight: 300 }, editor = feature()
    const raw = editor.capture({ name: '模板爱心.png', cfg: { w: 200, h: 300, slots: [{ x: 40, y: 50, w: 20, h: 20, type: 'heart' }], savedStates: ['old'], background: 'cache', photoTypes: ['heart'] },
      base: image, states: [{ size: .62 }], photoAt: () => null, catalog: [{ index: 0, box: [0, 0, 20, 20], variant: '小款' }], settings: { dpi: 600 } })
    expect(raw.template).toMatchObject({ w: 200, h: 300, image, motifSlots: [{ box: [0, 0, 20, 20] }], photoTypes: ['heart'] })
    expect(raw.template).not.toHaveProperty('savedStates')
    expect(raw.template).not.toHaveProperty('background')
    expect(raw.photos).toEqual([null])
  })

  it('validates restored data before it can clear the current editor', () => {
    const editor = feature(), data = { template: { w: 200, h: 300, slots: [{ x: 40, y: 50, w: 20, h: 20 }], image: { naturalWidth: 200, naturalHeight: 300 } },
      states: [{ size: .62, dx: 0, dy: 0 }], photos: [null], settings: { width: 144, height: 210, dpi: 600 } }
    expect(() => editor.validate(data, {})).not.toThrow()
    expect(() => editor.validate({ ...data, states: [{ motif: { assetId: 'missing' } }] }, {})).toThrow()
    expect(() => editor.validate({ ...data, settings: { width: 1e9, height: 210, dpi: 600 } }, {})).toThrow()
    expect(() => editor.validate({ ...data, template: { ...data.template, image: null } }, {})).toThrow()
  })
})
