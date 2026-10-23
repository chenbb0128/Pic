import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

const file = new URL('../../public/embedded/heart-star/cloud-state.js', import.meta.url)
function feature() {
  const scope: any = {}
  new Function('globalThis', existsSync(file) ? readFileSync(file, 'utf8') : '')(scope)
  return scope.HeartStarCloudState
}
function editor() {
  const image = { image: true }, data: any = { template: { name: '爱心', image }, states: [{ dx: 0 }], photos: [null], settings: { dpi: 600, selected: [0] } }
  const state = feature().create({ getSnapshot: () => data, isImage: (v: any) => v === image || v?.image === true })
  return { state, data, image }
}

describe('shared editor unsaved changes', () => {
  it('does not warn on initial layout, selection or preview operations, but tracks real edits and undo', () => {
    const { state, data } = editor()
    expect(state.check().dirty).toBe(false)
    data.settings.selected = []
    data.copy = { selected: [], selectedSlot: 0, multiMode: true }
    state.reset()
    data.copy.selected = [1]; data.copy.selectedSlot = 1; data.copy.multiMode = false
    expect(state.check().dirty).toBe(false)
    data.states[0].dx = 12
    expect(state.check().dirty).toBe(true)
    data.states[0].dx = 0
    expect(state.check().dirty).toBe(false)
  })
  it('only a successful save marks that exact edit as saved; failed/conflicting saves keep the warning', () => {
    const { state, data } = editor(); state.check()
    data.states[0].dx = 7
    const token = state.begin('project')
    expect(state.check()).toMatchObject({ saving: true, dirty: true })
    state.failed()
    expect(state.check()).toMatchObject({ saving: false, dirty: true, savedAt: null })
    state.begin('project'); state.saved(token, '2026-10-23T10:00:00Z')
    expect(state.check()).toMatchObject({ dirty: false, savedAt: '2026-10-23T10:00:00Z' })
    const second = state.begin('project'); data.states[0].dx = 8
    state.saved(second, '2026-10-23T10:01:00Z')
    expect(state.check().dirty).toBe(true)
  })
  it('a template save cannot mark unsaved customer photos as safely persisted', () => {
    const { state, data, image } = editor(); state.check()
    data.photos[0] = image
    const token = state.begin('template'); state.saved(token, '2026-10-23T10:00:00Z')
    expect(state.check().dirty).toBe(true)
    data.photos[0] = null
    expect(state.check().dirty).toBe(false)
  })
  it('detects a replaced image of identical dimensions and ignores object property order', () => {
    const { state, data, image } = editor(); state.check()
    data.template = { image, name: '爱心' }
    expect(state.check().dirty).toBe(false)
    data.template.image = { image: true }
    expect(state.check().dirty).toBe(true)
  })
  it('warns again when the currently saved document has been deleted', () => {
    const { state } = editor(); state.check()
    state.saved(state.begin('project'), '2026-10-23T10:00:00Z')
    expect(state.check().dirty).toBe(false)
    state.forgotten()
    expect(state.check()).toMatchObject({ dirty: true, savedAt: null })
  })
})
