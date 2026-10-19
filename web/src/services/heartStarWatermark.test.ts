import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const path = new URL('../../public/embedded/heart-star/preview-watermark.js', import.meta.url)
const source = existsSync(path) ? readFileSync(path, 'utf8') : ''

function setup() {
  const controls = () => ({ checked: true, value: '', disabled: false, textContent: '',
    listeners: {} as Record<string, () => void>,
    addEventListener(event: string, action: () => void) { this.listeners[event] = action } })
  const enabled = controls(), text = controls(), opacity = controls(), value = controls()
  text.value = '仅供确认 · 禁止盗用'
  opacity.value = '20'
  const overlays: any[] = [], calls: any[] = []
  const ctx = {
    fillStyle: '', globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {}, translate() {}, rotate() {},
    fillRect(...args: number[]) { calls.push(['fill', this.fillStyle, ...args]) },
    drawImage(...args: any[]) { calls.push(['image', ...args]) },
    fillText(...args: any[]) { calls.push(['text', this.fillStyle, ...args]) },
  }
  const surface = { append: (element: any) => overlays.push(element) }
  const document = { createElement: (tag: string) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: () => ctx }
    : { style: {}, hidden: false, setAttribute() {} } }
  const feature = new Function('globalThis', 'document', `${source};return globalThis.HeartStarWatermark`)({}, document)
  expect(feature?.create).toBeTypeOf('function')
  feature.create({ surface, enabled, text, opacity, value })
  return { feature, enabled, text, opacity, value, overlays, calls }
}

describe('heart-star preview watermark', () => {
  it('covers the preview with an encoded repeating watermark and updates text safely', () => {
    const s = setup()
    expect(s.overlays[0].hidden).toBe(false)
    expect(decodeURIComponent(s.overlays[0].style.backgroundImage)).toContain('仅供确认 · 禁止盗用')
    s.text.value = '<svg onload="alert(1)">'
    s.text.listeners.input!()
    const svg = decodeURIComponent(s.overlays[0].style.backgroundImage)
    expect(svg).toContain('&lt;svg onload=&quot;alert(1)&quot;&gt;')
    expect(svg).not.toContain('<svg onload=')
    s.text.value = '  '
    s.text.listeners.input!()
    expect(decodeURIComponent(s.overlays[0].style.backgroundImage)).toContain('仅供确认 · 禁止盗用')
  })

  it('toggles only the preview overlay while proof exports always contain watermarks', () => {
    const s = setup()
    s.enabled.checked = false
    s.enabled.listeners.change!()
    expect(s.overlays[0].hidden).toBe(true)
    expect(s.text.disabled).toBe(true)
    s.feature.preview({ width: 800, height: 1200 })
    expect(s.calls.filter(call => call[0] === 'text').length).toBeGreaterThanOrEqual(70)
    s.enabled.checked = true
    s.enabled.listeners.change!()
    expect(s.overlays[0].hidden).toBe(false)
    expect(s.text.disabled).toBe(false)
  })

  it('flattens proof images on white, limits resolution and never changes the source canvas', () => {
    const s = setup(), original = { width: 3402, height: 5031 }
    s.opacity.value = '99'
    s.opacity.listeners.input!()
    const result = s.feature.preview(original)
    expect([result.width, result.height]).toEqual([1082, 1600])
    expect(original).toEqual({ width: 3402, height: 5031 })
    expect(s.calls[0]).toEqual(['fill', '#fff', 0, 0, 1082, 1600])
    expect(s.calls[1]).toEqual(['image', original, 0, 0, 1082, 1600])
    expect(s.calls.find(call => call[0] === 'text')?.[1]).toBe('rgba(102,112,133,0.5)')
    expect(s.value.textContent).toBe('50%')
  })

  it('allows a clean popup snapshot when the preview watermark switch is off', () => {
    const s = setup()
    s.feature.preview({ width: 800, height: 1200 }, false)
    expect(s.calls.filter(call => call[0] === 'text')).toHaveLength(0)
    expect(s.calls[0]).toEqual(['fill', '#fff', 0, 0, 800, 1200])
  })

  it('opens only the canvas snapshot, releases it on close and refreshes it on reopen', () => {
    const { feature } = setup()
    const node = () => ({ listeners: {} as Record<string, (event?: any) => void>, attributes: {} as Record<string, string>,
      focused: false, addEventListener(name: string, handler: (event?: any) => void) { this.listeners[name] = handler },
      setAttribute(name: string, value: string) { this.attributes[name] = value }, focus() { this.focused = true } })
    const button = node(), close = node(), frames: object[] = [], errors: string[] = []
    const content = { children: [] as object[], replaceChildren(...items: object[]) { this.children = items } }
    const dialog = { ...node(), open: false, showModal() { this.open = true },
      close() { this.open = false; this.listeners.close!() },
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 500, bottom: 700 }) }
    feature.createDialog({ button, close, dialog, content,
      render() { const frame = {}; frames.push(frame); return frame }, onError: (message: string) => errors.push(message) })
    button.listeners.click!()
    expect(dialog.open).toBe(true)
    expect(content.children).toEqual([frames[0]])
    expect(button.attributes['aria-expanded']).toBe('true')
    button.listeners.click!()
    expect(frames).toHaveLength(1)
    close.listeners.click!()
    expect(dialog.open).toBe(false)
    expect(content.children).toEqual([])
    expect(button.focused).toBe(true)
    expect(button.attributes['aria-expanded']).toBe('false')
    button.listeners.click!()
    expect(frames).toHaveLength(2)
    expect(content.children).toEqual([frames[1]])
    dialog.listeners.click!({ target: dialog, clientX: 10, clientY: 10 })
    expect(dialog.open).toBe(false)
    expect(errors).toEqual([])
  })

  it('leaves the popup closed and reports a snapshot generation error', () => {
    const { feature } = setup(), handlers: Record<string, () => void> = {}, errors: string[] = []
    const button = { addEventListener(name: string, action: () => void) { handlers[name] = action } }
    const dialog = { open: false, addEventListener() {} }
    feature.createDialog({ button, dialog, close: { addEventListener() {} }, content: { replaceChildren() {} },
      render() { throw new Error('模板尚未就绪') }, onError: (message: string) => errors.push(message) })
    handlers.click!()
    expect(dialog.open).toBe(false)
    expect(errors).toEqual(['模板尚未就绪'])
  })
})
