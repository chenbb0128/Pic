import { describe, expect, it } from 'vitest'
import source from '../../public/embedded/heart-star/slot-background.js?raw'

function setup() {
  const canvas = Object.assign(new EventTarget(), {
    style: { cursor: 'pointer', touchAction: '' }, captured: new Set<number>(),
    getBoundingClientRect: () => ({ left: 20, top: 30, width: 200, height: 240 }),
    setPointerCapture(id: number) { this.captured.add(id) },
    hasPointerCapture(id: number) { return this.captured.has(id) },
    releasePointerCapture(id: number) { this.captured.delete(id) },
  })
  const mode = Object.assign(new EventTarget(), { checked: false, disabled: false })
  const photoMode = Object.assign(new EventTarget(), { checked: false })
  const image = { naturalWidth: 200, naturalHeight: 100 }
  const states: any[] = [
    { imageDx: 17, imageScale: 2, motif: { id: 'heart' }, background: { type: 'image', image, dx: 3, dy: -4, scale: 2 } },
    { background: { type: 'image', image, dx: -7, dy: 8, scale: 1 } },
    { background: { type: 'color', color: '#abcdef' } },
  ]
  const board: any = { ready: true, token: states, states, width: 1000, height: 1000,
    contentRatio: 5 / 6, offsetX: 20, selected: new Set([0]),
    slots: [{ x: 200, y: 200, w: 200, h: 200 }, { x: 700, y: 200, w: 200, h: 200 }, { x: 200, y: 700, w: 200, h: 200 }] }
  let redraws = 0
  const controls = new Map<string, any>()
  const document = { getElementById(id: string) {
    if (!controls.has(id)) controls.set(id, Object.assign(new EventTarget(), { value: '' }))
    return controls.get(id)
  } }
  const api = new Function('globalThis', 'document', `${source};return globalThis.HeartStarBackground`)({}, document)
  const controller = api.create({ getStates: () => board.states, getSelection: () => board.selected,
    getTemplate: () => ({}), redraw() {}, report() {} })
  const drag = api.createDrag?.({ canvas, mode, photoMode, getBoard: () => board,
    redraw: () => { controller.update(); redraws++ }, onModeChange() {} })
  function fire(target: EventTarget, type: string, values = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      button: 0, pointerId: 1, isPrimary: true, clientX: 64, clientY: 70, ...values,
    })
    target.dispatchEvent(event)
    return event
  }
  const enable = () => { mode.checked = true; fire(mode, 'change') }
  return { canvas, mode, photoMode, board, states, drag, controls, fire, enable, redraws: () => redraws }
}

describe('heart-star background dragging', () => {
  it('moves only the selected background in template coordinates, excluding the footer', () => {
    const s = setup()
    expect(s.drag).toBeDefined()
    const before = structuredClone(s.states)
    s.enable()
    s.fire(s.canvas, 'pointerdown')
    s.fire(s.canvas, 'pointermove', { clientX: 84, clientY: 60 })
    expect(s.states[0].background).toMatchObject({ dx: 103, dy: -54, scale: 2 })
    expect(s.states[0].imageDx).toBe(17)
    expect(s.states[0].imageScale).toBe(2)
    expect(s.states[0].motif).toEqual({ id: 'heart' })
    expect(s.states.slice(1)).toEqual(before.slice(1))
    expect([...s.board.selected]).toEqual([0])
    expect(s.redraws()).toBeGreaterThan(0)
    expect(s.controls.get('slotBackgroundX').value).toBe('103')
    expect(s.controls.get('slotBackgroundY').value).toBe('-54')
    s.fire(s.canvas, 'pointerup')
    expect(s.canvas.captured.size).toBe(0)
    expect(s.drag.dragging()).toBe(false)
  })

  it('moves selected image backgrounds by the same delta while preserving their different offsets', () => {
    const s = setup()
    expect(s.drag).toBeDefined()
    s.board.selected = new Set([0, 1, 2])
    s.enable()
    s.fire(s.canvas, 'pointerdown')
    s.fire(s.canvas, 'pointermove', { clientX: 74, clientY: 80 })
    expect(s.states[0].background).toMatchObject({ dx: 53, dy: 46 })
    expect(s.states[1].background).toMatchObject({ dx: 43, dy: 58 })
    expect(s.states[2].background).toEqual({ type: 'color', color: '#abcdef' })
  })

  it.each(['off', 'outside', 'unselected', 'footer', 'secondary', 'not-ready'])('ignores invalid drag starts: %s', reason => {
    const s = setup()
    expect(s.drag).toBeDefined()
    const before = structuredClone(s.states)
    if (reason !== 'off') s.enable()
    if (reason === 'not-ready') s.board.ready = false
    const start = reason === 'outside' ? { clientX: 20, clientY: 30 } :
      reason === 'unselected' ? { clientX: 164, clientY: 70 } :
        reason === 'footer' ? { clientY: 260 } : reason === 'secondary' ? { button: 2 } : {}
    s.fire(s.canvas, 'pointerdown', start)
    s.fire(s.canvas, 'pointermove', { clientX: 84, clientY: 80 })
    expect(s.states).toEqual(before)
    expect(s.canvas.captured.size).toBe(0)
  })

  it.each(['pointercancel', 'lostpointercapture', 'token', 'selection', 'background'])('stops stale or cancelled drags: %s', reason => {
    const s = setup()
    expect(s.drag).toBeDefined()
    s.enable()
    s.fire(s.canvas, 'pointerdown')
    if (reason === 'token') s.board.token = []
    else if (reason === 'selection') s.board.selected = new Set([1])
    else if (reason === 'background') s.states[0].background = { ...s.states[0].background, dx: 99 }
    else s.fire(s.canvas, reason)
    const before = structuredClone(s.states)
    s.fire(s.canvas, 'pointermove', { clientX: 84 })
    expect(s.states).toEqual(before)
    expect(s.canvas.captured.size).toBe(0)
  })

  it('makes photo drag and background drag mutually exclusive and disables backgrounds without images', () => {
    const s = setup()
    expect(s.drag).toBeDefined()
    s.photoMode.checked = true
    s.enable()
    expect(s.photoMode.checked).toBe(false)
    s.fire(s.canvas, 'pointerdown')
    s.photoMode.checked = true
    s.fire(s.photoMode, 'change')
    expect(s.mode.checked).toBe(false)
    expect(s.canvas.captured.size).toBe(0)
    s.board.selected = new Set([2])
    s.drag.update()
    expect(s.mode.disabled).toBe(true)
  })

  it('does not toggle the selection after a drag, and restores normal clicks when switched off', () => {
    const s = setup()
    let clicks = 0
    s.canvas.addEventListener('click', () => { clicks++ })
    s.enable()
    s.fire(s.canvas, 'pointerdown')
    s.fire(s.canvas, 'pointerup')
    s.fire(s.canvas, 'click')
    expect(clicks).toBe(0)
    s.mode.checked = false
    s.fire(s.mode, 'change')
    s.fire(s.canvas, 'click')
    expect(clicks).toBe(1)
    expect(s.canvas.style.touchAction).toBe('')
  })

  it('ignores other pointers and keeps drag offsets within the numeric input range', () => {
    const s = setup()
    s.enable()
    s.fire(s.canvas, 'pointerdown')
    s.fire(s.canvas, 'pointermove', { pointerId: 2, clientX: 100 })
    expect(s.states[0].background.dx).toBe(3)
    s.fire(s.canvas, 'pointermove', { clientX: 100000, clientY: -100000 })
    expect(s.states[0].background).toMatchObject({ dx: 10000, dy: -10000 })
    s.fire(s.canvas, 'pointerup', { pointerId: 2 })
    expect(s.drag.dragging()).toBe(true)
    s.fire(s.canvas, 'pointerup')
    expect(s.drag.dragging()).toBe(false)
  })

  it('keeps numeric fine-tuning and resetting the background available after dragging', () => {
    const s = setup()
    s.enable()
    s.fire(s.canvas, 'pointerdown')
    s.fire(s.canvas, 'pointermove', { clientX: 84 })
    s.fire(s.canvas, 'pointerup')
    const x = s.controls.get('slotBackgroundX')
    x.value = '-25'
    s.fire(x, 'change')
    expect(s.states[0].background).toMatchObject({ dx: -25, dy: -4, scale: 2 })
    s.fire(s.controls.get('slotBackgroundReset'), 'click')
    expect(s.states[0].background).toMatchObject({ dx: 0, dy: 0, scale: 1, type: 'image' })
    expect(s.states[0].imageDx).toBe(17)
    expect(s.states[1].background.dx).toBe(-7)
  })
})
