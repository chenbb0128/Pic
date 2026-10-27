import { describe, expect, it } from 'vitest'
import toolHtml from '../../public/embedded/heart-star/index.html?raw'

function setup() {
  const env: any = {
    previewScale: 1, previewZoom: { value: '1' }, zoomOut: { disabled: true },
    zoomLevels: [1, 1.25, 1.5, 2, 3, 4],
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 300 }) },
    stage: { clientWidth: 400, clientHeight: 600, scrollLeft: 0, scrollTop: 0,
      getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    resizePreview() {},
  }
  const source = toolHtml.slice(toolHtml.indexOf('function setPreviewScale('), toolHtml.indexOf("previewZoom.addEventListener('change'"))
  const setScale = new Function('env', `with(env){${source};return setPreviewScale}`)(env)
  return { env, setScale }
}

describe('simplified heart-star preview toolbar', () => {
  it('supports every dropdown zoom level without a zoom-in or full-screen button', () => {
    const { env, setScale } = setup()
    for (const scale of [1.25, 1.5, 2, 3, 4]) {
      setScale(scale)
      expect(env.previewScale).toBe(scale)
      expect(env.previewZoom.value).toBe(String(scale))
      expect(env.zoomOut.disabled).toBe(false)
    }
  })

  it('resets to fitted view and clears scroll offsets for 100% or an unsupported zoom', () => {
    const { env, setScale } = setup()
    for (const scale of [1, 100]) {
      env.stage.scrollLeft = 70; env.stage.scrollTop = 90
      setScale(scale)
      expect(env.previewScale).toBe(1)
      expect(env.zoomOut.disabled).toBe(true)
      expect([env.stage.scrollLeft, env.stage.scrollTop]).toEqual([0, 0])
    }
  })
})
