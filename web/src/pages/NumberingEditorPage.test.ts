import { createRenderer, nextTick, ssrContextKey } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Page from './NumberingEditorPage.vue'
import * as images from '../services/studioImage'
import { createAppRouter } from '../router'

const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  parentNode: () => null, nextSibling: () => null,
})

function mount() {
  const app = renderer.createApp({ ...Page, render: () => null })
  app.provide(ssrContextKey, {})
  const vm = app.mount({})
  const state = (vm.$ as unknown as { setupState: Record<string, any> }).setupState
  return { state, cleanup: () => app.unmount() }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('修改排版编号页面', () => {
  it('可从工具路由进入，默认下方 3mm，上传读取 DPI，缺失时要求填写', async () => {
    expect(createAppRouter(createMemoryHistory()).resolve('/tools/renumber').name).toBe('renumber')
    const { state, cleanup } = mount()
    const load = vi.spyOn(images, 'loadLocalImage')
    load.mockResolvedValue({ id: 'one', name: 'old.png', url: 'blob:one', width: 1440, height: 2130, image: {} as HTMLImageElement, sourceDpi: 254 })
    try {
      expect(state.side).toBe('bottom')
      expect(state.stripMm).toBe(3)
      await state.onFileChange({ target: { files: [{}], value: 'old.png' } })
      expect(state.dpi).toBe(254)
      expect(state.validation).toBe('')
      load.mockResolvedValue({ id: 'two', name: 'other.jpg', url: 'blob:two', width: 1440, height: 2130, image: {} as HTMLImageElement })
      await state.onFileChange({ target: { files: [{}], value: 'other.jpg' } })
      expect(state.dpi).toBe('')
      expect(state.validation).toContain('DPI')
    } finally { cleanup() }
  })

  it('阻止空编号和无效区域，下载保留原像素和 DPI，并采用现有日期前缀和张数格式', async () => {
    const context = { save() {}, restore() {}, scale() {}, drawImage: vi.fn(), clearRect: vi.fn(),
      beginPath() {}, rect() {}, clip() {}, translate() {}, rotate() {}, measureText: () => ({ width: 50 }), fillText: vi.fn() }
    const canvas = { width: 0, height: 0, getContext: () => context }
    vi.stubGlobal('document', { createElement: () => canvas, fonts: { ready: Promise.resolve() } })
    const encode = vi.spyOn(images, 'canvasPng').mockImplementation(async (output, dpi) => {
      expect([output.width, output.height, dpi]).toEqual([1440, 2130, 254])
      return new Blob(['png'], { type: 'image/png' })
    })
    const download = vi.spyOn(images, 'downloadBlob').mockImplementation(() => {})
    const { state, cleanup } = mount()
    try {
      state.image = { id: 'one', name: 'old.png', url: 'blob:one', width: 1440, height: 2130, image: {} }
      state.dpi = 254
      await nextTick()
      await state.exportPng()
      expect(state.status).toContain('填写新编号')
      expect(encode).not.toHaveBeenCalled()
      state.number = '0125'
      state.prefix = 'yy'
      state.sheetTotal = 3
      state.sheetIndex = 2
      state.stripMm = 999
      await nextTick()
      await state.exportPng()
      expect(encode).not.toHaveBeenCalled()
      state.stripMm = 3
      await nextTick()
      await state.exportPng()
      expect(encode).toHaveBeenCalledOnce()
      expect(context.clearRect).toHaveBeenCalledWith(0, 2100, 1440, 30)
      expect(context.fillText.mock.calls[0][0]).toMatch(/^yy-\d{8}-0125 共3张·第2张$/)
      expect(download).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^yy-\d{8}-0125 共3张·第2张_修改编号.png$/))
      state.number = '0126'
      await nextTick()
      expect(state.generated).toBeNull()
    } finally { cleanup() }
  })
})
