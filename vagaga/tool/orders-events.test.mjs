import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'

const storeSource = readFileSync(new URL('../src/stores/orders.ts', import.meta.url), 'utf8')
const viewSource = compileScript(parse(readFileSync(
  new URL('../src/views/OrdersView.vue', import.meta.url), 'utf8',
)).descriptor, { id: 'orders-events-test' }).content
const flush = () => new Promise(resolve => setImmediate(resolve))
const image = id => ({ id, filePath: `D:/app/data/images/${id}.png`, thumbnailPath: null,
  originalName: `${id}.png`, byteLength: 100, width: 10, height: 10,
  source: '千帆', createdAt: '2026-11-19T12:00:00', templates: [] })
const order = (id, images = []) => ({ id, orderNumber: `ORDER-${id}`, images,
  imageCount: images.length, taskCount: 0, createdAt: '2026-11-19T12:00:00',
  updatedAt: '2026-11-19T12:00:00', metadata: null })

function environment(t) {
  let rows = [], timerId = 0, delayedDetail = null
  let productions = [], qiniuStatus = { enabled: false, legacyEnabled: true }, fetchImage
  const handlers = { ingested: new Set(), failed: new Set(), cloud: new Set() }
  const intervals = new Map()
  const mounted = [], unmounted = [], scopes = []
  const savedProductions = []
  const subscribe = name => async callback => {
    handlers[name].add(callback)
    return () => handlers[name].delete(callback)
  }
  const api = {
    onIngested: subscribe('ingested'), onFailed: subscribe('failed'), onCloudImported: subscribe('cloud'),
    listOrders: async () => structuredClone(rows.map(({ images, ...summary }) => summary)),
    getOrder: async id => {
      const snapshot = structuredClone(rows.find(row => row.id === id) ?? null)
      if (delayedDetail) {
        const delay = delayedDetail
        delayedDetail = null
        await delay
      }
      return snapshot
    },
    getQiniuStatus: async () => qiniuStatus,
    listProductions: async orderNumber => structuredClone(productions.filter(p => p.orderNumber === orderNumber)),
    saveProduction: async (orderNumber, dataB64, fileName, imageId) => {
      savedProductions.push({ orderNumber, dataB64, fileName, imageId })
      const production = { id: 'finished', orderNumber, filePath: fileName, syncStatus: 'pending' }
      productions = [production]
      return production
    },
    assetUrl: path => path,
  }
  function evaluate(source, dependencies) {
    const module = { exports: {} }
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText
    vm.runInNewContext(code, {
      module, exports: module.exports,
      require: name => {
        if (name in dependencies) return dependencies[name]
        throw new Error(`Unexpected import ${name}`)
      },
      setTimeout: () => ++timerId,
      setInterval: callback => { const id = ++timerId; intervals.set(id, callback); return id },
      clearInterval: id => intervals.delete(id),
      window: { addEventListener() {}, removeEventListener() {} },
      fetch: (...args) => fetchImage(...args),
      createImageBitmap: async () => ({ close() {} }),
      btoa,
      console,
    })
    return module.exports
  }
  const store = evaluate(storeSource, { vue, '../lib/tauri': api })
  const env = {
    store, handlers, intervals, savedProductions,
    rows(value) { rows = value },
    productions(value) { productions = value },
    qiniuStatus(value) { qiniuStatus = value },
    fetchImage(value) { fetchImage = value },
    delayNextDetail() {
      let release
      delayedDetail = new Promise(resolve => { release = resolve })
      return release
    },
    async emit(event) {
      await Promise.all([...handlers[event.kind]].map(callback => callback(event)))
      await flush()
    },
    async mountView() {
      const component = evaluate(viewSource, {
        vue: { ...vue, onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmounted.push(callback) },
        '../stores/orders': store, '../lib/tauri': api,
      }).default
      const scope = vue.effectScope()
      scopes.push(scope)
      const view = scope.run(() => component.setup({}, { expose() {} }))
      for (const mount of mounted.splice(0)) await mount()
      await flush()
      return view
    },
  }
  t.after(() => {
    for (const unmount of unmounted) unmount()
    for (const scope of scopes) scope.stop()
    intervals.clear()
  })
  return env
}

test('repeated event binding produces one toast and one polling timer', async t => {
  const env = environment(t)
  env.rows([order('one', [image('photo')])])
  await Promise.all([env.store.bindEvents(), env.store.bindEvents(), env.store.bindEvents()])
  assert.equal(env.handlers.ingested.size, 1)
  assert.equal(env.intervals.size, 1)
  await env.emit({ kind: 'ingested', orderNumber: 'ORDER-one', imageId: 'photo', scaled: false })
  assert.equal(env.store.useOrdersStore().toasts.length, 1)
  assert.match(env.store.useOrdersStore().toasts[0].text, /ORDER-one/)
})

test('a newly captured order is selected after its refreshed list arrives', async t => {
  const env = environment(t)
  env.rows([order('old')])
  await env.store.loadOrders()
  await env.store.bindEvents()
  env.rows([order('new', [image('new-photo')]), order('old')])
  await env.emit({ kind: 'ingested', orderNumber: 'ORDER-new', imageId: 'new-photo' })
  assert.equal(env.store.useOrdersStore().selectedId, 'new')
  assert.equal(env.store.useOrdersStore().detail.images[0].id, 'new-photo')
})

test('unbinding stops listeners and polling, then allows a clean rebind', async t => {
  const env = environment(t)
  const stop = await env.store.bindEvents()
  assert.equal(typeof stop, 'function')
  stop()
  stop()
  assert.equal(env.handlers.ingested.size + env.handlers.failed.size + env.handlers.cloud.size, 0)
  assert.equal(env.intervals.size, 0)
  await env.store.bindEvents()
  assert.equal(env.handlers.ingested.size, 1)
  assert.equal(env.intervals.size, 1)
})

test('a second capture for the same order updates the visible sidebar images', async t => {
  const env = environment(t)
  env.rows([order('one', [image('first')])])
  await env.store.bindEvents()
  await env.store.loadOrders()
  const view = await env.mountView()
  assert.equal(view.entries.value[0].images.length, 1)
  env.rows([order('one', [image('first'), image('second')])])
  await env.emit({ kind: 'ingested', orderNumber: 'ORDER-one', imageId: 'second' })
  assert.equal(view.entries.value[0].images.length, 2)
  assert.equal(env.handlers.ingested.size, 1)
})

test('a slow older sidebar refresh cannot replace newer captured images', async t => {
  const env = environment(t)
  env.rows([order('one', [image('first')])])
  await env.store.loadOrders()
  const view = await env.mountView()
  const release = env.delayNextDetail()
  const staleRefresh = view.refreshSources()
  await flush()
  env.rows([order('one', [image('first'), image('second')])])
  await env.store.loadOrders()
  await flush()
  release()
  await staleRefresh
  await flush()
  assert.equal(view.entries.value[0].images.length, 2)
})

test('production rows refresh after a cloud update for an already opened order', async t => {
  const env = environment(t)
  env.rows([order('one')])
  await env.store.bindEvents()
  await env.store.loadOrders()
  const view = await env.mountView()
  assert.equal(view.orderProductions('ORDER-one').length, 0)
  env.productions([{ id: 'finished', orderNumber: 'ORDER-one', syncStatus: 'synced' }])
  await Promise.all([...env.handlers.cloud].map(callback => callback({
    payload: { orderNumber: 'ORDER-one', newImages: 0, newProductions: 1 },
  })))
  await flush()
  assert.equal(view.orderProductions('ORDER-one')[0]?.syncStatus, 'synced')
})

test('Qiniu production checks the local original and exports with its source image ID', async t => {
  const env = environment(t)
  env.qiniuStatus({ enabled: true, legacyEnabled: false, role: 'production' })
  env.fetchImage(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }))
  await env.store.refreshQiniuStatus()
  const view = await env.mountView()
  const frame = { __picTemplateLoaded: true, __picDoInject() {} }
  view.frame.value = vue.markRaw({ contentWindow: frame })
  view.editorSrc.value = '/embedded/heart-star/index.html'
  view.editorReady.value = true
  await view.injectImage({ ...image('scaled'), sourceQuality: 'scaled' }, 'ORDER-scaled')
  assert.equal(view.lastInjectedOrder.value, null)
  assert.match(view.status.value, /原图/)
  await view.injectImage({ ...image('unknown'), sourceQuality: 'unknown' }, 'ORDER-unknown')
  assert.equal(view.lastInjectedOrder.value, null)
  await view.injectImage({ ...image('original'), sourceQuality: 'original' }, 'ORDER-one')
  await view.onMessage({ source: frame, data: { type: 'pic-make-done' } })
  env.fetchImage(async () => ({ ok: false, status: 404 }))
  await view.injectImage({ ...image('missing'), sourceQuality: 'original' }, 'ORDER-missing', 'new-template')
  assert.equal(view.editorSrc.value, '/embedded/heart-star/index.html')
  assert.equal(view.lastInjectedOrder.value, 'ORDER-one')
  await view.onMessage({ source: frame, data: { type: 'pic-make-exported', b64: 'png', fileName: '成品.png' } })
  assert.equal(env.savedProductions[0]?.imageId, 'original')
  assert.match(view.exportStatus.value, /本地.*待回传/)
  env.productions([{ id: 'finished', orderNumber: 'ORDER-one', syncStatus: 'synced' }])
  env.rows([order('one')])
  await env.store.loadOrders()
  await flush()
  assert.match(view.exportStatus.value, /已同步服务器/)
  env.fetchImage(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }))
  await view.injectImage(image('historical'), 'ORDER-historical')
  await view.onMessage({ source: frame, data: { type: 'pic-make-done' } })
  assert.equal(view.lastInjectedOrder.value, 'ORDER-historical')
})

test('local order search matches partial order numbers and layout codes', async t => {
  const env = environment(t)
  env.rows([
    { ...order('First491'), metadata: '{"layoutNumber":"yy-008"}' },
    order('Second872'),
  ])
  await env.store.loadOrders()
  const view = await env.mountView()
  view.orderSearch.value = ' 491 '
  await flush()
  assert.equal(view.visibleEntries.value.map(entry => entry.summary.id).join(','), 'First491')
  view.orderSearch.value = 'YY-00'
  await flush()
  assert.equal(view.visibleEntries.value.map(entry => entry.summary.id).join(','), 'First491')
  view.orderSearch.value = ''
  await flush()
  assert.equal(view.visibleEntries.value.length, 2)
})

test('making receives the order number, the remark code and the corresponding manual draft', async t => {
  const env = environment(t)
  await env.store.refreshQiniuStatus()
  env.rows([
    { ...order('one'), metadata: '{"layoutNumber":"yy-00123"}' },
    order('two'),
  ])
  await env.store.loadOrders()
  env.fetchImage(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }))
  const view = await env.mountView()
  const injections = []
  let edited = null
  const frame = {
    __picTemplateLoaded: true,
    __picDoInject: data => injections.push(data),
    __picReadOrderNumbering: () => edited,
  }
  view.frame.value = vue.markRaw({ contentWindow: frame })
  view.editorSrc.value = '/embedded/heart-star/index.html'
  view.editorReady.value = true
  const make = async number => {
    await view.injectImage(image('fixture'), number)
    await view.onMessage({ source: frame, data: { type: 'pic-make-done' } })
  }
  await make('ORDER-one')
  assert.equal(injections[0].orderNumber, 'ORDER-one')
  assert.equal(injections[0].layoutNumber, 'yy-00123')
  edited = { orderNumber: 'ORDER-one', prefix: 'x', value: '009' }
  await make('ORDER-two')
  assert.equal(injections[1].layoutNumber, null)
  assert.equal(injections[1].numberingDraft, undefined)
  edited = null
  await make('ORDER-one')
  assert.equal(injections[2].numberingDraft.prefix, 'x')
  assert.equal(injections[2].numberingDraft.value, '009')
})
