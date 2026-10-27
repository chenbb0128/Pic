import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearHeartStarAccess, hasHeartStarAccess, rememberHeartStarAccess } from './heartStarAccess'

describe('server verified heart-star access', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('checks the backend session instead of trusting a browser unlock record', async () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ expiresAt: Date.now() + 86400000 }), removeItem() {} })
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 401, message: '访问已过期' }), { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await hasHeartStarAccess()).toBe(false)
    fetcher.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { username: 'staff' } })))
    expect(await hasHeartStarAccess()).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('/api/v1/session', expect.objectContaining({ credentials: 'same-origin', method: 'GET' }))
  })

  it('exchanges only the entered tool password for an HttpOnly shared session', async () => {
    const records = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => { records.set(key, value) },
      removeItem: (key: string) => { records.delete(key) },
    })
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { username: 'staff' } })))
    vi.stubGlobal('fetch', fetcher)
    await rememberHeartStarAccess('store-tool-password')
    expect(fetcher).toHaveBeenCalledWith('/api/v1/tool-session', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'store-tool-password' }),
    }))
    expect([...records.values()].join('')).not.toContain('store-tool-password')
  })

  it('does not grant access for rejected passwords or unavailable services', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 401, message: '密码错误' }), { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(rememberHeartStarAccess('wrong')).rejects.toMatchObject({ status: 401, message: '密码错误' })
    fetcher.mockRejectedValue(new TypeError('network down'))
    await expect(hasHeartStarAccess()).rejects.toThrow('服务')
    await expect(rememberHeartStarAccess('store-tool-password')).rejects.toThrow('服务')
  })

  it('rejects a static HTML fallback instead of treating it as an authenticated session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('<html>SPA fallback</html>')))
    await expect(hasHeartStarAccess()).rejects.toThrow('服务')
  })

  it('revokes the server session when locking and propagates logout failures', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: null })))
    vi.stubGlobal('fetch', fetcher)
    await clearHeartStarAccess()
    expect(fetcher).toHaveBeenCalledWith('/api/v1/session', expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }))
    fetcher.mockRejectedValue(new TypeError('network down'))
    await expect(clearHeartStarAccess()).rejects.toThrow('服务')
  })

  it('still unlocks with a server cookie when browser storage is unavailable', async () => {
    vi.stubGlobal('localStorage', { removeItem() { throw Error('Storage disabled') } })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: { username: 'staff' } }))))
    await expect(rememberHeartStarAccess('store-tool-password')).resolves.toBeUndefined()
    expect(await hasHeartStarAccess()).toBe(true)
  })
})
