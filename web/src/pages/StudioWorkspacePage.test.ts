import { createRenderer, createSSRApp, nextTick, ssrContextKey } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it, vi } from 'vitest'
import Workspace from './StudioWorkspacePage.vue'

// Exercise the actual page handlers without rendering a browser canvas.
const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  parentNode: () => null, nextSibling: () => null,
})

describe('overflow artboards', () => {
  function mountWorkspace() {
    const app = renderer.createApp({ ...Workspace, render: () => null })
    app.provide(ssrContextKey, {})
    const vm = app.mount({})
    const state = (vm.$ as unknown as { setupState: Record<string, any> }).setupState
    state.useContours = false
    state.preset = 'custom'
    state.customWidth = 108
    state.customHeight = 108
    state.gapXmm = 0
    state.gapYmm = 0
    const asset = (id: string, quantity: number, widthMm = 50) => ({
      id, name: id, url: `blob:${id}`, image: {}, width: 100, height: 100,
      widthMm, heightMm: widthMm, quantity, selected: true,
      important: true, ratioLocked: true, rotationDeg: 0,
    })
    return { state, asset, cleanup: () => { state.assets = []; state.boards = []; app.unmount() } }
  }

  it('shows saved locked boards and the latest active layout without changing editor state', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.assets = [asset('one', 5)]
      await nextTick()
      state.lockSelected()
      state.createRemainingBoard()
      await nextTick()
      state.customWidth = 60
      state.customHeight = 100
      state.orientation = 'portrait'
      state.manualPlacements = [{ itemId: 'one', xMm: 7, yMm: 8, widthMm: 30, heightMm: 30 }]
      await nextTick()
      state.generated = { url: 'blob:export', name: 'export.png', size: 10 }
      state.overviewOpen = true
      const summary = state.overviewBoards
      expect(summary).toHaveLength(2)
      expect(summary[0].placements).toHaveLength(4)
      expect(summary[1].paper).toEqual({ widthMm: 60, heightMm: 100 })
      expect(summary[1].placements).toEqual([{ itemId: 'one', xMm: 7, yMm: 8, widthMm: 30, heightMm: 30 }])
      await nextTick()
      expect(state.activeBoardIndex).toBe(1)
      expect(state.generated?.url).toBe('blob:export')
      state.editOverviewBoard(0)
      await nextTick()
      expect(state.overviewOpen).toBe(false)
      expect(state.activeBoardIndex).toBe(0)
      expect(state.groups).toHaveLength(1)
      expect(state.placements).toHaveLength(4)
      state.overviewOpen = true
      state.editOverviewBoard(0)
      expect(state.overviewOpen).toBe(false)
    } finally { cleanup() }
  })

  it('draws each thumbnail using its own paper, image and placement geometry', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.assets = [{ ...asset('one', 5), ratioLocked: false }]
      await nextTick()
      state.createRemainingBoard()
      await nextTick()
      state.customWidth = 60
      state.customHeight = 100
      state.orientation = 'portrait'
      state.manualPlacements = [{ itemId: 'one', xMm: 7, yMm: 8, widthMm: 30, heightMm: 30 }]
      state.overviewOpen = true
      const context = { clearRect() {}, save() {}, restore() {}, rotate() {}, translate: vi.fn(), drawImage: vi.fn() }
      const canvas = { width: 0, height: 0, getContext: () => context }
      state.setOverviewCanvas(0, canvas)
      expect([canvas.width, canvas.height]).toEqual([400, 400])
      expect(context.drawImage).toHaveBeenCalledTimes(4)
      context.drawImage.mockClear()
      state.setOverviewCanvas(1, canvas)
      expect([canvas.width, canvas.height]).toEqual([240, 400])
      expect(context.translate).toHaveBeenLastCalledWith(88, 92)
      expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(state.assets[0].image, -60, -60, 120, 120)
    } finally { cleanup() }
  })

  it('normalizes gap input to whole millimeters before rearranging', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.assets = [asset('one', 2, 40)]
      const input = { valueAsNumber: 2.6, value: '2.6' }
      state.onGapChange('x', { target: input })
      await nextTick()
      expect(state.gapXmm).toBe(3)
      expect(input.value).toBe('3')
      expect(state.placements[1].xMm - state.placements[0].xMm).toBe(43)
      for (const [axis, value, expected] of [['y', -4, 0], ['x', 40.8, 30], ['y', 4.2, 4]] as const) {
        state.onGapChange(axis, { target: { valueAsNumber: value, value: String(value) } })
        expect(axis === 'x' ? state.gapXmm : state.gapYmm).toBe(expected)
      }
      state.onGapChange('y', { target: { valueAsNumber: NaN, value: '' } })
      expect(state.gapYmm).toBe(4)
      expect(state.mode).toBe('custom')
    } finally { cleanup() }
  })

  it('renders the selected-image controls outside the canvas container', async () => {
    const app = createSSRApp({
      ...Workspace,
      setup(props: any, context: any) {
        const state = (Workspace as any).setup(props, context)
        state.useContours.value = false
        state.assets.value = [{ id: 'one', name: '图片', url: 'blob:one', width: 100, height: 100,
          widthMm: 50, heightMm: 50, quantity: 1, selected: true, rotationDeg: 0, ratioLocked: true }]
        state.adjusting.value = true
        state.selectedPlacementIndex.value = 0
        return state
      },
    })
    app.component('RouterLink', { render: () => null })
    const html = await renderToString(app)
    const between = html.match(/<\/canvas>([\s\S]*?)<section\b[^>]*aria-label="选中图片调整"/)
    expect(between).not.toBeNull()
    expect(between![1].replace(/<!--[\s\S]*?-->/g, '').trim()).toBe('</div>')
  })

  it('renders every artboard preview and its edit entry in overview mode', async () => {
    const app = createSSRApp({
      ...Workspace,
      setup(props: any, context: any) {
        const state = (Workspace as any).setup(props, context)
        state.useContours.value = false
        state.preset.value = 'custom'
        state.customWidth.value = 108
        state.customHeight.value = 108
        state.gapXmm.value = 0
        state.gapYmm.value = 0
        state.assets.value = [{ id: 'one', name: '图片', url: 'blob:one', width: 100, height: 100,
          widthMm: 50, heightMm: 50, quantity: 5, selected: true, rotationDeg: 0, ratioLocked: true }]
        state.createRemainingBoard()
        state.overviewOpen.value = true
        return state
      },
    })
    app.component('RouterLink', { render: () => null })
    const html = await renderToString(app)
    for (const index of [1, 2]) {
      expect(html).toContain(`aria-label="画板 ${index} 排版预览"`)
      expect(html).toContain(`aria-label="编辑画板 ${index}"`)
    }
  })

  it('defaults to custom mode and imports original sizes without tying them to export DPI', async () => {
    const { state, cleanup } = mountWorkspace()
    class DecodedImage {
      naturalWidth = 1500
      naturalHeight = 750
      onload?: () => void
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
      async decode() {}
    }
    vi.stubGlobal('Image', DecodedImage)
    try {
      expect(state.mode).toBe('custom')
      state.dpi = 300
      await state.addFiles([new File(['no metadata'], 'plain.png', { type: 'image/png' })])
      expect(state.assets[0].widthMm).toBe(127)
      expect(state.assets[0].heightMm).toBe(63.5)
      state.dpi = 600
      await nextTick()
      expect(state.assets[0].widthMm).toBe(127)
      // A PNG pHYs chunk with 11811 pixels/meter represents 300 DPI.
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 9, 112, 72, 89, 115, 0, 0, 46, 35, 0, 0, 46, 35, 1, 0, 0, 0, 0])
      await state.addFiles([new File([png], 'source.png', { type: 'image/png' })])
      expect(state.assets[1].widthMm).toBeCloseTo(127, 2)
      expect(state.assets[1].heightMm).toBeCloseTo(63.5, 2)
    } finally {
      state.assets.forEach((item: any) => URL.revokeObjectURL(item.url))
      cleanup()
      vi.unstubAllGlobals()
    }
  })

  it.each(['custom', 'smart'])('moves only remaining quantities to new boards in %s mode', async (mode) => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.mode = mode
      state.grouping = 'rows'
      state.assets = [asset('one', 9)]
      await nextTick()
      expect(state.placements).toHaveLength(4)
      state.createRemainingBoard()
      await nextTick()
      expect(state.activeBoardIndex).toBe(1)
      expect(state.assets[0].quantity).toBe(5)
      expect(state.placements).toHaveLength(4)
      expect(state.mode).toBe(mode)
      expect(state.grouping).toBe('rows')
      expect(state.assets[0].important).toBe(true)
      state.createRemainingBoard()
      await nextTick()
      expect(state.assets[0].quantity).toBe(1)
      expect(state.placements).toHaveLength(1)
      state.createRemainingBoard()
      expect(state.boards).toHaveLength(3)
      state.selectBoard(0)
      await nextTick()
      expect(state.assets[0].quantity).toBe(4)
      expect(state.placements).toHaveLength(4)
      state.createRemainingBoard()
      expect(state.boards).toHaveLength(3)
    } finally { cleanup() }
  })

  it('preserves manual positions and independent settings when switching boards', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.mode = 'smart'
      state.assets = [asset('one', 5)]
      await nextTick()
      state.manualPlacements = [{ itemId: 'one', xMm: 7, yMm: 8, widthMm: 40, heightMm: 40 }]
      state.createRemainingBoard()
      await nextTick()
      expect(state.assets[0].quantity).toBe(4)
      state.setAssetSize('one', 'widthMm', 3)
      state.dpi = 300
      await nextTick()
      state.selectBoard(0)
      await nextTick()
      expect(state.placements).toEqual([{ itemId: 'one', xMm: 7, yMm: 8, widthMm: 40, heightMm: 40 }])
      expect(state.assets[0].widthMm).toBe(50)
      expect(state.dpi).toBe(500)
      state.selectBoard(1)
      await nextTick()
      expect(state.assets[0].widthMm).toBe(30)
      expect(state.dpi).toBe(300)
    } finally { cleanup() }
  })

  it('does not create an empty board for oversized images or non-count modes', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.mode = 'smart'
      state.assets = [asset('large', 3, 110)]
      await nextTick()
      state.createRemainingBoard()
      expect(state.boards).toHaveLength(1)
      expect(state.assets[0].quantity).toBe(3)
      expect(state.status).toContain('尺寸')
      state.mode = 'balanced'
      state.assets = [asset('one', 5)]
      await nextTick()
      state.createRemainingBoard()
      expect(state.boards).toHaveLength(1)
    } finally { cleanup() }
  })

  it('counts locked copies once and transfers only their unlocked remainder', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.mode = 'custom'
      state.assets = [asset('one', 5)]
      await nextTick()
      state.lockSelected()
      await nextTick()
      state.createRemainingBoard()
      await nextTick()
      expect(state.assets[0].quantity).toBe(1)
      expect(state.assets[0].lockedGroupId).toBeUndefined()
      expect(state.groups).toHaveLength(0)
      state.selectBoard(0)
      await nextTick()
      expect(state.groups).toHaveLength(1)
      expect(state.placements).toHaveLength(4)
    } finally { cleanup() }
  })

  it('omits fulfilled and unchecked images while preserving per-image remainder', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.mode = 'custom'
      state.assets = [asset('first', 3), asset('second', 6), { ...asset('unchecked', 10), selected: false }]
      await nextTick()
      expect(state.placementCounts.get('first')).toBe(3)
      expect(state.placementCounts.get('second')).toBe(1)
      expect(state.overflow).toBe(5)
      state.createRemainingBoard()
      await nextTick()
      expect(state.assets.map((item: any) => [item.id, item.quantity])).toEqual([['second', 5]])
      expect(state.overflow).toBe(1)
      state.selectBoard(0)
      await nextTick()
      expect(state.assets.map((item: any) => [item.id, item.quantity])).toEqual([['first', 3], ['second', 1], ['unchecked', 10]])
      expect(state.overflow).toBe(0)
    } finally { cleanup() }
  })

  it('keeps shared image resources usable when removed from another board', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    const url = URL.createObjectURL(new Blob(['image-data']))
    try {
      state.mode = 'custom'
      state.assets = [{ ...asset('one', 5), url }]
      await nextTick()
      state.createRemainingBoard()
      await nextTick()
      state.removeAsset('one')
      expect(await (await fetch(url)).text()).toBe('image-data')
      state.selectBoard(0)
      await nextTick()
      expect(state.placements).toHaveLength(4)
      state.removeAsset('one')
      await expect(fetch(url)).rejects.toThrow()
    } finally { URL.revokeObjectURL(url); cleanup() }
  })
})

describe('workspace editing preserves the selected layout mode', () => {
  it.each(['balanced', 'compact', 'custom', 'smart'])('keeps %s when editing image details and bulk settings', async (mode) => {
    const app = renderer.createApp({ ...Workspace, render: () => null })
    app.provide(ssrContextKey, {})
    const vm = app.mount({})
    // script setup bindings are internal and omitted from Vue's public instance type.
    const state = (vm.$ as unknown as { setupState: Record<string, any> }).setupState
    try {
      state.mode = mode
      state.useContours = false
      state.assets = [{ id: 'one', width: 1000, height: 500, widthMm: 50, heightMm: 25,
        quantity: 1, selected: true, important: false, ratioLocked: true, rotationDeg: 0 }]
      state.setAssetSize('one', 'widthMm', 6)
      expect(state.mode).toBe(mode)
      expect(state.assets[0].widthMm).toBe(60)
      state.setQuantity('one', 3)
      expect(state.mode).toBe(mode)
      expect(state.assets[0].quantity).toBe(3)
      state.toggleImportant('one')
      expect(state.mode).toBe(mode)
      expect(state.assets[0].important).toBe(true)
      state.bulkLongEdgeCm = 4
      state.bulkQuantity = 2
      state.applyBulk()
      expect(state.mode).toBe(mode)
      expect(state.assets[0].widthMm).toBe(40)
      expect(state.assets[0].quantity).toBe(2)
      await nextTick()
      expect(state.placements.length).toBeGreaterThan(0)
      if (mode === 'custom' || mode === 'smart') expect(state.placements).toHaveLength(2)
    } finally {
      state.assets = []
      app.unmount()
    }
  })
})
