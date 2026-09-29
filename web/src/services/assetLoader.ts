import type { AssetRecord } from '../domain/assets/types'
import type { StickerType } from '../domain/layout/types'

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/webp', 'image/jpeg'] as const

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `asset-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve()
      void decoded
        .then(() => resolve(image))
        .catch(() => reject(new Error('图片解码失败，请尝试重新选择素材。')))
    }
    image.onerror = () => reject(new Error('图片无法读取，请确认文件没有损坏。'))
    image.src = url
  })
}

export async function loadImageFile(file: File, type: StickerType): Promise<AssetRecord> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
    throw new Error(`${file.name} 不是 PNG、WebP、JPG 或 JPEG 图片。`)
  }

  const url = URL.createObjectURL(file)
  try {
    const image = await decodeImage(url)
    return {
      id: makeId(),
      name: file.name,
      type,
      mime: file.type as AssetRecord['mime'],
      width: image.naturalWidth,
      height: image.naturalHeight,
      url,
      image,
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

export function releaseImage(asset: Pick<AssetRecord, 'url'>): void {
  URL.revokeObjectURL(asset.url)
}
