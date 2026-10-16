import { createRenderer, createSSRApp, nextTick, ssrContextKey } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it, vi } from 'vitest'
import Workspace from './StudioWorkspacePage.vue'
import * as studioImage from '../services/studioImage'

// Exercise the actual page handlers without rendering a browser canvas.
const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  parentNode: () => null, nextSibling: () => null,
})

describe('overflow artboards', () => {
  it('deletes an earlier inactive board without changing the active layout or shared images', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    vi.stubGlobal('window', { confirm: () => true })
    try {
      state.assets = [asset('shared', 9)]
      state.createRemainingBoard()
      state.createRemainingBoard()
      state.manualPlacements = [{ itemId: 'shared', xMm: 7, yMm: 8, widthMm: 30, heightMm: 30 }]
      state.dpi = 300
      await nextTick()
      // DPI changes don't rearrange the active manual layout.
      state.overviewOpen = true
      const before = JSON.stringify(state.placements)
      state.removeBoard(1)
      await nextTick()
      expect(state.boards).toHaveLength(2)
      expect(state.activeBoardIndex).toBe(1)
      expect(JSON.stringify(state.placements)).toBe(before)
      expect(state.overviewOpen).toBe(true)
      expect(state.overviewBoards.map((board: any) => [board.index, board.placements.length])).toEqual([[0, 4], [1, 1]])
      expect(revoke).not.toHaveBeenCalledWith('blob:shared')
      state.selectBoard(0)
      state.selectBoard(1)
      await nextTick()
      expect(JSON.stringify(state.placements)).toBe(before)
      expect(state.dpi).toBe(300)
      expect(state.assets[0].quantity).toBe(1)
    } finally { cleanup(); revoke.mockRestore(); vi.unstubAllGlobals() }
  })

  it('deletes the active board, restores its neighbor and releases only unshared images', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    vi.stubGlobal('window', { confirm: () => true })
    try {
      state.assets = [asset('shared', 9)]
      state.createRemainingBoard()
      state.lockSelected()
      const neighbor = JSON.stringify(state.placements)
      state.createRemainingBoard()
      state.assets = [...state.assets, asset('only-deleted', 1, 10)]
      await nextTick()
      state.overviewOpen = true
      state.removeBoard(2)
      await nextTick()
      expect(state.activeBoardIndex).toBe(1)
      expect(state.boards).toHaveLength(2)
      expect(state.overviewBoards).toHaveLength(2)
      expect(JSON.stringify(state.placements)).toBe(neighbor)
      expect(state.groups).toHaveLength(1)
      expect(state.overviewOpen).toBe(true)
      expect(revoke).toHaveBeenCalledWith('blob:only-deleted')
      expect(revoke).not.toHaveBeenCalledWith('blob:shared')
      state.removeBoard(1)
      await nextTick()
      expect(state.activeBoardIndex).toBe(0)
      expect(state.overviewBoards).toHaveLength(1)
      expect(state.assets[0].quantity).toBe(4)
      expect(state.placements).toHaveLength(4)
    } finally { cleanup(); revoke.mockRestore(); vi.unstubAllGlobals() }
  })

  it('keeps the initial board and leaves all boards unchanged on cancellation or while busy', () => {
    const { state, asset, cleanup } = mountWorkspace()
    vi.stubGlobal('window', { confirm: () => false })
    try {
      state.assets = [asset('one', 5)]
      state.createRemainingBoard()
      const before = JSON.stringify(state.overviewBoards)
      state.removeBoard(1)
      vi.stubGlobal('window', { confirm: () => true })
      for (const index of [0, -1, 1.5, 99]) state.removeBoard(index)
      state.exporting = true
      state.removeBoard(1)
      state.exporting = false
      state.uploading = true
      state.removeBoard(1)
      state.uploading = false
      expect(state.activeBoardIndex).toBe(1)
      expect(JSON.stringify(state.overviewBoards)).toBe(before)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })

  it('renders close controls only for added board tabs', async () => {
    const app = createSSRApp({
      ...Workspace,
      setup(props: any, context: any) {
        const state = (Workspace as any).setup(props, context)
        state.boards.value = [null, state.snapshotBoard(), state.snapshotBoard()]
        return state
      },
    })
    app.component('RouterLink', { render: () => null })
    const html = await renderToString(app)
    expect(html).toContain('aria-label="删除画板 2"')
    expect(html).toContain('aria-label="删除画板 3"')
    expect(html).not.toContain('aria-label="删除画板 1"')
  })

  it('edits independent gaps and row breaks only in custom mode, preserving board settings', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.assets = [asset('one', 5)]
      const input = { valueAsNumber: 2.6, value: '2.6' }
      state.setAssetGap('one', 'x', { target: input })
      expect(input.value).toBe('3')
      expect(state.assets[0].gapXmm).toBe(3)
      state.setAssetGap('one', 'y', { target: { valueAsNumber: 0, value: '0' } })
      state.setAssetNewRow('one', true)
      await nextTick()
      expect(state.assets[0].startNewRow).toBe(true)
      expect(state.placements).toHaveLength(2)
      state.createRemainingBoard()
      await nextTick()
      expect(state.assets[0]).toMatchObject({ gapXmm: 3, gapYmm: 0, startNewRow: true, quantity: 3 })
      state.mode = 'smart'
      await nextTick()
      expect(state.placements).toHaveLength(3)
      state.setAssetGap('one', 'x', { target: { valueAsNumber: 12, value: '12' } })
      expect(state.assets[0].gapXmm).toBe(3)
      state.mode = 'custom'
      state.setAssetGap('one', 'x', { target: { valueAsNumber: NaN, value: '' } })
      await nextTick()
      expect(state.assets[0].gapXmm).toBeUndefined()
      expect(state.placements).toHaveLength(3)
      state.selectBoard(0)
      await nextTick()
      expect(state.assets[0]).toMatchObject({ gapXmm: 3, gapYmm: 0, startNewRow: true })
      state.lockSelected()
      state.setAssetGap('one', 'x', { target: { valueAsNumber: 9, value: '9' } })
      state.setAssetNewRow('one', false)
      expect(state.assets[0]).toMatchObject({ gapXmm: 3, startNewRow: true })
    } finally { cleanup() }
  })

  it.each([['custom', 'free'], ['smart', 'free'], ['smart', 'rows'], ['smart', 'columns'], ['neat', 'free']])(
    'uses list order and updates priority when moving images in %s/%s', async (mode, grouping) => {
      const { state, asset, cleanup } = mountWorkspace()
      try {
        state.mode = mode
        state.grouping = grouping
        state.assets = [{ ...asset('first', 4), important: false }, { ...asset('second', 1, 100), important: true }]
        await nextTick()
        expect(state.placements.map((p: any) => p.itemId)).toEqual(Array(4).fill('first'))
        state.reorderAsset('second', 0)
        await nextTick()
        expect(state.assets.map((a: any) => a.id)).toEqual(['second', 'first'])
        expect(state.placements.map((p: any) => p.itemId)).toEqual(['second'])
        state.reorderAsset('second', -1)
        state.reorderAsset('missing', 1)
        expect(state.assets.map((a: any) => a.id)).toEqual(['second', 'first'])
        state.reorderAsset('second', 1)
        await nextTick()
        expect(state.placements.map((p: any) => p.itemId)).toEqual(Array(4).fill('first'))
        expect(state.mode).toBe(mode)
      } finally { cleanup() }
    },
  )

  it('deletes a locked image and removes its placements without deleting its group neighbors', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.assets = [asset('first', 1), asset('second', 1)]
      await nextTick()
      state.lockSelected()
      state.removeAsset('first')
      await nextTick()
      expect(state.assets.map((a: any) => a.id)).toEqual(['second'])
      expect(state.placements.map((p: any) => p.itemId)).toEqual(['second'])
      expect(state.groups).toHaveLength(1)
    } finally { cleanup() }
  })

  it.each(['mouse', 'touch'])('reorders on pointer release from the handle using %s without rearranging during drag', async (pointerType) => {
    const { state, asset, cleanup } = mountWorkspace()
    const handle = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {}, focus() {} }
    const event = (clientY: number, pointerId = 1) => ({ pointerId, pointerType, button: 0, isPrimary: true,
      clientX: 350, clientY, currentTarget: handle, preventDefault() {} })
    try {
      state.assets = [asset('A', 4), asset('B', 1, 100), asset('C', 1, 100)]
      for (const [index, id] of ['A', 'B', 'C'].entries()) {
        state.setAssetRow(id, { getBoundingClientRect: () => ({ top: index * 100, bottom: (index + 1) * 100, left: 0, right: 400, height: 100 }) })
      }
      state.startAssetDrag('C', event(250))
      state.moveAssetDrag(event(10))
      expect(state.assets.map((a: any) => a.id)).toEqual(['A', 'B', 'C'])
      expect(state.placements.map((p: any) => p.itemId)).toEqual(Array(4).fill('A'))
      expect(state.assetDropIndicator).toEqual({ id: 'A', side: 'before' })
      state.finishAssetDrag(event(10, 2))
      expect(state.assets.map((a: any) => a.id)).toEqual(['A', 'B', 'C'])
      state.finishAssetDrag(event(10))
      await nextTick()
      expect(state.assets.map((a: any) => a.id)).toEqual(['C', 'A', 'B'])
      expect(state.placements.map((p: any) => p.itemId)).toEqual(['C'])
      expect(state.assetDrag).toBeNull()
      state.reorderAsset('C', 2)
      expect(state.assets.map((a: any) => a.id)).toEqual(['A', 'B', 'C'])
      state.startAssetDrag('A', event(50))
      state.moveAssetDrag(event(290))
      expect(state.assetDropIndicator).toEqual({ id: 'C', side: 'after' })
      state.finishAssetDrag(event(290))
      expect(state.assets.map((a: any) => a.id)).toEqual(['B', 'C', 'A'])
    } finally { cleanup() }
  })

  it('cancels handle sorting on a tap, pointer cancellation, outside drop or board change', () => {
    const { state, asset, cleanup } = mountWorkspace()
    const handle = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {}, focus() {} }
    const event = (clientY: number, clientX = 350) => ({ pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true,
      clientX, clientY, currentTarget: handle, preventDefault() {} })
    try {
      state.assets = [asset('A', 1), asset('B', 1)]
      state.setAssetRow('A', { getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 400, height: 100 }) })
      state.setAssetRow('B', { getBoundingClientRect: () => ({ top: 100, bottom: 200, left: 0, right: 400, height: 100 }) })
      state.startAssetDrag('A', event(50))
      state.finishAssetDrag(event(52))
      expect(state.assets.map((a: any) => a.id)).toEqual(['A', 'B'])
      state.startAssetDrag('A', event(50))
      state.moveAssetDrag(event(190))
      state.cancelAssetDrag()
      state.finishAssetDrag(event(190))
      expect(state.assets.map((a: any) => a.id)).toEqual(['A', 'B'])
      state.startAssetDrag('A', event(50))
      state.finishAssetDrag(event(190, 600))
      expect(state.assets.map((a: any) => a.id)).toEqual(['A', 'B'])
      state.startAssetDrag('A', event(50))
      state.assets = [asset('different-board', 1)]
      expect(state.assetDrag).toBeNull()
      state.finishAssetDrag(event(190))
      expect(state.assets.map((a: any) => a.id)).toEqual(['different-board'])
      state.exporting = true
      state.startAssetDrag('different-board', event(50))
      expect(state.assetDrag).toBeNull()
    } finally { cleanup() }
  })

  it('supports keyboard ordering from the handle without moving locked placements', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.assets = [asset('A', 1), { ...asset('B', 1), selected: false }, { ...asset('C', 1), selected: false }]
      state.lockSelected()
      const locked = JSON.stringify(state.placements)
      const handle = { isConnected: true, focus: vi.fn() }
      state.onAssetOrderKey('C', { key: 'Home', currentTarget: handle, preventDefault() {} })
      await nextTick()
      expect(state.assets.map((a: any) => a.id)).toEqual(['C', 'A', 'B'])
      expect(handle.focus).toHaveBeenCalledWith({ preventScroll: true })
      expect(JSON.stringify(state.placements)).toBe(locked)
      state.onAssetOrderKey('C', { key: 'ArrowDown', preventDefault() {} })
      expect(state.assets.map((a: any) => a.id)).toEqual(['A', 'C', 'B'])
      state.onAssetOrderKey('C', { key: 'End', preventDefault() {} })
      expect(state.assets.map((a: any) => a.id)).toEqual(['A', 'B', 'C'])
      state.uploading = true
      state.onAssetOrderKey('C', { key: 'Home', preventDefault() {} })
      expect(state.assets.map((a: any) => a.id)).toEqual(['A', 'B', 'C'])
    } finally { cleanup() }
  })

  it('renders compact right-side drag and delete controls without numbers or arrow buttons', async () => {
    const app = createSSRApp({
      ...Workspace,
      setup(props: any, context: any) {
        const state = (Workspace as any).setup(props, context)
        state.assets.value = [{ id: 'one', name: '示例', url: 'blob:one', width: 100, height: 100,
          widthMm: 20, heightMm: 20, quantity: 1, selected: true, rotationDeg: 0, ratioLocked: true }]
        return state
      },
    })
    app.component('RouterLink', { render: () => null })
    const html = await renderToString(app)
    expect(html).toContain('aria-label="拖拽排序 示例"')
    expect(html).not.toContain('aria-label="上移 示例"')
    expect(html).not.toContain('aria-label="下移 示例"')
    expect(html).not.toContain('排版优先级 1')
    expect(html).toMatch(/class="studio-asset-actions"[\s\S]*aria-label="拖拽排序 示例"[\s\S]*aria-label="删除 示例"/)
    expect(html).toMatch(/<button[^>]*aria-label="删除 示例"[^>]*><svg/)
    expect(html).not.toContain('aria-label="示例 优先排版"')
    expect(html).toContain('aria-label="示例 横向间距毫米"')
    expect(html).toContain('aria-label="示例 纵向间距毫米"')
    expect(html).toContain('aria-label="示例 另起一行"')
  })

  it('exports all populated boards with their own size, DPI and dated filenames without switching the editor', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    const downloads: string[] = []
    const encoded: { width: number; height: number; dpi: number }[] = []
    const canvases: { width: number; height: number }[] = []
    const png = vi.spyOn(studioImage, 'canvasPng').mockImplementation(async (canvas, dpi) => {
      encoded.push({ width: canvas.width, height: canvas.height, dpi })
      return new Blob(['png'], { type: 'image/png' })
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('document', {
      body: { append() {} },
      createElement(tag: string) {
        if (tag === 'a') return { href: '', download: '', click() { downloads.push(this.download) }, remove() {} }
        const canvas = { width: 0, height: 0, getContext: () => ({ clearRect() {}, save() {}, restore() {}, rotate() {}, translate() {}, drawImage() {} }) }
        canvases.push(canvas)
        return canvas
      },
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T17:20:00Z'))
    try {
      state.assets = [{ ...asset('one', 5), ratioLocked: false }]
      state.dpi = 254
      await nextTick()
      state.createRemainingBoard()
      await nextTick()
      state.customWidth = 60
      state.customHeight = 100
      state.orientation = 'portrait'
      state.dpi = 127
      state.manualPlacements = [{ itemId: 'one', xMm: 7, yMm: 8, widthMm: 30, heightMm: 30 }]
      await nextTick()
      const before = JSON.stringify(state.manualPlacements)
      state.generated = { url: 'blob:previous', name: 'previous.png', size: 3 }
      state.overviewOpen = true
      await state.exportAllBoards()
      expect(downloads).toEqual(['20261016_自定义_108x108mm_画板1.png', '20261016_自定义_60x100mm_画板2.png'])
      expect(encoded).toEqual([{ width: 1080, height: 1080, dpi: 254 }, { width: 300, height: 500, dpi: 127 }])
      expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
      expect(state.activeBoardIndex).toBe(1)
      expect(JSON.stringify(state.manualPlacements)).toBe(before)
      expect(state.generated.url).toBe('blob:previous')
      expect(state.overviewOpen).toBe(true)
      expect(state.exporting).toBe(false)
      png.mockRejectedValueOnce(new Error('PNG 编码失败'))
      await state.exportAllBoards()
      expect(state.status).toContain('导出中断：PNG 编码失败')
      expect(state.exporting).toBe(false)
      expect(state.batchExportLabel).toBe('')
      expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
      state.assets = []
      state.manualPlacements = []
      await nextTick()
      await state.exportAllBoards()
      expect(downloads).toHaveLength(3)
      expect(downloads[2]).toBe('20261016_自定义_108x108mm_画板1.png')
      state.assets = [{ ...asset('one', 1), ratioLocked: false }]
      await nextTick()
      state.manualPlacements = [{ itemId: 'one', xMm: 7, yMm: 8, widthMm: 30, heightMm: 30 }]
      await nextTick()
      await state.generate()
      expect(state.generated.name).toBe('20261016_自定义_60x100mm_画板2.png')
    } finally { png.mockRestore(); cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  it('validates saved boards before exporting and skips empty boards', async () => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.assets = [asset('one', 5)]
      state.dpi = 0
      await nextTick()
      state.createRemainingBoard()
      await nextTick()
      state.dpi = 300
      await state.exportAllBoards()
      expect(state.status).toContain('画板 1')
      expect(state.status).toContain('DPI')
      expect(state.exporting).toBe(false)
      state.boards = state.boards.map((board: any) => board ? { ...board, dpi: 300,
        manualPlacements: [{ itemId: 'one', xMm: 0, yMm: 4, widthMm: 50, heightMm: 50 }] } : board)
      await state.exportAllBoards()
      expect(state.status).toContain('画板 1')
      expect(state.status).toContain('4mm 留边')
      state.boards = [null]
      state.activeBoardIndex = 0
      state.assets = []
      state.groups = []
      state.manualPlacements = []
      await state.exportAllBoards()
      expect(state.status).toContain('没有可导出的图案')
    } finally { cleanup() }
  })

  it('explicitly restores the detail view display after leaving overview', async () => {
    for (const overview of [false, true, false]) {
      const app = createSSRApp({
        ...Workspace,
        setup(props: any, context: any) {
          const state = (Workspace as any).setup(props, context)
          state.overviewOpen.value = overview
          return state
        },
      })
      app.component('RouterLink', { render: () => null })
      const html = await renderToString(app)
      const detail = html.match(/<div\b[^>]*class="flex min-h-0 flex-1 flex-col gap-3"[^>]*>/)?.[0]
      expect(detail).toBeDefined()
      expect(detail).toContain(`display:${overview ? 'none' : 'flex'}`)
      expect(html).toContain('aria-label="排版实时预览"')
    }
  })

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
    expect(html).toContain('一键导出全部 PNG')
  })

  it('defaults to 300 DPI and imports original sizes without tying them to export DPI', async () => {
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
      state.dpi = NaN
      await state.addFiles([new File(['no metadata'], 'fallback.png', { type: 'image/png' })])
      expect(state.assets[2].widthMm).toBe(127)
      expect(state.assets[2].heightMm).toBe(63.5)
    } finally {
      state.assets.forEach((item: any) => URL.revokeObjectURL(item.url))
      cleanup()
      vi.unstubAllGlobals()
    }
  })

  it.each(['custom', 'smart', 'neat'])('moves only remaining quantities to new boards in %s mode', async (mode) => {
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
      expect(state.assets[0].id).toBe('one')
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
      state.dpi = 500
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

  it.each(['custom', 'neat'])('counts locked copies once and transfers only their unlocked remainder in %s', async mode => {
    const { state, asset, cleanup } = mountWorkspace()
    try {
      state.mode = mode
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
  it.each(['balanced', 'compact', 'custom', 'smart', 'neat'])('keeps %s when editing image details and bulk settings', async (mode) => {
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
      state.bulkLongEdgeCm = 4
      state.bulkQuantity = 2
      state.applyBulk()
      expect(state.mode).toBe(mode)
      expect(state.assets[0].widthMm).toBe(40)
      expect(state.assets[0].quantity).toBe(2)
      await nextTick()
      expect(state.placements.length).toBeGreaterThan(0)
      if (mode === 'custom' || mode === 'smart' || mode === 'neat') expect(state.placements).toHaveLength(2)
    } finally {
      state.assets = []
      app.unmount()
    }
  })
})
