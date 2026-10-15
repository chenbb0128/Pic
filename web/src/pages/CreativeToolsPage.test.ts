import { createRenderer, nextTick, ssrContextKey } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Page from './CreativeToolsPage.vue'
import * as fonts from '../services/creativeFonts'
import * as creative from '../services/creativeCanvas'
import * as images from '../services/studioImage'

vi.mock('vue-router', () => ({ useRoute: () => ({ params: { kind: 'name' } }) }))
const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  parentNode: () => null, nextSibling: () => null,
})
function mountPage() {
  const app = renderer.createApp({ ...Page, render: () => null })
  app.provide(ssrContextKey, {})
  const vm = app.mount({})
  return { state: (vm.$ as unknown as { setupState: Record<string, any> }).setupState, cleanup: () => app.unmount() }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('creative page font loading', () => {
  it('does not draw a stale font after switching quickly', async () => {
    const { state, cleanup } = mountPage()
    let finish!: () => void
    vi.spyOn(fonts, 'ensureCreativeFont').mockImplementation(value => value === fonts.creativeFonts[0]!.value
      ? new Promise<void>(resolve => { finish = resolve }) : Promise.resolve())
    const drawn: string[] = []
    vi.spyOn(creative, 'renderCreative').mockImplementation((_canvas, settings) => { drawn.push(settings.font); return 1 })
    try {
      state.font = fonts.creativeFonts[0]!.value
      await nextTick()
      state.preview = { width: 900, height: 600 }
      const old = state.renderPreview()
      state.font = 'Georgia, serif'
      await nextTick()
      await state.renderPreview()
      finish()
      await old
      expect(drawn.length).toBeGreaterThan(0)
      expect(drawn.every(value => value === 'Georgia, serif')).toBe(true)
    } finally { cleanup() }
  })

  it('waits for the selected font before PNG export', async () => {
    const { state, cleanup } = mountPage()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    vi.spyOn(fonts, 'ensureCreativeFont').mockReturnValue(pending)
    const rendered = vi.spyOn(creative, 'renderCreative').mockReturnValue(1)
    const encoded = vi.spyOn(images, 'canvasPng').mockResolvedValue(new Blob(['png']))
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    try {
      state.font = fonts.creativeFonts[0]!.value
      const result = state.exportPng()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(encoded).not.toHaveBeenCalled()
      expect(rendered).not.toHaveBeenCalled()
      finish()
      await result
      expect(state.generated?.url).toMatch(/^blob:/)
      expect(rendered.mock.calls[0]![1].font).toBe(fonts.creativeFonts[0]!.value)
    } finally { cleanup() }
  })

  it('blocks export with a visible error when the selected font fails', async () => {
    const { state, cleanup } = mountPage()
    vi.spyOn(fonts, 'ensureCreativeFont').mockRejectedValue(new Error('字体加载失败，请重试。'))
    const encoded = vi.spyOn(images, 'canvasPng')
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    try {
      state.font = fonts.creativeFonts[0]!.value
      await state.exportPng()
      expect(state.status).toContain('字体加载失败')
      expect(state.generated).toBeNull()
      expect(encoded).not.toHaveBeenCalled()
      expect(state.exporting).toBe(false)
    } finally { cleanup() }
  })
})
