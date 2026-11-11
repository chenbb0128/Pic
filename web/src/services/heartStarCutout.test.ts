import { describe, expect, it, vi } from 'vitest'
import source from '../../public/embedded/heart-star/ai-cutout.js?raw'

function loadModule(): any {
  const scope: any = {}
  new Function('globalThis', source)(scope)
  return scope.HeartStarAICutout
}

class FakeImage {
  naturalWidth = 32
  naturalHeight = 24
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
}
// Setting src triggers onload asynchronously, like a real Image loading a blob URL.
Object.defineProperty(FakeImage.prototype, 'src', {
  set(value: string) { (this as any)._src = value; setTimeout(() => this.onload?.(), 0) },
  get() { return (this as any)._src ?? '' },
})

function fakeCanvas() {
  return { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }),
    toBlob(callback: (blob: Blob) => void) { callback(new Blob(['scaled'], { type: 'image/png' })) } }
}

function stubGlobals(fetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('document', { createElement: fakeCanvas })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:result', revokeObjectURL: vi.fn() })
  vi.stubGlobal('Image', FakeImage)
}

function mountEditor(fetch: ReturnType<typeof vi.fn>, image: any) {
  const button: any = { disabled: false, textContent: '', click: null as null | (() => void) }
  button.addEventListener = (_type: string, handler: () => void) => { button.click = handler }
  const applied: unknown[] = []
  const store = {
    begin: vi.fn(() => ({ token: {}, entries: [], cancelled: false })),
    apply: vi.fn(async (_session: unknown, processor: (image: any) => Promise<unknown>, progress: (done: number, total: number) => void) => {
      progress(1, 1)
      applied.push(await processor(image))
      return 1
    }),
    cancel: vi.fn(),
  }
  const report = vi.fn()
  const editor = loadModule().mount({ button, store, getBoard: () => ({ ready: true, ids: [0], photoAt: (id: number) => (id === 0 ? image : null) }), report, changed: () => {} })
  return { editor, button, store, report, applied }
}

function defaultFetch(image: any, cutout: any) {
  return vi.fn((url: string) => {
    if (url === image.src) return Promise.resolve({ ok: true, blob: async () => new Blob(['original'], { type: 'image/png' }) })
    if (url === '/api/v1/photos/cutout') return Promise.resolve(cutout)
    if (url.startsWith('/api/v1/assets/')) return Promise.resolve({ ok: true, blob: async () => new Blob(['result'], { type: 'image/png' }) })
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
}

const okCutout = { ok: true, json: async () => ({ code: 0, data: { id: 'a'.repeat(32), mime: 'image/png', cached: false } }) }

describe('heart-star AI cutout', () => {
  it('uploads the original photo and replaces it with the fetched result canvas', async () => {
    const image = { src: 'blob:photo', naturalWidth: 3000, naturalHeight: 2000 }
    const fetch = defaultFetch(image, okCutout)
    stubGlobals(fetch)
    const { editor, button, store, report, applied } = mountEditor(fetch, image)
    expect(button.textContent).toBe('AI 抠图（所选照片）')
    button.click!()
    await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith(expect.stringContaining('已完成 1 张')))
    expect(store.begin).toHaveBeenCalled()
    expect(editor.busy()).toBe(false)
    const cutoutCall = fetch.mock.calls.find(([url]) => url === '/api/v1/photos/cutout')!
    expect(cutoutCall[1]!.credentials).toBe('same-origin')
    expect(await ((cutoutCall[1]!.body as FormData).get('file') as Blob).text()).toBe('original')
    expect(fetch).toHaveBeenCalledWith(`/api/v1/assets/${'a'.repeat(32)}`, { credentials: 'same-origin' })
    expect(applied[0]).toMatchObject({ width: 32, height: 24 })
  })

  it('shows the busy state and ignores a second click while running', async () => {
    const image = { src: 'blob:photo', naturalWidth: 100, naturalHeight: 100 }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/v1/photos/cutout') { await gate; return okCutout }
      return { ok: true, blob: async () => ({}) }
    })
    stubGlobals(fetch)
    const { editor, button, store } = mountEditor(fetch, image)
    button.click!()
    await vi.waitFor(() => expect(editor.busy()).toBe(true))
    expect(button.textContent).toBe('AI 抠图中…')
    button.click!()
    expect(store.begin).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(editor.busy()).toBe(false))
  })

  it('reports upstream error messages verbatim with the failure flag', async () => {
    const image = { src: 'blob:photo', naturalWidth: 100, naturalHeight: 100 }
    const cutout = { ok: false, status: 429, json: async () => ({ code: 429, message: '今日 AI 抠图次数已用完，请明天再试或联系店家' }) }
    const fetch = defaultFetch(image, cutout)
    stubGlobals(fetch)
    const { button, report, store } = mountEditor(fetch, image)
    button.click!()
    await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith('今日 AI 抠图次数已用完，请明天再试或联系店家', true))
    expect(store.cancel).toHaveBeenCalled()
  })

  it('falls back to a password hint on 401 without a JSON body', async () => {
    const image = { src: 'blob:photo', naturalWidth: 100, naturalHeight: 100 }
    const cutout = { ok: false, status: 401, json: async () => { throw new Error('bad json') } }
    const fetch = defaultFetch(image, cutout)
    stubGlobals(fetch)
    const { button, report } = mountEditor(fetch, image)
    button.click!()
    await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith('AI 抠图需要先解锁工具，请刷新页面重新输入访问密码。', true))
  })

  it('shrinks photos above 4096 px before uploading', async () => {
    const image = { src: 'blob:big', naturalWidth: 5000, naturalHeight: 3000 }
    const fetch = defaultFetch(image, okCutout)
    stubGlobals(fetch)
    const { button, report } = mountEditor(fetch, image)
    button.click!()
    await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith(expect.stringContaining('已完成')))
    const form = fetch.mock.calls.find(([url]) => url === '/api/v1/photos/cutout')![1]!.body as FormData
    expect(await (form.get('file') as Blob).text()).toBe('scaled')
  })
})
