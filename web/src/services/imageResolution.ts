// Print density only: unitless pixel aspect ratios do not establish a physical size.
function textAt(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length))
}

function validDpi(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

function exifDpi(source: Uint8Array): number | undefined {
  const data = textAt(source, 0, 6) === 'Exif\0\0' ? source.subarray(6) : source
  if (data.length < 8) return
  const byteOrder = textAt(data, 0, 2)
  if (byteOrder !== 'II' && byteOrder !== 'MM') return
  const little = byteOrder === 'II'
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint16(2, little) !== 42) return
  const ifd = view.getUint32(4, little)
  if (ifd < 8 || ifd + 2 > data.length) return
  const count = view.getUint16(ifd, little)
  if (ifd + 2 + count * 12 > data.length) return
  let resolution: number | undefined
  let unit = 2 // TIFF's default resolution unit is inches.
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12
    const tag = view.getUint16(entry, little)
    const type = view.getUint16(entry + 2, little)
    if (view.getUint32(entry + 4, little) !== 1) continue
    if (tag === 0x128 && type === 3) unit = view.getUint16(entry + 8, little)
    if ((tag === 0x11a || tag === 0x11b) && type === 5) {
      const offset = view.getUint32(entry + 8, little)
      if (offset + 8 > data.length) continue
      const denominator = view.getUint32(offset + 4, little)
      const value = denominator ? validDpi(view.getUint32(offset, little) / denominator) : undefined
      if (value && (tag === 0x11a || resolution === undefined)) resolution = value
    }
  }
  return validDpi(unit === 2 ? resolution : unit === 3 && resolution ? resolution * 2.54 : undefined)
}

export function readImageDpi(buffer: ArrayBuffer): number | undefined {
  const data = new Uint8Array(buffer)
  const view = new DataView(buffer)
  if (data.length >= 8 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = view.getUint32(offset)
      const end = offset + 12 + length
      if (end > data.length) return
      const type = textAt(data, offset + 4, 4)
      if (type === 'pHYs' && length === 9 && data[offset + 16] === 1) {
        const pixelsPerMeter = view.getUint32(offset + 8) || view.getUint32(offset + 12)
        const dpi = validDpi(pixelsPerMeter * 0.0254)
        if (dpi) return dpi
      }
      if (type === 'eXIf') {
        const dpi = exifDpi(data.subarray(offset + 8, end - 4))
        if (dpi) return dpi
      }
      offset = end
    }
  } else if (data.length >= 2 && data[0] === 255 && data[1] === 216) {
    let jfifDpi: number | undefined
    for (let offset = 2; offset + 4 <= data.length;) {
      if (data[offset] !== 255) break
      while (data[offset + 1] === 255) offset += 1
      const marker = data[offset + 1]
      if (marker === 0xda || marker === 0xd9 || offset + 4 > data.length) break
      const length = view.getUint16(offset + 2)
      const start = offset + 4
      const end = offset + 2 + length
      if (length < 2 || end > data.length) break
      if (marker === 0xe1 && textAt(data, start, 6) === 'Exif\0\0') {
        const dpi = exifDpi(data.subarray(start, end))
        if (dpi) return dpi
      }
      if (marker === 0xe0 && length >= 16 && textAt(data, start, 5) === 'JFIF\0') {
        const unit = data[start + 7]
        const density = view.getUint16(start + 8) || view.getUint16(start + 10)
        jfifDpi = validDpi(unit === 1 ? density : unit === 2 ? density * 2.54 : undefined)
      }
      offset = end
    }
    return jfifDpi
  } else if (data.length >= 12 && textAt(data, 0, 4) === 'RIFF' && textAt(data, 8, 4) === 'WEBP') {
    const limit = Math.min(data.length, view.getUint32(4, true) + 8)
    for (let offset = 12; offset + 8 <= limit;) {
      const length = view.getUint32(offset + 4, true)
      const end = offset + 8 + length
      if (end > limit) return
      if (textAt(data, offset, 4) === 'EXIF') return exifDpi(data.subarray(offset + 8, end))
      offset = end + length % 2
    }
  }
}
