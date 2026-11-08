import { describe, expect, it } from 'vitest'
import html from '../../public/embedded/heart-star/index.html?raw'
import cloudSource from '../../public/embedded/heart-star/cloud-editor.js?raw'

function setup() {
  const controls: Record<string, any> = {}
  const control = (id: string) => controls[id] ||= { value: '', disabled: false }
  const env: any = {
    states: [{ size: .62 }, { size: .7 }, { size: .8 }], selectedSlots: new Set([1]), selectedSlot: 1, multiMode: false,
    templates: { test: {} }, sel: { value: 'test' }, clip: control('clip'), clipShape: control('clipShape'),
    document: { getElementById: control, querySelectorAll: () => [] },
    slotSelect: control('slotSelect'), scale: control('scale'), sizeNumber: control('sizeNumber'),
    updateCopyEditor() {}, updatePhotoControls() {}, draw() {},
  }
  const start = html.indexOf('function updateControls(')
  const update = html.slice(start, html.indexOf('function setSelectedSize(', start))
  const clipStart = html.indexOf('function setSelectedClip(')
  expect(clipStart).toBeGreaterThan(-1)
  const clip = html.slice(clipStart, html.indexOf('function setSelectedShape(', clipStart))
  const feature = new Function('env', `with(env){${update}${clip};return {updateControls,setSelectedClip}}`)(env)
  return { env, feature }
}

describe('heart-star per-position photo clipping', () => {
  it('enables and disables clipping only on selected positions', () => {
    const { env, feature } = setup(), before = structuredClone(env.states)
    feature.setSelectedClip(true)
    expect(env.states[1]).toMatchObject({ clip: true, size: .7 })
    expect(env.states[0]).toEqual(before[0])
    expect(env.states[2]).toEqual(before[2])
    env.selectedSlots = new Set([0, 2])
    feature.setSelectedClip(true)
    feature.setSelectedClip(false)
    expect(env.states.map((state: any) => state.clip)).toEqual([false, true, false])
  })

  it('shows each selection state, mixed selection, and disables clipping when nothing is selected', () => {
    const { env, feature } = setup()
    env.states[1].clip = true
    feature.updateControls()
    expect(env.clip.checked).toBe(true)
    env.selectedSlots = new Set([0]); feature.updateControls()
    expect(env.clip.checked).toBe(false)
    expect(env.clip.indeterminate).toBe(false)
    env.selectedSlots = new Set([0, 1]); feature.updateControls()
    expect(env.clip.indeterminate).toBe(true)
    feature.setSelectedClip(true)
    expect(env.clip.checked).toBe(true)
    expect(env.clip.indeterminate).toBe(false)
    env.selectedSlots.clear(); feature.updateControls()
    expect(env.clip.disabled).toBe(true)
    feature.setSelectedClip(false)
    expect(env.states[1].clip).toBe(true)
  })

  it('restores old global clipping while preserving new independent true and false states', () => {
    const scope: any = {}; new Function('globalThis', cloudSource)(scope)
    expect(scope.HeartStarCloudEditor.restorePhotoClips).toBeTypeOf('function')
    const input = [{ size: .62 }, { clip: false }, { clip: true }]
    expect(scope.HeartStarCloudEditor.restorePhotoClips(input, true)).toEqual([{ size: .62, clip: true }, { clip: false }, { clip: true }])
    expect(scope.HeartStarCloudEditor.restorePhotoClips(input, false)).toEqual([{ size: .62, clip: false }, { clip: false }, { clip: true }])
    expect(input[0]).not.toHaveProperty('clip')
  })
})
