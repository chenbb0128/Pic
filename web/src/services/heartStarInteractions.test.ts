import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const path = new URL('../../public/embedded/heart-star/editor-interactions.js', import.meta.url)
const source = existsSync(path) ? readFileSync(path, 'utf8') : ''

function element(id = '') {
  const classes = new Set<string>(), listeners: Record<string, (event: any) => void> = {}
  const el: any = { id, hidden: false, style: {}, textContent: '', attributes: {}, children: [], parentElement: null,
    classList: { contains: (name: string) => classes.has(name), toggle(name: string, on: boolean) { on ? classes.add(name) : classes.delete(name) } },
    addEventListener(name: string, handler: (event: any) => void) { listeners[name] = handler },
    setAttribute(name: string, value: string) { el.attributes[name] = value },
    get firstElementChild() { return el.children[0] },
    append(...nodes: any[]) { for (const node of nodes) { if (node.parentElement) node.parentElement.children.splice(node.parentElement.children.indexOf(node), 1); node.parentElement = el; el.children.push(node) } },
    prepend(node: any) { el.append(node); el.children.unshift(el.children.pop()) },
    querySelector() { return el.control || null },
    fire(name: string, event: any = {}) { listeners[name]?.(event) },
  }
  return el
}

function api(records = new Map<string, string>(), blocked = false) {
  const global: any = { localStorage: {
    getItem: (key: string) => { if (blocked) throw new Error('blocked'); return records.get(key) ?? null },
    setItem: (key: string, value: string) => { if (blocked) throw new Error('blocked'); records.set(key, value) },
  } }
  return new Function('globalThis', 'document', `${source};return globalThis.HeartStarInteractions`)(global, { createElement: () => element() })
}

function setup() {
  const feature = api(), canvas = element(), surface = element(), captures = new Set<number>()
  canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 500, height: 1010 })
  canvas.setPointerCapture = (id: number) => captures.add(id)
  canvas.hasPointerCapture = (id: number) => captures.has(id)
  canvas.releasePointerCapture = (id: number) => captures.delete(id)
  const states = [{ size: 0.5 }, { size: 0.8, dx: 20 }, { size: 1.19 }]
  const board: any = { ready: true, token: states, width: 1000, height: 2000, contentRatio: 1000 / 1010,
    slots: [{ x: 200, y: 200 }, { x: 500, y: 1000 }, { x: 800, y: 1800 }], states }
  let selected = new Set([2]), movingPhoto = false, skippedClick = false, prevented = 0
  const commits: number[][] = []
  feature.createSelection({ canvas, surface, getBoard: () => board, isPhotoDrag: () => movingPhoto,
    onStart() { skippedClick = false },
    onSelection(ids: number[], append: boolean) { selected = append ? new Set([...selected, ...ids]) : new Set(ids); commits.push([...selected]); skippedClick = true },
    canResize: () => board.ready && !board.text && selected.size > 0,
    onResize(delta: number) { feature.resizeSelection(states, selected, delta) },
  })
  function event(x: number, y: number, extra = {}) {
    return { button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: y,
      preventDefault() { prevented++ }, ...extra }
  }
  function drag(from: number[], to: number[], extra = {}) {
    canvas.fire('pointerdown', event(from[0]!, from[1]!, extra))
    canvas.fire('pointermove', event(to[0]!, to[1]!))
    canvas.fire('pointerup', event(to[0]!, to[1]!))
  }
  return { feature, canvas, surface, board, states, captures, commits, event, drag,
    get selected() { return [...selected] }, get skippedClick() { return skippedClick }, get prevented() { return prevented },
    set movingPhoto(value: boolean) { movingPhoto = value } }
}

describe('heart-star editor interactions', () => {
  it('selects moved pattern centers using preview coordinates, including a reverse drag', () => {
    const s = setup()
    s.drag([370, 600], [110, 55])
    expect(s.selected).toEqual([0, 1])
    expect(s.skippedClick).toBe(true)
    expect(s.captures.size).toBe(0)
    expect(s.surface.children[0].hidden).toBe(true)
  })

  it('appends with Shift, clears an empty rectangle and leaves an ordinary click alone', () => {
    const s = setup()
    s.drag([110, 55], [250, 200], { shiftKey: true })
    expect(s.selected).toEqual([2, 0])
    s.drag([110, 55], [113, 57])
    expect(s.selected).toEqual([2, 0])
    expect(s.skippedClick).toBe(false)
    s.drag([120, 300], [150, 400])
    expect(s.selected).toEqual([])
  })

  it('does not start a rectangle during photo dragging, over the footer, or with a secondary pointer', () => {
    const s = setup()
    s.movingPhoto = true
    s.drag([110, 55], [370, 600])
    s.movingPhoto = false
    s.drag([110, 1055], [370, 600])
    s.drag([110, 55], [370, 600], { isPrimary: false })
    expect(s.commits).toEqual([])
    expect(s.captures.size).toBe(0)
  })

  it('cancels without modifying selection if interrupted or the template changes', () => {
    const s = setup()
    s.canvas.fire('pointerdown', s.event(110, 55))
    s.canvas.fire('pointermove', s.event(370, 600))
    s.canvas.fire('pointercancel', s.event(370, 600))
    expect(s.commits).toEqual([])
    expect(s.surface.children[0].hidden).toBe(true)
    s.canvas.fire('pointerdown', s.event(110, 55))
    s.canvas.fire('pointermove', s.event(370, 600))
    s.board.token = []
    s.canvas.fire('pointerup', s.event(370, 600))
    expect(s.commits).toEqual([])
    expect(s.captures.size).toBe(0)
  })

  it('Alt-wheel resizes only selected patterns, preserving mixed sizes and clamping the limits', () => {
    const s = setup()
    s.drag([110, 55], [370, 600])
    s.canvas.fire('wheel', s.event(200, 150, { altKey: true, deltaY: -100, deltaMode: 0 }))
    expect(s.states.map(state => state.size)).toEqual([0.52, 0.82, 1.19])
    s.feature.resizeSelection(s.states, new Set([0, 2]), 1)
    expect(s.states.map(state => state.size)).toEqual([1.2, 0.82, 1.2])
    s.feature.resizeSelection(s.states, new Set([0]), -2)
    expect(s.states[0]!.size).toBe(0.25)
  })

  it('keeps normal scrolling and text templates unchanged, but normalizes line-mode Alt-wheel', () => {
    const s = setup()
    s.canvas.fire('wheel', s.event(200, 150, { deltaY: -100, deltaMode: 0 }))
    expect(s.prevented).toBe(0)
    s.board.text = true
    s.canvas.fire('wheel', s.event(200, 150, { altKey: true, deltaY: -100, deltaMode: 0 }))
    expect(s.prevented).toBe(0)
    s.board.text = false
    s.canvas.fire('wheel', s.event(200, 150, { altKey: true, deltaY: -6, deltaMode: 1 }))
    expect(s.states[2]!.size).toBe(1.2)
    expect(s.prevented).toBe(1)
  })
})

function field() {
  const section = element('uploadSection'), label = element(), content = element('files')
  label.textContent = '上传照片'
  label.classList.toggle('label', true)
  section.append(label, content)
  section.control = content
  return { section, label, content }
}

describe('heart-star clear-selection shortcut', () => {
  function shortcut() {
    const target = element(), selected = new Set([0, 1, 2])
    let ready = true, prevented = 0
    api().createShortcuts({ target, canClear: () => ready && selected.size > 0, onClear: () => selected.clear() })
    return { target, selected, set ready(value: boolean) { ready = value },
      get prevented() { return prevented },
      key(extra = {}) { target.fire('keydown', { key: 'Escape', target: {}, preventDefault() { prevented++ }, ...extra }) },
    }
  }

  it('clears all selected patterns with Escape and leaves other keys alone', () => {
    const s = shortcut()
    s.key({ key: 'a' })
    expect([...s.selected]).toEqual([0, 1, 2])
    s.key()
    expect([...s.selected]).toEqual([])
    expect(s.prevented).toBe(1)
    s.key()
    expect(s.prevented).toBe(1)
  })

  it('does not intercept typing, IME composition or already-handled keyboard events', () => {
    const s = shortcut()
    for (const target of [{ closest: () => ({ tagName: 'INPUT' }) }, { isContentEditable: true }]) s.key({ target })
    for (const flag of ['isComposing', 'defaultPrevented', 'ctrlKey', 'metaKey', 'altKey', 'shiftKey']) s.key({ [flag]: true })
    expect([...s.selected]).toEqual([0, 1, 2])
    expect(s.prevented).toBe(0)
  })

  it('leaves Escape to open dialogs and does not act while the board is unavailable', () => {
    const s = shortcut()
    s.target.control = { open: true }
    s.key()
    s.target.control = null
    s.ready = false
    s.key()
    expect([...s.selected]).toEqual([0, 1, 2])
    expect(s.prevented).toBe(0)
    s.ready = true
    s.key()
    expect([...s.selected]).toEqual([])
  })
})

describe('heart-star collapsible settings', () => {
  it('remembers section collapse without overwriting child visibility or control values', () => {
    const records = new Map<string, string>(), feature = api(records), first = field()
    first.content.hidden = true
    first.content.value = 'kept'
    feature.createSections([first.section])
    const button = first.section.firstElementChild.children[1]
    button.fire('click')
    expect(first.section.classList.contains('feature-collapsed')).toBe(true)
    expect(button.attributes['aria-expanded']).toBe('false')
    expect(first.content.hidden).toBe(true)
    const reopened = field()
    feature.createSections([reopened.section])
    expect(reopened.section.classList.contains('feature-collapsed')).toBe(true)
    button.fire('click')
    expect(first.section.classList.contains('feature-collapsed')).toBe(false)
    expect(first.content.hidden).toBe(true)
    expect(first.content.value).toBe('kept')
  })

  it('still collapses when browser storage is unavailable and preserves hidden template sections', () => {
    const feature = api(new Map(), true), s = field()
    s.section.hidden = true
    feature.createSections([s.section])
    const button = s.section.firstElementChild.children[1]
    button.fire('click')
    expect(s.section.classList.contains('feature-collapsed')).toBe(true)
    expect(s.section.hidden).toBe(true)
  })
})
