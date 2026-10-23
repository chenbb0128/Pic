import { describe, expect, it } from 'vitest'
import source from '../../public/embedded/heart-star/cloud-library.js?raw'

function setup(fetcher: any) {
  const scope: any = {}
  new Function('globalThis', source)(scope)
  return scope.HeartStarCloud.createClient(fetcher)
}
describe('shared library client', () => {
  it('includes the full result reference in the same versioned project save', async () => {
    let sent: any
    const client = setup(async (path: string, options: any) => {
      sent = { path, method: options.method, body: JSON.parse(options.body) }
      return { ok: true, json: async () => ({ data: { version: 3 } }) }
    })
    await client.save('project', { id: 'project', version: 2 }, '作品', { photos: [] }, 'a'.repeat(32), 'b'.repeat(32))
    expect(sent).toEqual({ path: '/api/v1/projects/project', method: 'PUT', body: {
      name: '作品', version: 2, snapshot: { photos: [] }, thumbnailId: 'a'.repeat(32), resultId: 'b'.repeat(32),
    } })
  })
  it('downloads the private PNG bytes rather than the preview or a JSON response', async () => {
    const png = new Blob(['png-bytes'], { type: 'image/png' })
    let sent: any
    const client = setup(async (path: string, options: any) => {
      sent = { path, ...options }; return { ok: true, blob: async () => png }
    })
    expect(await client.asset('b'.repeat(32))).toBe(png)
    expect(sent.path).toBe('/api/v1/assets/' + 'b'.repeat(32))
    expect(sent.credentials).toBe('same-origin')
    const denied = setup(async () => ({ ok: false, status: 401, json: async () => ({ message: '请重新登录' }) }))
    await expect(denied.asset('b'.repeat(32))).rejects.toMatchObject({ status: 401 })
    const fallback = setup(async () => ({ ok: true, blob: async () => new Blob(['<html>'], { type: 'text/html' }) }))
    await expect(fallback.asset('b'.repeat(32))).rejects.toThrow()
  })
  it('sends thumbnail as a private asset reference and encodes literal search text', async () => {
    const calls: any[] = []
    const client = setup(async (path: string, options: any) => {
      calls.push({ path, ...options }); return { ok: true, json: async () => ({ data: [] }) }
    })
    await client.save('project', null, '订单', { photos: [] }, '0123456789abcdef0123456789abcdef')
    expect(JSON.parse(calls[0].body)).toMatchObject({ thumbnailId: '0123456789abcdef0123456789abcdef' })
    await client.list('project', 50, '订单 %_&')
    expect(calls[1].path).toBe('/api/v1/projects?offset=50&q=%E8%AE%A2%E5%8D%95%20%25_%26')
  })
  it('updates only the explicit document version and never auto-retries a conflict', async () => {
    const calls: any[] = [], client = setup(async (path: string, options: any) => {
      calls.push({ path, ...options })
      return { ok: false, status: 409, json: async () => ({ message: '其他人已修改' }) }
    })
    await expect(client.save('project', { id: 'abc', version: 7 }, 'name', { editor: 'heart-star' })).rejects.toMatchObject({ status: 409 })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].path).toBe('/api/v1/projects/abc')
    expect(JSON.parse(calls[0].body)).toEqual({ name: 'name', version: 7, snapshot: { editor: 'heart-star' } })
    expect(calls[0].credentials).toBe('same-origin')
  })
  it('creates a separate file without an old document id or version', async () => {
    let sent: any
    const client = setup(async (path: string, options: any) => {
      sent = { path, body: JSON.parse(options.body) }
      return { ok: true, json: async () => ({ data: { id: 'new', version: 1 } }) }
    })
    await expect(client.save('template', null, 'new template', { photos: [null] })).resolves.toEqual({ id: 'new', version: 1 })
    expect(sent).toEqual({ path: '/api/v1/templates', body: { name: 'new template', version: 0, snapshot: { photos: [null] } } })
  })
  it('reports an unavailable service instead of treating the Vite HTML fallback as a saved project', async () => {
    const client = setup(async () => ({ ok: true, json: async () => { throw Error('HTML') } }))
    await expect(client.request('/session')).rejects.toThrow('服务')
  })
})
