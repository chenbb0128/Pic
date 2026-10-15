import { createRenderer, nextTick, ssrContextKey } from 'vue'
import { describe, expect, it } from 'vitest'
import Workspace from './StudioWorkspacePage.vue'

// Exercise the actual page handlers without rendering a browser canvas.
const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  parentNode: () => null, nextSibling: () => null,
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
