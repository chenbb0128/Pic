import { createRenderer, createSSRApp, nextTick, ssrContextKey } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createMemoryHistory } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../router'

const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  parentNode: () => null, nextSibling: () => null,
})

async function getPage() {
  const route = createAppRouter(createMemoryHistory()).resolve('/tools/heart-star')
  expect(route.matched).toHaveLength(1)
  expect(route.name).toBe('heart-star')
  const loader = route.matched[0]!.components!.default as () => Promise<{ default: any }>
  return (await loader()).default
}

async function renderPage(password?: string) {
  const Page = await getPage()
  return renderToString(createSSRApp({
    ...Page,
    async setup(props: any, context: any) {
      const state = Page.setup(props, context)
      if (password !== undefined) { state.password.value = password; await state.unlock() }
      return state
    },
  }))
}

describe('heart and star tool access', () => {
  beforeEach(() => {
    const records = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => { records.set(key, value) },
      removeItem: (key: string) => { records.delete(key) },
    })
  })

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('shows a password form and does not load templates before unlocking', async () => {
    const html = await renderPage()
    expect(html).toContain('type="password"')
    expect(html).toContain('爱心星星排版')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('87654321')
  })

  it('rejects an incorrect password without loading the tool', async () => {
    const html = await renderPage('12345678')
    expect(html).toContain('密码错误')
    expect(html).toContain('aria-invalid="true"')
    expect(html).not.toContain('<iframe')
  })

  it('unlocks the embedded tool only with the fixed password', async () => {
    const html = await renderPage('87654321')
    expect(html).toContain('<iframe')
    expect(html).toMatch(/src="\/embedded\/heart-star\/index\.html\?v=[^"\s]+"/)
    expect(html).toContain('allow-downloads')
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('87654321')
  })

  it('clears the entered password and confirms before discarding the tool on relock', async () => {
    const Page = await getPage()
    const app = renderer.createApp({ ...Page, render: () => null })
    app.provide(ssrContextKey, {})
    const vm = app.mount({})
    const state = (vm.$ as unknown as { setupState: Record<string, any> }).setupState
    const confirm = vi.fn().mockReturnValue(false)
    vi.stubGlobal('window', { confirm })
    try {
      state.password = '87654321'
      await state.unlock()
      await nextTick()
      expect(state.unlocked).toBe(true)
      expect(state.password).toBe('')
      state.lock()
      expect(state.unlocked).toBe(true)
      confirm.mockReturnValue(true)
      state.lock()
      expect(state.unlocked).toBe(false)
      expect(state.error).toBe('')
    } finally { app.unmount(); vi.unstubAllGlobals() }
  })

  it('restores access when returning to the page and forgets it after relocking', async () => {
    const Page = await getPage()
    const mountPage = () => {
      const app = renderer.createApp({ ...Page, render: () => null })
      app.provide(ssrContextKey, {})
      const vm = app.mount({})
      return { app, state: (vm.$ as unknown as { setupState: Record<string, any> }).setupState }
    }
    vi.stubGlobal('window', { confirm: () => true })
    const first = mountPage()
    try {
      await nextTick()
      first.state.password = '87654321'
      await first.state.unlock()
      expect(first.state.unlocked).toBe(true)
    } finally { first.app.unmount() }

    const returned = mountPage()
    try {
      await vi.waitFor(() => expect(returned.state.unlocked).toBe(true))
      returned.state.lock()
      expect(returned.state.unlocked).toBe(false)
    } finally { returned.app.unmount() }

    const locked = mountPage()
    try {
      await vi.waitFor(() => expect(locked.state.checkingAccess).toBe(false))
      expect(locked.state.unlocked).toBe(false)
    } finally { locked.app.unmount() }
  })
})
