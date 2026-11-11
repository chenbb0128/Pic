import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function setup() {
  class Element {
    children: Element[] = []; listeners: Record<string, Function> = {}
    textContent = ''; className = ''; disabled = false; hidden = false
    width = 0; height = 0; open = false
    append(...items: Element[]) { this.children.push(...items) }
    replaceChildren(...items: Element[]) { this.children = items }
    setAttribute() {}
    addEventListener(name: string, fn: Function) { this.listeners[name] = fn }
    click() { this.listeners.click?.() }
    getContext() { return { drawImage() {} } }
    showModal() { this.open = true }
    close() { this.open = false }
  }
  const document = { createElement: () => new Element(), body: new Element() }, container = new Element(), processedIds: number[][] = [], restoredIds: number[][] = []
  const a = { width: 80, height: 80 }, b = { width: 120, height: 60 }, photos = [a, a, b]
  const processed = new WeakSet(), marked = new Set<number>()
  let token = {}, ready = true
  const scope: any = {}, path = new URL('../../public/embedded/heart-star/photo-thumbnails.js', import.meta.url)
  new Function('globalThis', 'document', existsSync(path) ? readFileSync(path, 'utf8') : '')(scope, document)
  expect(scope.HeartStarPhotoThumbnails, 'thumbnail controls are registered').toBeDefined()
  const feature = scope.HeartStarPhotoThumbnails.create({ container,
    getBoard: () => ({ token, ready, ids: photos.map((_, i) => i), photoAt: (id: number) => photos[id], processedAt: (id: number) => marked.has(id) }),
    isProcessed: (image: any) => processed.has(image), canRestore: (image: any) => processed.has(image),
    process: (ids: number[]) => processedIds.push(ids), restore: (ids: number[]) => restoredIds.push(ids) })
  const text = (el = container): string => el.textContent + el.children.map(child => text(child)).join(' ')
  const button = (card: Element) => card.children.find(child => child.className === 'photo-thumb-action')!
  return { feature, container, document, photos, a, b, processedIds, restoredIds, processed, marked, text, button,
    changeTemplate: () => { token = {} }, setReady: (value: boolean) => { ready = value } }
}

describe('manual photo background controls in upload thumbnails', () => {
  it('does not process on upload and directly processes only the clicked photo and all its uses', () => {
    const s = setup(); s.feature.update()
    expect(s.container.children).toHaveLength(2)
    expect(s.processedIds).toEqual([])
    expect(s.text()).toContain('一键去底')
    expect(s.text()).not.toContain('已处理')
    s.button(s.container.children[0]!).click()
    expect(s.processedIds).toEqual([[0, 1]])
    s.button(s.container.children[1]!).click()
    expect(s.processedIds).toEqual([[0, 1], [2]])
  })

  it('shows processed results, removes the badge on restore, and honors saved processing flags', () => {
    const s = setup(); s.feature.update()
    s.processed.add(s.b); s.feature.update()
    expect(s.text()).toContain('已处理')
    expect(s.text()).toContain('恢复原图')
    s.button(s.container.children[1]!).click()
    expect(s.restoredIds).toEqual([[2]])
    s.processed.delete(s.b); s.feature.update()
    expect(s.text()).not.toContain('已处理')
    s.marked.add(2); s.feature.update()
    expect(s.text()).toContain('已处理')
    expect(s.button(s.container.children[1]!).disabled).toBe(true)
  })

  it('preserves unchanged cards during drawing and rejects stale or busy thumbnail clicks', () => {
    const s = setup(); s.feature.update()
    const first = s.container.children[0]!
    s.feature.update()
    expect(s.container.children[0]).toBe(first)
    s.changeTemplate(); s.button(first).click()
    expect(s.processedIds).toEqual([])
    s.feature.update(); s.setReady(false); s.feature.update()
    expect(s.button(s.container.children[0]!).disabled).toBe(true)
    s.button(s.container.children[0]!).click()
    expect(s.processedIds).toEqual([])
  })

  it('keeps every uploaded photo accessible rather than hiding photos after the sixth', () => {
    const s = setup()
    s.photos.push(...Array.from({ length: 7 }, () => ({ width: 60, height: 60 })))
    s.feature.update()
    expect(s.container.children).toHaveLength(9)
    s.button(s.container.children[8]!).click()
    expect(s.processedIds).toEqual([[9]])
  })

  it('opens a large preview dialog when a thumbnail is clicked and closes it again', () => {
    const s = setup(); s.feature.update()
    const dialog = () => s.document.body.children[0]!
    expect(dialog()).toBeUndefined()
    s.container.children[0]!.children[0]!.click()
    expect(dialog().className).toBe('photo-zoom-dialog')
    expect(dialog().open).toBe(true)
    const head = dialog().children[0]!, body = dialog().children[1]!
    expect(head.children[0]!.textContent).toBe('照片 1 · 原图 · 80 × 80 px')
    expect([body.children[0]!.width, body.children[0]!.height]).toEqual([80, 80])
    head.children[1]!.click()
    expect(dialog().open).toBe(false)
    // Processed photos are labelled in the preview title.
    s.processed.add(s.a); s.feature.update()
    s.container.children[0]!.children[0]!.click()
    expect(dialog().children[0]!.children[0]!.textContent).toBe('照片 1 · 已处理 · 80 × 80 px')
    // Huge photos are drawn capped to 2048 px on the long edge.
    s.photos.push({ width: 4096, height: 2048 }); s.feature.update()
    const huge = s.container.children[2]!
    expect(huge.children[1]!.textContent === '一键去底').toBe(true)
    huge.children[0]!.click()
    const canvas = dialog().children[1]!.children[0]!
    expect([canvas.width, canvas.height]).toEqual([2048, 1024])
  })
})
