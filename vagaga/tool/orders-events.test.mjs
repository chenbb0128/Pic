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
const editorSource = readFileSync(new URL('../public/embedded/heart-star/index.html', import.meta.url), 'utf8')
const templateLinkSource = readFileSync(new URL('../public/embedded/heart-star/template-link.js', import.meta.url), 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))
const image = id => ({ id, filePath: `D:/app/data/images/${id}.png`, thumbnailPath: null,
  originalName: `${id}.png`, byteLength: 100, width: 10, height: 10,
  source: '千帆', createdAt: '2026-11-19T12:00:00', templates: [] })
const order = (id, images = []) => ({ id, orderNumber: `ORDER-${id}`, images,
  imageCount: images.length, taskCount: 0, createdAt: '2026-11-19T12:00:00',
  updatedAt: '2026-11-19T12:00:00', metadata: null })

function editorFixture() {
  const between = (start, end) => editorSource.slice(editorSource.indexOf(start), editorSource.indexOf(end))
  const field = value => Object.assign(new EventTarget(), { value })
  const prefix = field('ch')
  prefix.options = ['ch', 'yy', 'x'].map(value => ({ value }))
  const input = field('')
  const output = { textContent: '' }
  const template = field('preset.png')
  template.options = ['preset.png', 'next.png'].map(value => ({ value }))
  const widthInput = field('144')
  const heightInput = field('210')
  const controls = {
    footerPrefix: prefix, footerText: input, exportFilename: output, template,
    numberingEnabled: { checked: true }, sheetTotal: { value: '1' }, sheetIndex: { value: '1' },
  }
  const photos = new Map()
  let selectedIds = [0]
  const images = []
  const downloads = []
  const posted = []
  const frame = Object.assign(new EventTarget(), {
    __picTemplateLoaded: true,
    parent: { __TAURI_INTERNALS__: {}, postMessage: data => posted.push(data) },
  })
  const canvas = { width: 1, height: 1, toBlob: done => done(new Blob(['fixture'])) }
  const dimensions = { totalW: 100, totalH: 100, dpi: 300 }
  const context = vm.createContext({
    window: frame, Event, File, TextEncoder, URLSearchParams, atob, btoa,
    setTimeout: (callback, delay) => setTimeout(callback, delay).unref(), clearTimeout,
    document: {
      getElementById: id => controls[id],
      createElement: () => ({ click() { downloads.push(this.download) } }),
    },
    Image: class { set src(value) { images.push(this) } },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    sel: template, templates: { 'preset.png': {}, 'next.png': { widthMm: 210, heightMm: 144 } }, states: [{}],
    widthInput, heightInput, photos: [], urls: [],
    photoUploadTarget: null, photoUploadBusy: false, replacementRequest: 0,
    replacementUrls: new Set(), replacedPhotos: photos,
    HeartStarBackground: { photoOnly: () => false },
    selectedPhotoTarget: () => ({
      template: template.value, states: context.states, request: context.replacementRequest, ids: selectedIds.slice(),
    }),
    HeartStarPreset: { selectSize(cfg, width, height) {
      width.value = String(cfg.widthMm)
      height.value = String(cfg.heightMm)
    } },
    draw() {}, updatePhotoControls() {}, finishPhotoDrag() {}, say() {},
    releaseUnusedReplacementUrls() {}, renderThumbs() {}, updateControls() {},
    canvas, exportBusy: false, outputConfig: () => dimensions, renderConfig: () => dimensions,
    portraitConfig: config => config, portraitCanvas: source => source, addDpiMetadata: async blob => blob,
    motifEditor: { busy: () => false }, slotBackgrounds: { busy: () => false },
    HeartStarWatermark: { preview: source => source },
  })
  const bridge = [...editorSource.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(([, source]) => source).find(source => source.includes('window.__picDoInject ='))
  vm.runInContext(templateLinkSource, context)
  vm.runInContext([
    between('const footerHeightMm=', 'function drawFooter('),
    between('async function setFiles(', 'function applySolidPhotos('),
    between('async function exportPng(', 'const customAssets='),
    bridge,
  ].join('\n'), context)
  return {
    frame, photos, images, prefix, input, output, downloads, posted, template, widthInput, heightInput,
    useSlots(count, ids) { context.states = Array.from({ length: count }, () => ({})); selectedIds = ids },
    exportPng: context.exportPng,
  }
}

test('the editor fills its actual numbering controls when the photo finishes loading', async () => {
  const editor = editorFixture()
  const { frame, photos, images, prefix, input, output } = editor
  const pending = frame.__picDoInject({
    b64: 'AA==', name: 'fixture.png', mime: 'image/png',
    template: 'preset.png', orderNumber: 'ORDER-one', layoutNumber: 'CH-0007a',
  })
  await flush()
  assert.equal(input.value, '')
  assert.equal(photos.size, 0)
  images.shift().onload()
  await pending
  assert.equal(photos.size, 1)
  assert.equal(prefix.value, 'ch')
  assert.equal(input.value, '0007a')
  assert.match(output.textContent, /^ch-\d{8}-0007a .*_preset_100x100mm_300dpi\.png$/)
})

test('the editor does not apply another order number when the image cannot be read', async () => {
  const { frame, images, input } = editorFixture()
  input.value = 'previous'
  const pending = frame.__picDoInject({
    b64: 'AA==', name: 'fixture.png', mime: 'image/png',
    template: 'preset.png', orderNumber: 'ORDER-second', layoutNumber: 'yy-0074',
  })
  await flush()
  images.shift().onerror()
  await assert.rejects(Promise.resolve(pending), /图片/)
  assert.equal(input.value, 'previous')
})

test('making waits for the current template before it starts loading the order image', async () => {
  const { frame, images, input } = editorFixture()
  frame.__picTemplateLoaded = false
  const pending = frame.__picDoInject({
    b64: 'AA==', name: 'fixture.png', mime: 'image/png',
    template: 'preset.png', orderNumber: 'ORDER-two', layoutNumber: 'x-002',
  })
  await flush()
  assert.equal(images.length, 0)
  frame.__picTemplateLoaded = true
  frame.dispatchEvent(new Event('pic-template-ready'))
  await flush()
  assert.equal(images.length, 1)
  images.shift().onload()
  await pending
  assert.equal(input.value, '002')
})

test('the embedded editor switches templates and sizes before injecting on its existing page', async () => {
  const { frame, images, input, template, widthInput, heightInput } = editorFixture()
  template.addEventListener('change', () => { frame.__picTemplateLoaded = false })
  const pending = frame.__picDoInject({
    b64: 'AA==', name: 'fixture.png', mime: 'image/png',
    template: 'next.png', orderNumber: 'ORDER-two', layoutNumber: 'yy-0009',
  })
  await flush()
  assert.equal(template.value, 'next.png')
  assert.equal(widthInput.value, '210')
  assert.equal(heightInput.value, '144')
  assert.equal(images.length, 0)
  frame.__picTemplateLoaded = true
  frame.dispatchEvent(new Event('pic-template-ready'))
  await flush()
  images.shift().onload()
  await pending
  assert.equal(input.value, '0009')
})

test('making another order replaces all slots even when the previous order had only one slot selected', async () => {
  const { frame, photos, images, useSlots } = editorFixture()
  useSlots(2, [0])
  const make = async orderNumber => {
    const pending = frame.__picDoInject({
      b64: 'AA==', name: 'fixture.png', mime: 'image/png', template: 'preset.png', orderNumber,
    })
    await flush()
    const decoded = images.shift()
    decoded.onload()
    await pending
    return decoded
  }
  const firstImage = await make('ORDER-one')
  assert.equal(photos.get(1).image, firstImage)
  const revisedImage = await make('ORDER-one')
  assert.equal(photos.get(0).image, revisedImage)
  assert.equal(photos.get(1).image, firstImage)
  const nextImage = await make('ORDER-two')
  assert.equal(photos.get(0).image, nextImage)
  assert.equal(photos.get(1).image, nextImage)
})

test('formal PNG download clears the saved draft after the watermarked preview preserves it', async () => {
  const { frame, images, input, downloads, posted, exportPng } = editorFixture()
  const pending = frame.__picDoInject({
    b64: 'AA==', name: 'fixture.png', mime: 'image/png',
    template: 'preset.png', orderNumber: 'ORDER-one', imageId: 'photo-one', layoutNumber: 'ch-001',
  })
  await flush()
  images.shift().onload()
  await pending
  input.value = '0009'
  input.dispatchEvent(new Event('input'))
  await exportPng(true)
  assert.match(downloads[0], /^ch-\d{8}-0009 .*_水印预览\.png$/)
  assert.equal(posted.length, 0)
  assert.equal(frame.__picReadOrderNumbering().value, '0009')
  await exportPng()
  assert.match(downloads[1], /^ch-\d{8}-0009 .*_preset_100x100mm_300dpi\.png$/)
  assert.equal(posted[0].orderNumber, 'ORDER-one')
  assert.equal(posted[0].imageId, 'photo-one')
  assert.equal(input.value, '')
  assert.equal(frame.__picReadOrderNumbering(), null)
})

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
  const frame = { async __picDoInject() {} }
  view.frame.value = vue.markRaw({ contentWindow: frame })
  view.editorSrc.value = '/embedded/heart-star/index.html'
  view.editorReady.value = true
  await view.injectImage({ ...image('scaled'), sourceQuality: 'scaled' }, order('scaled'))
  assert.equal(view.lastInjectedOrder.value, null)
  assert.match(view.status.value, /原图/)
  await view.injectImage({ ...image('unknown'), sourceQuality: 'unknown' }, order('unknown'))
  assert.equal(view.lastInjectedOrder.value, null)
  await view.injectImage({ ...image('original'), sourceQuality: 'original' }, order('one'))
  env.fetchImage(async () => ({ ok: false, status: 404 }))
  await view.injectImage({ ...image('missing'), sourceQuality: 'original' }, order('missing'), 'new-template')
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
  await view.injectImage(image('historical'), order('historical'))
  assert.equal(view.lastInjectedOrder.value, 'ORDER-historical')
  await view.onMessage({ source: frame, data: {
    type: 'pic-make-exported', orderNumber: 'ORDER-one', imageId: 'original', b64: 'previous png',
  } })
  assert.equal(env.savedProductions.at(-1).orderNumber, 'ORDER-one')
  assert.equal(env.savedProductions.at(-1).imageId, 'original')
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

test('making uses the clicked order remark and restores that order’s deliberately blank draft', async t => {
  const env = environment(t)
  await env.store.refreshQiniuStatus()
  env.rows([
    { ...order('one'), metadata: '{"layoutNumber":"CH-00123"}' },
    order('two'),
  ])
  await env.store.loadOrders()
  env.fetchImage(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }))
  const view = await env.mountView()
  const { frame, images, input, prefix } = editorFixture()
  view.frame.value = vue.markRaw({ contentWindow: frame })
  view.editorSrc.value = '/embedded/heart-star/index.html'
  view.editorReady.value = true
  const make = async summary => {
    const pending = view.injectImage(image('fixture'), summary)
    await flush()
    assert.equal(view.busyImageId.value, 'fixture')
    images.shift().onload()
    await pending
  }
  const [first, second] = view.visibleEntries.value.map(entry => entry.summary)
  await make(first)
  assert.equal(input.value, '00123')
  view.chooseOrder(second.id)
  assert.equal(view.lastInjectedOrder.value, 'ORDER-one')
  assert.equal(input.value, '00123')
  prefix.value = 'x'
  prefix.dispatchEvent(new Event('input'))
  input.value = ''
  input.dispatchEvent(new Event('input'))
  await make(second)
  assert.equal(view.lastInjectedOrder.value, 'ORDER-two')
  assert.equal(prefix.value, 'ch')
  assert.equal(input.value, '')
  await make(first)
  assert.equal(view.lastInjectedOrder.value, 'ORDER-one')
  assert.equal(prefix.value, 'x')
  assert.equal(input.value, '')
})

test('making with different templates reuses the already loaded editor', async t => {
  const env = environment(t)
  await env.store.refreshQiniuStatus()
  env.fetchImage(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }))
  const view = await env.mountView()
  const received = []
  const frame = { async __picDoInject(data) { received.push(data) } }
  view.openEditor()
  const source = view.editorSrc.value
  view.frame.value = vue.markRaw({ contentWindow: frame })
  view.onFrameLoad()
  for (const template of ['模板爱心.png', '爱心横版.png', '爱心横版.png']) {
    const pending = view.injectImage(image(template), order('one'), template)
    await flush()
    assert.equal(view.editorSrc.value, source)
    assert.equal(view.editorReady.value, true)
    await pending
  }
  assert.deepEqual(Array.from(received, data => data.template), ['模板爱心.png', '爱心横版.png', '爱心横版.png'])
})
