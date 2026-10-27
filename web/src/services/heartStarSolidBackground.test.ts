import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const path = new URL('../../public/embedded/heart-star/solid-background.js', import.meta.url)
const scope: any = {}
new Function('globalThis', existsSync(path) ? readFileSync(path, 'utf8') : '')(scope)
function api() {
  expect(scope.HeartStarSolidBackground, 'solid-background processor is registered').toBeDefined()
  return scope.HeartStarSolidBackground
}
function image(rows: string[], colors: Record<string, number[]> = {}) {
  const palette = { w: [255, 255, 255, 255], b: [0, 0, 0, 255], t: [255, 255, 255, 0], ...colors }
  return { width: rows[0]!.length, height: rows.length,
    data: new Uint8ClampedArray(rows.flatMap(row => [...row].flatMap(char => palette[char as keyof typeof palette]!))) }
}
const alpha = (im: any) => Array.from(im.data).filter((_, i) => i % 4 === 3)

describe('solid background removal', () => {
  it('detects the majority corner color rather than a subject touching one corner', () => {
    expect(api().detect(image(['bww', 'wbw', 'www']))).toEqual([255, 255, 255])
    expect(api().detect(image(['tt', 'tt']))).toBeNull()
  })

  it('only removes edge-connected background, preserving enclosed same-colored details and the input', async () => {
    const input = image(['wwwww', 'wbbbw', 'wbwbw', 'wbbbw', 'wwwww'])
    const before = input.data.slice()
    const output = await api().remove(input, { color: [255, 255, 255], tolerance: 0, feather: 0 })
    expect(alpha(output)).toEqual([0, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0,
      0, 255, 255, 255, 0, 0, 0, 0, 0, 0])
    expect(input.data).toEqual(before)
    expect([output.width, output.height]).toEqual([5, 5])
  })

  it('uses a picked color and tolerance, retaining transparent and unrelated foreground pixels', async () => {
    const input = image(['ggg', 'gbg', 'tgg'], { g: [10, 180, 40, 255] })
    const output = await api().remove(input, { color: [12, 178, 41], tolerance: 3, feather: 0 })
    expect(alpha(output)).toEqual([0, 0, 0, 0, 255, 0, 0, 0, 0])
    expect(Array.from(output.data.slice(16, 20))).toEqual([0, 0, 0, 255])
  })

  it('softens only connected near-background edges without increasing existing alpha', async () => {
    const input = image(['wgab'], { g: [240, 240, 240, 255], a: [230, 230, 230, 80] })
    const output = await api().remove(input, { color: [255, 255, 255], tolerance: 5, feather: 20 })
    expect(alpha(output)).toEqual([0, 128, 80, 255])
  })

  it('preserves an already transparent image when auto detection finds no solid corner', async () => {
    const input = image(['tbt'])
    expect((await api().remove(input)).data).toEqual(input.data)
  })

  it('yields during large processing and supports cancellation without changing the source', async () => {
    const input = image(Array(300).fill('w'.repeat(300))), before = input.data.slice()
    let cancelled = false
    await expect(api().remove(input, { shouldCancel: () => cancelled,
      yieldControl: async () => { cancelled = true } })).rejects.toThrow(/取消/)
    expect(input.data).toEqual(before)
  })

  it('rejects malformed pixels and oversized images before allocation', async () => {
    await expect(api().remove({ width: 2, height: 2, data: new Uint8ClampedArray(4) })).rejects.toThrow()
    await expect(api().remove({ width: 10000, height: 10000, data: [] })).rejects.toThrow()
  })
})

function sessionSetup() {
  const a = { name: 'a' }, b = { name: 'b' }, states = [{ dx: 4 }, { dx: 9 }, { dx: 0 }]
  const photos = [a, a, b], applied: any[] = [], processed: any[] = []
  let token: any = states
  const store = api().createStore({
    getBoard: () => ({ token, ready: true, ids: [0, 1], photoAt: (id: number) => photos[id] }),
    apply: (items: any[]) => { applied.push(items); items.forEach(item => { photos[item.id] = item.image }) },
  })
  const processor = async (source: any, options: any) => {
    processed.push({ source, options }); return { result: source.name }
  }
  return { store, photos, a, b, applied, processed, processor, states, changeToken: () => { token = [] } }
}

describe('selected-photo solid background workflow', () => {
  it('processes a thumbnail target instead of the current selection and records its processed status', async () => {
    const s = sessionSetup(), session = s.store.begin([2])
    expect(session.entries.map((entry: any) => entry.ids)).toEqual([[2]])
    await s.store.apply(session, s.processor)
    expect(s.photos.slice(0, 2)).toEqual([s.a, s.a])
    expect(s.applied[0]).toEqual([{ id: 2, image: s.photos[2], processed: true }])
    expect(s.store.isProcessed(s.photos[2])).toBe(true)
    expect(s.store.isProcessed(s.b)).toBe(false)
    s.store.restore(s.store.begin([2]))
    expect(s.applied[1]).toEqual([{ id: 2, image: s.b, processed: false }])
    expect(s.store.isProcessed(s.photos[2])).toBe(false)
  })

  it('deduplicates repeated photos, applies only captured positions, and supports restoring originals', async () => {
    const s = sessionSetup(), session = s.store.begin()
    expect(session.entries).toHaveLength(1)
    await s.store.apply(session, s.processor)
    expect(s.processed).toHaveLength(1)
    expect(s.photos[0]).toBe(s.photos[1])
    expect(s.photos[2]).toBe(s.b)
    expect(s.states).toEqual([{ dx: 4 }, { dx: 9 }, { dx: 0 }])
    const reopened = s.store.begin()
    expect(reopened.entries[0].original).toBe(s.a)
    s.store.restore(reopened)
    expect(s.photos).toEqual([s.a, s.a, s.b])
  })

  it('never applies a partial batch if processing fails', async () => {
    const s = sessionSetup()
    s.photos[1] = s.b
    const session = s.store.begin()
    await expect(s.store.apply(session, async (original: any) => {
      if (original === s.b) throw Error('读取失败')
      return { done: true }
    })).rejects.toThrow('读取失败')
    expect(s.applied).toHaveLength(0)
    expect(s.photos).toEqual([s.a, s.b, s.b])
  })

  it('keeps individual settings and always reprocesses the original rather than erasing an edited result again', async () => {
    const s = sessionSetup()
    s.photos[1] = s.b
    const session = s.store.begin()
    session.entries[0].options.color = [0, 0, 0]
    session.entries[0].options.tolerance = 8
    session.entries[1].options.tolerance = 40
    await s.store.apply(session, s.processor)
    expect(s.processed.map(item => item.options.tolerance)).toEqual([8, 40])
    const reopened = s.store.begin()
    expect(reopened.entries[0].options).toMatchObject({ color: [0, 0, 0], tolerance: 8 })
    await s.store.apply(reopened, s.processor)
    expect(s.processed.slice(2).map(item => item.source)).toEqual([s.a, s.b])
  })

  it('ignores a stale dialog after template changes, photo replacement or cancellation', async () => {
    for (const cause of ['template', 'photo', 'cancel']) {
      const s = sessionSetup(), session = s.store.begin()
      await expect(s.store.apply(session, async () => {
        if (cause === 'template') s.changeToken()
        else if (cause === 'photo') s.photos[0] = s.b
        else s.store.cancel(session)
        return { done: true }
      })).rejects.toThrow()
      expect(s.applied).toHaveLength(0)
    }
  })
})
