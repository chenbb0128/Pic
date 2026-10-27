import { compile, createRenderer, createSSRApp, markRaw, nextTick, ssrContextKey } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createMemoryHistory } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from '../router'
import pageSource from './HeartStarPage.vue?raw'

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
    let authenticated = false
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit = {}) => {
      if (path === '/api/v1/tool-session') {
        authenticated = JSON.parse(String(options.body)).password === '87654321'
        return new Response(JSON.stringify(authenticated ? { code: 0, data: { username: 'staff' } } : { code: 401, message: '密码错误，请重新输入。' }), { status: authenticated ? 200 : 401 })
      }
      if (path === '/api/v1/session') {
        if (options.method === 'DELETE') { authenticated = false; return new Response(JSON.stringify({ code: 0, data: null })) }
        return new Response(JSON.stringify(authenticated ? { code: 0, data: { username: 'staff' } } : { code: 401, message: '访问已过期' }), { status: authenticated ? 200 : 401 })
      }
      throw Error('Unexpected request: ' + path)
    }))
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

  it('unlocks the embedded tool after backend verification', async () => {
    const html = await renderPage('87654321')
    expect(html).toContain('<iframe')
    expect(html).toMatch(/src="\/embedded\/heart-star\/index\.html\?v=[^"\s]+"/)
    expect(html).toContain('allow-downloads')
    expect(html).toContain('allow-forms')
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('87654321')
  })

  it('accepts a changed server password without a frontend release', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { username: 'staff' } }))))
    const html = await renderPage('new-server-password')
    expect(html).toContain('<iframe')
    expect(html).not.toContain('new-server-password')
  })

  it('keeps the password form when the verification service is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')))
    const html = await renderPage('87654321')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('服务暂不可用')
  })

  it('opens and closes the shortcut guide from the header without recreating the editing iframe', async () => {
    const Page = await getPage()
    const nodes: any[] = []
    const host = createRenderer<any, any>({
      patchProp(node, key, _previous, value) { node.props[key] = value },
      insert() {}, remove() {}, setText() {}, setElementText(node, text) { node.text = text },
      createElement(tag) {
        const node = { tag, props: {} as Record<string, any>, open: false, addEventListener() {},
          showModal() { this.open = true }, close() { this.open = false },
          getBoundingClientRect: () => ({ left: 100, top: 100, right: 600, bottom: 600 }),
        }
        nodes.push(node)
        return markRaw(node)
      },
      createText: () => ({ props: {} }), createComment: () => ({ props: {} }),
      parentNode: () => null, nextSibling: () => null,
    })
    const template = pageSource.slice(pageSource.indexOf('<template>') + 10, pageSource.indexOf('</template>'))
    const app = host.createApp({ ...Page, render: compile(template),
      setup(props: any, context: any) { return { ...Page.setup(props, context) } },
    })
    app.provide(ssrContextKey, {})
    const vm = app.mount({})
    const state = (vm.$ as unknown as { setupState: Record<string, any> }).setupState
    try {
      await vi.waitFor(() => expect(state.checkingAccess).toBe(false))
      state.password = '87654321'
      await state.unlock()
      await nextTick()
      const iframe = nodes.find(node => node.tag === 'iframe')
      const button = nodes.find(node => node.props['aria-controls'] === 'heart-star-shortcut-guide')
      expect(button).toBeDefined()
      const dialog = nodes.find(node => node.tag === 'dialog')
      expect(dialog.open).toBe(false)
      button.props.onClick()
      expect(dialog.open).toBe(true)
      expect(nodes.some(node => node.text === 'Esc')).toBe(true)
      expect(nodes.some(node => node.text === 'Alt + 滚轮')).toBe(true)
      dialog.props.onClick({ target: dialog, clientX: 150, clientY: 150 })
      expect(dialog.open).toBe(true)
      dialog.props.onClick({ target: dialog, clientX: 50, clientY: 50 })
      expect(dialog.open).toBe(false)
      button.props.onClick()
      nodes.find(node => node.props['aria-label'] === '关闭快捷键指南').props.onClick()
      expect(dialog.open).toBe(false)
      await nextTick()
      expect(nodes.filter(node => node.tag === 'iframe')).toEqual([iframe])
      expect(state.unlocked).toBe(true)
    } finally { app.unmount() }
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
      await vi.waitFor(() => expect(state.checkingAccess).toBe(false))
      state.password = '87654321'
      await state.unlock()
      await nextTick()
      expect(state.unlocked).toBe(true)
      expect(state.password).toBe('')
      await state.lock()
      expect(state.unlocked).toBe(true)
      confirm.mockReturnValue(true)
      await state.lock()
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
      await vi.waitFor(() => expect(first.state.checkingAccess).toBe(false))
      first.state.password = '87654321'
      await first.state.unlock()
      expect(first.state.unlocked).toBe(true)
    } finally { first.app.unmount() }

    const returned = mountPage()
    try {
      await vi.waitFor(() => expect(returned.state.unlocked).toBe(true))
      await returned.state.lock()
      expect(returned.state.unlocked).toBe(false)
    } finally { returned.app.unmount() }

    const locked = mountPage()
    try {
      await vi.waitFor(() => expect(locked.state.checkingAccess).toBe(false))
      expect(locked.state.unlocked).toBe(false)
    } finally { locked.app.unmount() }
  })

  it('preserves the editor if the server cannot revoke its session', async () => {
    const Page = await getPage()
    const app = renderer.createApp({ ...Page, render: () => null })
    app.provide(ssrContextKey, {})
    const vm = app.mount({})
    const state = (vm.$ as unknown as { setupState: Record<string, any> }).setupState
    vi.stubGlobal('window', { confirm: () => true })
    try {
      await vi.waitFor(() => expect(state.checkingAccess).toBe(false))
      state.password = '87654321'
      await state.unlock()
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')))
      await state.lock()
      expect(state.unlocked).toBe(true)
      expect(state.checkingAccess).toBe(false)
      expect(state.locking).toBe(false)
      expect(state.error).toContain('服务暂不可用')
    } finally { app.unmount() }
  })
})
