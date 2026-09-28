import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadImageFile } from './assetLoader'

class FakeImage {
  decoding = 'auto'
  naturalWidth = 1200
  naturalHeight = 800
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

describe('loadImageFile', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['photo.jpg', 'photo.jpeg'])('loads JPEG image %s', async (name) => {
    vi.stubGlobal('Image', FakeImage)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:jpeg')

    const asset = await loadImageFile(new File(['jpeg'], name, { type: 'image/jpeg' }), '2cm')

    expect(asset.name).toBe(name)
    expect(asset.mime).toBe('image/jpeg')
    expect(asset.width).toBe(1200)
    expect(asset.height).toBe(800)
  })
})
