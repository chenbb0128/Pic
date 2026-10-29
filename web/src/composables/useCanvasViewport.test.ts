import { computed, createRenderer, markRaw, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useCanvasViewport } from './useCanvasViewport'

const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  parentNode: () => null, nextSibling: () => null,
})

function mountViewport() {
  let view!: ReturnType<typeof useCanvasViewport>
  const paper = ref({ widthMm: 144, heightMm: 213 })
  const app = renderer.createApp({ setup() { view = useCanvasViewport(computed(() => paper.value)); return () => null } })
  app.mount({})
  return { view, paper, cleanup: () => app.unmount() }
}

describe('canvas viewport', () => {
  it('fits portrait and landscape sheets without distortion and only zooms the display', async () => {
    const { view, paper, cleanup } = mountViewport()
    try {
      view.viewport.value = { clientWidth: 900, clientHeight: 600, scrollLeft: 0, scrollTop: 0 } as HTMLElement
      view.measure()
      const original = JSON.stringify(paper.value)
      expect(parseFloat(view.canvasStyle.value.height!)).toBeCloseTo(576, 5)
      expect(parseFloat(view.canvasStyle.value.width!) / parseFloat(view.canvasStyle.value.height!)).toBeCloseTo(144 / 213, 5)
      view.setZoom(2)
      await nextTick()
      expect(parseFloat(view.canvasStyle.value.height!)).toBeCloseTo(1152, 5)
      expect(JSON.stringify(paper.value)).toBe(original)
      view.fit()
      expect(view.zoom.value).toBe(1)
      paper.value = { widthMm: 296, heightMm: 210 }
      await nextTick()
      expect(parseFloat(view.canvasStyle.value.width!) / parseFloat(view.canvasStyle.value.height!)).toBeCloseTo(296 / 210, 5)
      expect(parseFloat(view.canvasStyle.value.width!)).toBeLessThanOrEqual(876)
      expect(parseFloat(view.canvasStyle.value.height!)).toBeLessThanOrEqual(576)
      view.setZoom(99)
      expect(view.zoom.value).toBe(4)
      view.setZoom(-1)
      expect(view.zoom.value).toBe(.5)
      view.setZoom(NaN)
      expect(view.zoom.value).toBe(.5)
    } finally { cleanup() }
  })

  it('expands the workspace when native fullscreen is unavailable and Escape restores it', async () => {
    const { view, cleanup } = mountViewport()
    try {
      view.workspace.value = {} as HTMLElement
      await view.toggleFullscreen()
      expect(view.expanded.value).toBe(true)
      view.onFullscreenKeydown({ key: 'Escape' } as KeyboardEvent)
      expect(view.expanded.value).toBe(false)
    } finally { cleanup() }
  })

  it('follows native fullscreen changes and exits on the second click', async () => {
    const { view, cleanup } = mountViewport()
    const workspace = markRaw({ requestFullscreen: vi.fn(async () => { documentState.fullscreenElement = workspace }) })
    const documentState = { fullscreenElement: null as object | null, exitFullscreen: vi.fn(async () => { documentState.fullscreenElement = null }) }
    vi.stubGlobal('document', documentState)
    try {
      view.workspace.value = workspace as unknown as HTMLElement
      await view.toggleFullscreen()
      expect(workspace.requestFullscreen).toHaveBeenCalledOnce()
      expect(view.expanded.value).toBe(true)
      await view.toggleFullscreen()
      expect(documentState.exitFullscreen).toHaveBeenCalledOnce()
      expect(view.expanded.value).toBe(false)
      view.expanded.value = true
      view.onFullscreenChange()
      expect(view.expanded.value).toBe(false)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })
})
