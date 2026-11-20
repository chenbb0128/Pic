import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/embedded/heart-star/ai-cutout.js', import.meta.url), 'utf8')

function bridge() {
  const listeners = new Set()
  const timers = new Map()
  const requests = []
  let now = 0, sequence = 0
  const scope = {
    window: {
      parent: { __TAURI_INTERNALS__: {}, postMessage: data => requests.push(data) },
      addEventListener: (_, listener) => listeners.add(listener),
      removeEventListener: (_, listener) => listeners.delete(listener),
    },
    setTimeout: (callback, delay) => {
      const id = ++sequence
      timers.set(id, { callback, at: now + delay })
      return id
    },
    clearTimeout: id => timers.delete(id),
  }
  // Expose the actual transport inside its closure, without calling a real API.
  vm.runInNewContext(source.replace(
    'globalThis.HeartStarAICutout = { mount };',
    'globalThis.HeartStarAICutout = { mount, tauriCutout };',
  ), scope)
  return {
    request: () => scope.HeartStarAICutout.tauriCutout('input'),
    send(data) { for (const listener of [...listeners]) listener({ data }) },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback() }
      }
    },
    get id() { return requests.at(-1).id },
    get listeners() { return listeners.size },
    get timers() { return timers.size },
  }
}

test('a 45-second cutout succeeds instead of being discarded at 30 seconds', async () => {
  const b = bridge()
  const result = b.request()
  const outcome = result.then(value => ({ value }), error => ({ error: error.message }))
  b.advance(45_000)
  b.send({ type: 'pic-cutout-response', id: b.id, pngB64: 'output' })
  assert.deepEqual(await outcome, { value: 'output' })
  assert.equal(b.listeners, 0)
  assert.equal(b.timers, 0)
})

test('backend timeout configuration extends the bridge deadline', async () => {
  const b = bridge()
  const result = b.request()
  const outcome = result.then(value => ({ value }), error => ({ error: error.message }))
  b.send({ type: 'pic-cutout-started', id: b.id, timeoutMs: 615_000 })
  b.advance(300_000)
  b.send({ type: 'pic-cutout-response', id: b.id, pngB64: 'configured-output' })
  assert.deepEqual(await outcome, { value: 'configured-output' })
  assert.equal(b.timers, 0)
})

test('backend errors are returned and both listener and deadline are removed', async () => {
  const b = bridge()
  const result = b.request()
  b.send({ type: 'pic-cutout-response', id: b.id, error: 'HTTP 429' })
  await assert.rejects(result, /HTTP 429/)
  assert.equal(b.listeners, 0)
  assert.equal(b.timers, 0)
})

test('an unanswered request times out and ignores unrelated responses', async () => {
  const b = bridge()
  const result = b.request()
  b.send({ type: 'pic-cutout-response', id: 'unrelated', pngB64: 'wrong' })
  b.advance(210_000)
  await assert.rejects(result, /超时/)
  assert.equal(b.listeners, 0)
  assert.equal(b.timers, 0)
})
