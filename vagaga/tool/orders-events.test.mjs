import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import * as icons from '@lucide/vue'
import { parse, compileScript } from 'vue/compiler-sfc'

const storeSource = readFileSync(new URL('../src/stores/orders.ts', import.meta.url), 'utf8')
const viewSource = compileScript(parse(readFileSync(
  new URL('../src/views/OrdersView.vue', import.meta.url), 'utf8',
)).descriptor, { id: 'orders-events-test' }).content
const workflowSource = compileScript(parse(readFileSync(
  new URL('../src/components/WorkflowDialog.vue', import.meta.url), 'utf8',
)).descriptor, { id: 'workflow-dialog-test' }).content
const editorSource = readFileSync(new URL('../public/embedded/heart-star/index.html', import.meta.url), 'utf8')
const templateLinkSource = readFileSync(new URL('../public/embedded/heart-star/template-link.js', import.meta.url), 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))
const image = id => ({ id, filePath: `D:/app/data/images/${id}.png`, thumbnailPath: null,
  originalName: `${id}.png`, byteLength: 100, width: 10, height: 10,
  source: '千帆', createdAt: '2026-11-19T12:00:00', remark: '', templates: [] })
const order = (id, images = []) => ({ id, orderNumber: `ORDER-${id}`, images,
  imageCount: images.length, createdAt: '2026-11-19T12:00:00',
  updatedAt: '2026-11-19T12:00:00', metadata: null })

test('the embedded editor offers the latest presets, lighting and direct photo controls', () => {
  for (const template of ['草莓.png', '圣诞.png']) {
    assert.ok(editorSource.includes(`<option value="${template}">`), template)
  }
  for (const script of ['strawberry-template.js', 'christmas-template.js', 'photo-lighting.js', 'photo-lighting-controls.js']) {
    assert.ok(editorSource.includes(`src="./${script}?`), script)
    assert.ok(readFileSync(new URL(`../public/embedded/heart-star/${script}`, import.meta.url)).length)
  }
  assert.match(editorSource, /id="photoLightingCompact"/)
  assert.match(editorSource, /id="photoScaleNumber"[^>]*type="number"/)
  assert.ok(editorSource.includes("previewPanel.addEventListener('drop',onPreviewDrop)"))
  const toolbar = editorSource.match(/<header class="editor-toolbar"[^>]*>([\s\S]*?)<\/header>/)?.[1]
  assert.ok(toolbar?.includes('id="sheetTotal"'))
  assert.ok(toolbar?.includes('id="sheetIndex"'))
})

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
  template.addEventListener('change', () => {
    if (template.value !== 'next.png') return
    widthInput.value = '210'
    heightInput.value = '144'
  })
  const controls = {
    footerPrefix: prefix, footerText: input, exportFilename: output, template,
    numberingEnabled: { checked: true }, sheetTotal: { value: '1' }, sheetIndex: { value: '1' },
  }
  const photos = new Map()
  const previewDropStyles = new Set()
  const previewPanel = Object.assign(new EventTarget(), {
    classList: { toggle(name, enabled) { if (enabled) previewDropStyles.add(name); else previewDropStyles.delete(name) } },
  })
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
    previewPanel,
    setTimeout: (callback, delay) => setTimeout(callback, delay).unref(), clearTimeout,
    document: {
      getElementById: id => controls[id],
      createElement: () => ({ click() { downloads.push(this.download) } }),
      addEventListener() {},
      dispatchEvent() {},
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
    photoLightingEditor: undefined,
    HeartStarWatermark: { preview: source => source },
  })
  const bridge = [...editorSource.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(([, source]) => source).find(source => source.includes('window.__picDoInject ='))
  vm.runInContext(templateLinkSource, context)
  vm.runInContext([
    between('const footerHeightMm=', 'function drawFooter('),
    between('async function setFiles(', 'function applySolidPhotos('),
    between('function hasImageTransfer(', "cancelPhotoLightingButton.addEventListener('click'"),
    between('async function exportPng(', 'const customAssets='),
    bridge,
  ].join('\n'), context)
  return {
    frame, photos, images, prefix, input, output, downloads, posted, template, widthInput, heightInput,
    sheetTotal: controls.sheetTotal, sheetIndex: controls.sheetIndex,
    previewPanel, previewDropStyles,
    useSlots(count, ids) { context.states = Array.from({ length: count }, () => ({})); selectedIds = ids },
    exportPng: context.exportPng,
  }
}

test('dropping an image onto the preview replaces only the selected position', async () => {
  const editor = editorFixture()
  editor.useSlots(2, [1])
  const original = {}
  editor.photos.set(0, { image: original })
  const dataTransfer = { files: [new File(['fixture'], 'portrait.png', { type: 'image/png' })] }
  const enter = Object.assign(new Event('dragover', { cancelable: true }), { dataTransfer })
  editor.previewPanel.dispatchEvent(enter)
  assert.ok(enter.defaultPrevented)
  assert.ok(editor.previewDropStyles.has('is-file-dragover'))
  const drop = Object.assign(new Event('drop', { cancelable: true }), { dataTransfer })
  editor.previewPanel.dispatchEvent(drop)
  assert.ok(drop.defaultPrevented)
  assert.equal(editor.previewDropStyles.size, 0)
  const droppedImage = editor.images.shift()
  droppedImage.onload()
  await flush()
  assert.equal(editor.photos.get(0).image, original)
  assert.equal(editor.photos.get(1).image, droppedImage)
})

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

test('both PNG downloads include the sheet counts, and only the formal download clears the numbering draft', async () => {
  const { frame, images, input, downloads, posted, exportPng, sheetTotal, sheetIndex } = editorFixture()
  const pending = frame.__picDoInject({
    b64: 'AA==', name: 'fixture.png', mime: 'image/png',
    template: 'preset.png', orderNumber: 'ORDER-one', imageId: 'photo-one', layoutNumber: 'ch-001',
  })
  await flush()
  images.shift().onload()
  await pending
  input.value = '0009'
  input.dispatchEvent(new Event('input'))
  sheetTotal.value = '4'
  sheetIndex.value = '2'
  await exportPng(true)
  assert.match(downloads[0], /^ch-\d{8}-0009 共4张·第2张_.*_水印预览\.png$/)
  assert.equal(posted.length, 0)
  assert.equal(frame.__picReadOrderNumbering().value, '0009')
  await exportPng()
  assert.match(downloads[1], /^ch-\d{8}-0009 共4张·第2张_preset_100x100mm_300dpi\.png$/)
  assert.equal(posted[0].orderNumber, 'ORDER-one')
  assert.equal(posted[0].imageId, 'photo-one')
  assert.equal(frame.__picHasPendingExport(), true)
  frame.__picAcknowledgeOrderExport()
  assert.equal(frame.__picHasPendingExport(), false)
  assert.equal(input.value, '')
  assert.equal(frame.__picReadOrderNumbering(), null)
})

test('the editor fills order sheet counts and ignores updates for orders that are no longer open', async () => {
  const { frame, images, sheetTotal, sheetIndex } = editorFixture()
  const pending = frame.__picDoInject({
    b64: 'AA==', template: 'preset.png', orderNumber: 'ORDER-one', sheets: { total: 5, index: 2 },
  })
  await flush()
  images.shift().onload()
  await pending
  assert.deepEqual([Number(sheetTotal.value), Number(sheetIndex.value)], [5, 2])
  frame.__picUpdateOrderSheets('ORDER-other', { total: 3, index: 1 })
  assert.deepEqual([Number(sheetTotal.value), Number(sheetIndex.value)], [5, 2])
  frame.__picUpdateOrderSheets('ORDER-one', { total: 5, index: 3 })
  assert.deepEqual([Number(sheetTotal.value), Number(sheetIndex.value)], [5, 3])
})

function environment(t, overrides = {}) {
  let rows = [], timerId = 0, delayedDetail = null
  let productions = [], qiniuStatus = { enabled: false, legacyEnabled: true }, fetchImage
  let confirmHandler = () => true
  const handlers = { ingested: new Set(), failed: new Set(), cloud: new Set() }
  const intervals = new Map()
  const mounted = [], unmounted = [], scopes = []
  const savedProductions = []
  const notifications = []
  const subscribe = name => async callback => {
    handlers[name].add(callback)
    return () => handlers[name].delete(callback)
  }
  const api = {
    onIngested: subscribe('ingested'), onFailed: subscribe('failed'), onCloudImported: subscribe('cloud'),
    listOrders: async () => structuredClone(rows.map(({ images, ...summary }) => summary)),
    getOrderSort: async () => ({ mode: 'time-desc', manual: [] }),
    saveOrderSort: async () => {},
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
    getAppInfo: async () => ({ templates: [] }),
    workflowOrders: async () => [],
    listProductions: async orderNumber => structuredClone(productions.filter(p => p.orderNumber === orderNumber)),
    saveProduction: async (orderNumber, dataB64, fileName, imageId) => {
      savedProductions.push({ orderNumber, dataB64, fileName, imageId })
      const production = { id: 'finished', orderNumber, filePath: fileName, syncStatus: 'pending' }
      productions = [production]
      return production
    },
    assetUrl: path => path,
    ...overrides,
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
      confirm: (...args) => confirmHandler(...args),
      fetch: (...args) => fetchImage(...args),
      createImageBitmap: async () => ({ close() {} }),
      btoa,
      console,
    })
    return module.exports
  }
  const store = evaluate(storeSource, {
    vue, '../lib/tauri': api,
    'vue-sonner': { toast: {
      success: text => notifications.push({ kind: 'ok', text }),
      error: text => notifications.push({ kind: 'error', text }),
    } },
  })
  const env = {
    store, handlers, intervals, savedProductions, notifications,
    rows(value) { rows = value },
    productions(value) { productions = value },
    qiniuStatus(value) { qiniuStatus = value },
    fetchImage(value) { fetchImage = value },
    onConfirm(value) { confirmHandler = value },
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
        '@lucide/vue': icons,
        '../components/OptionSelect.vue': {},
        '../components/TemplateSaveDialog.vue': {},
        '../components/ui/button': {},
        '../components/ui/checkbox': {},
        '../components/ui/input': {},
        '../lib/editor-export-controls': { mountEditorExportControls() {} },
        '../lib/template-editor': { connectTemplateEditor() {} },
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
    mountWorkflow(props) {
      const component = evaluate(workflowSource, {
        '@lucide/vue': icons, './ui/button': {},
        vue, '../stores/orders': store, '../lib/tauri': api,
      }).default
      return component.setup(props, { expose() {} })
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
  assert.equal(env.notifications.length, 1)
  assert.equal(env.notifications[0].kind, 'ok')
  assert.match(env.notifications[0].text, /ORDER-one/)
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

test('the order status filter can search across pending and completed orders', async t => {
  const env = environment(t)
  env.rows([order('pending'), order('finished')])
  await env.store.loadOrders()
  env.store.useOrdersStore().workflowOrders['ORDER-finished'] = { localCompleted: true }
  const view = await env.mountView()
  const ids = () => view.visibleEntries.value.map(entry => entry.summary.id).join(',')
  assert.equal(ids(), 'pending')
  view.orderFilter.value = 'completed'
  assert.equal(ids(), 'finished')
  view.orderFilter.value = 'all'
  assert.equal(ids(), 'pending,finished')
  view.orderSearch.value = 'finished'
  assert.equal(ids(), 'finished')
})

test('the order hover card closes when its order is filtered out or removed on refresh', async t => {
  const env = environment(t)
  const row = order('hovered')
  env.rows([row])
  await env.store.loadOrders()
  const view = await env.mountView()
  const position = { clientX: 100, clientY: 120 }

  view.onItemEnter(row.id, position)
  await flush()
  assert.equal(view.hoveredEntry.value?.summary.id, row.id)
  view.orderSearch.value = 'missing'
  assert.equal(view.hoveredEntry.value, undefined)
  await flush()
  assert.equal(view.hoverOrderId.value, null)

  view.orderSearch.value = ''
  assert.equal(view.visibleEntries.value.length, 1)
  assert.equal(view.hoveredEntry.value, undefined)
  view.onItemEnter(row.id, position)
  await flush()
  assert.equal(view.hoveredEntry.value?.summary.id, row.id)

  env.rows([])
  await env.store.loadOrders()
  await flush()
  assert.equal(view.hoveredEntry.value, undefined)
  assert.equal(view.hoverOrderId.value, null)
})

test('sorts by placed time or numeric price and uses the local creation time when needed', async t => {
  const env = environment(t)
  env.rows([
    { ...order('cheap'), metadata: '{"orderedAt":"2026-11-21T12:00:00+08:00","amount":"9.50"}' },
    { ...order('expensive'), metadata: '{"orderedAt":"2026-11-20T12:00:00+08:00","amount":"1,299.00"}' },
    { ...order('legacy'), createdAt: '2026-11-22T12:00:00+08:00' },
    { ...order('free'), metadata: '{"orderedAt":"2026-11-23T12:00:00+08:00","amount":"0.00"}' },
  ])
  await env.store.loadOrders()
  const view = await env.mountView()
  const ids = () => view.visibleEntries.value.map(entry => entry.summary.id).join(',')
  assert.equal(ids(), 'free,legacy,cheap,expensive')
  view.changeOrderSort('time-asc')
  assert.equal(ids(), 'expensive,cheap,legacy,free')
  view.changeOrderSort('amount-asc')
  assert.equal(ids(), 'free,cheap,expensive,legacy')
  view.changeOrderSort('amount-desc')
  assert.equal(ids(), 'expensive,cheap,free,legacy')
})

test('manual sorting saves the global order and keeps hidden rows in place', async t => {
  let saved = { mode: 'time-desc', manual: [] }
  const env = environment(t, {
    getOrderSort: async () => saved,
    saveOrderSort: async next => { saved = structuredClone(next) },
  })
  env.rows([order('a1'), order('b'), order('a2')])
  await env.store.loadOrders()
  const view = await env.mountView()
  view.changeOrderSort('manual')
  view.orderSearch.value = 'ORDER-a'
  view.moveOrderStep('ORDER-a2', -1)
  await flush()
  assert.deepEqual(saved, { mode: 'manual', manual: ['ORDER-a2', 'ORDER-b', 'ORDER-a1'] })
  env.rows([order('new'), order('a1'), order('a2'), order('b')])
  await env.store.loadOrders()
  const reopened = await env.mountView()
  assert.equal(reopened.orderSort.value.mode, 'manual')
  assert.equal(reopened.visibleEntries.value.map(row => row.summary.id).join(','), 'a2,b,a1,new')
})

test('capturing material for a completed order reveals its images without reopening the order', async t => {
  const finished = { orderNumber: 'ORDER-finished', localCompleted: true }
  const env = environment(t, { workflowOrders: async () => [finished] })
  const state = env.store.useOrdersStore()
  env.rows([order('pending'), order('finished', [image('first')])])
  await env.store.refreshWorkflowOrders()
  await env.store.loadOrders()
  await env.store.bindEvents()
  const view = await env.mountView()
  view.orderSearch.value = 'pending'
  assert.equal(view.visibleEntries.value[0].summary.id, 'pending')
  env.rows([order('finished', [image('first'), image('second')]), order('pending')])
  await env.emit({ kind: 'ingested', orderNumber: 'ORDER-finished', imageId: 'second' })
  assert.equal(view.orderFilter.value, 'completed')
  assert.equal(view.orderSearch.value, '')
  assert.equal(view.expandedOrderId.value, 'finished')
  assert.equal(view.visibleEntries.value[0].images[1].id, 'second')
  assert.equal(state.workflowOrders['ORDER-finished'].localCompleted, true)
})

test('opening a material shows its original and downloading saves that material', async t => {
  const saved = []
  const env = environment(t, { saveOrderImage: async id => { saved.push(id); return null } })
  const view = await env.mountView()
  let opened = false
  view.materialDialog.value = { open: false, showModal() { opened = true } }
  const material = { ...image('photo'), thumbnailPath: 'thumb.png', byteLength: 2.5 * 1024 * 1024 }
  await view.showMaterial(material)
  assert.equal(opened, true)
  assert.equal(view.materialPath.value, material.filePath)
  assert.equal(view.formatBytes(material.byteLength), '2.5 MB')
  await view.saveImage(view.previewMaterial.value)
  assert.deepEqual(saved, ['photo'])
  await view.showMaterial({ ...material, filePath: '' })
  assert.equal(view.materialPath.value, 'thumb.png')
  await view.saveImage(view.previewMaterial.value)
  assert.deepEqual(saved, ['photo'])
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

test('order sheet defaults count assigned copies and advance only when a sheet is successfully saved', async t => {
  const first = { ...image('first'), templates: [{ templateId: 'heart.png', quantity: 2 }] }
  const second = { ...image('second'), templates: [{ templateId: 'star.png', quantity: 3 }] }
  const incoming = order('one', [first, second])
  const file = page => `ch-20261123-1493 共5张·第${page}张_heart.png`
  const productions = [1, 1, 3].map((page, i) => ({
    id: `saved-${i}`, filePath: file(page), orderNumber: incoming.orderNumber,
  }))
  let fail = false
  const env = environment(t, {
    listProductions: async number => productions.filter(row => row.orderNumber === number),
    saveProduction: async (orderNumber, _bytes, filePath) => {
      if (fail) throw new Error('save failed')
      const production = { id: `saved-${productions.length}`, orderNumber, filePath }
      productions.push(production)
      return production
    },
  })
  env.rows([incoming])
  env.fetchImage(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }))
  const view = await env.mountView()
  const fills = [], advanced = []
  let acknowledgements = 0
  const frame = {
    async __picDoInject({ sheets }) { fills.push([sheets.total, sheets.index]) },
    __picUpdateOrderSheets(_orderNumber, sheets) { advanced.push([sheets.total, sheets.index]) },
    __picAcknowledgeOrderExport() { acknowledgements++ },
  }
  view.frame.value = vue.markRaw({ contentWindow: frame })
  view.onFrameLoad()
  await view.injectImage(first, incoming, 'heart.png')
  assert.deepEqual(fills.at(-1), [5, 2])

  view.onNumberingEdit({ target: { id: 'sheetTotal', valueAsNumber: 6, value: '6' } })
  view.onNumberingEdit({ target: { id: 'sheetIndex', valueAsNumber: 4, value: '4' } })
  await view.injectImage(second, incoming, 'star.png')
  assert.deepEqual(fills.at(-1), [6, 4])

  const exportSheet = sheetIndex => view.onMessage({ source: frame, data: {
    type: 'pic-make-exported', orderNumber: incoming.orderNumber, fileName: file(sheetIndex), sheetIndex,
  } })
  fail = true
  await exportSheet(4)
  assert.deepEqual(advanced, [])
  assert.equal(acknowledgements, 1)
  fail = false
  await exportSheet(4)
  assert.deepEqual(advanced.at(-1), [6, 2])
  await exportSheet(2)
  assert.deepEqual(advanced.at(-1), [6, 5])
  assert.equal(acknowledgements, 3)
})

test('the full specification list preselects saved assignments and keeps their quantities when adding a spec', async t => {
  const catalog = [
    { code: 'A01', name: '爱心款', webId: '模板爱心.png' },
    { code: 'A02', name: '爱心横版', webId: '爱心横版.png' },
  ]
  const edits = []
  const env = environment(t, {
    getAppInfo: async () => ({ templates: catalog }),
    setImageTemplates: async (id, templates) => { edits.push({ id, templates }) },
  })
  await env.store.loadInfo()
  const view = await env.mountView()
  const material = { ...image('photo'), templates: [{ templateId: 'A01', quantity: 3 }] }
  const specs = view.specificationsFor(material)
  assert.deepEqual(Array.from(specs, spec => [spec.code, spec.quantity]), [['A01', 3], ['A02', null]])
  await view.toggleTemplate(material, '爱心横版.png')
  assert.deepEqual(Array.from(edits[0].templates, spec => [spec.templateId, spec.quantity]), [
    ['A01', 3], ['爱心横版.png', 1],
  ])
})

test('editing one template quantity preserves every other assignment and rejects invalid quantities', async t => {
  const updates = []
  const env = environment(t, {
    setImageTemplates: async (id, templates) => { updates.push({ id, templates }) },
  })
  const view = await env.mountView()
  const material = { ...image('photo'), templates: [
    { templateId: '甜心派对.png', quantity: 2 },
    { templateId: '爱心心动马卡龙.png', quantity: 3 },
  ] }
  const input = { value: '5', valueAsNumber: 5 }
  await view.changeTemplateQuantity(material, '甜心派对.png', { currentTarget: input })
  assert.equal(updates[0].id, material.id)
  assert.deepEqual(Array.from(updates[0].templates, t => [t.templateId, t.quantity]), [
    ['甜心派对.png', 5], ['爱心心动马卡龙.png', 3],
  ])

  await view.changeTemplateQuantity(material, '甜心派对.png', { currentTarget: { ...input, valueAsNumber: 0 } })
  assert.equal(updates.length, 1)
  assert.equal(material.templates[0].quantity, 5)
})

test('an image remark is shown after saving and can be cleared without editing other images', async t => {
  const edits = []
  const env = environment(t, {
    setImageRemark: async (id, remark) => { edits.push({ id, remark }) },
  })
  const view = await env.mountView()
  const first = image('first'), second = image('second')
  view.remarkDrafts[first.id] = ' 请保留耳朵\n偏暖一点 '
  view.remarkDrafts[second.id] = '另一张的草稿'
  await view.saveRemark(first)
  assert.equal(first.remark, '请保留耳朵\n偏暖一点')
  assert.equal(view.remarkDrafts[first.id], undefined)
  assert.equal(second.remark, '')
  assert.equal(view.remarkDrafts[second.id], '另一张的草稿')

  view.remarkDrafts[first.id] = ' '
  await view.saveRemark(first)
  assert.deepEqual(edits, [{ id: first.id, remark: '请保留耳朵\n偏暖一点' }, { id: first.id, remark: '' }])
  assert.equal(first.remark, '')
})

test('historical A05 orders still use blue after new A05 orders switch to Strawberry Sweetheart', async t => {
  const env = environment(t, {
    getAppInfo: async () => ({ templates: [
      { code: 'A05', name: '草莓甜心', webId: '草莓.png', legacyWebId: '模板蓝色.png' },
    ] }),
  })
  await env.store.loadInfo()
  const view = await env.mountView()
  const material = image('photo')
  const assignments = templateId => Array.from(view.specificationsFor({
    ...material, templates: [{ templateId, quantity: 2 }],
  }), spec => [spec.webId, spec.quantity])
  assert.deepEqual(assignments('A05'), [['草莓.png', null], ['模板蓝色.png', 2]])
  assert.deepEqual(assignments('草莓.png'), [['草莓.png', 2]])
})

test('selecting the shared version replaces an open order only after the replacement succeeds', async t => {
  const replacements = []
  const conflict = { orderNumber: 'ORDER-one', reference: 'remote:5', localVersion: 'local:2', changes: [] }
  let failure = '订单已变化，请重新同步。'
  const env = environment(t, {
    workflowOrders: async () => [],
    workflowSync: async () => ({ conflicts: [conflict], errors: [], updated: 0, completed: 0 }),
    workflowResolveConflict: async (...args) => {
      replacements.push(args)
      if (failure) throw new Error(failure)
    },
  })
  const view = await env.mountView()
  view.openEditor()
  view.lastInjectedOrder.value = conflict.orderNumber
  let pendingExport = true
  view.frame.value = vue.markRaw({ contentWindow: { __picHasPendingExport: () => pendingExport } })
  const workflow = env.mountWorkflow({
    get activeOrder() { return view.lastInjectedOrder.value },
    saveLayout: view.persistLayout,
    applySharedVersion: (...args) => view.applySharedVersion(...args),
  })
  await workflow.sync()
  await workflow.replace()
  assert.equal(replacements.length, 0)
  assert.equal(view.lastInjectedOrder.value, conflict.orderNumber)
  pendingExport = false
  await workflow.replace()
  assert.equal(view.lastInjectedOrder.value, conflict.orderNumber)
  assert.ok(view.editorSrc.value)
  assert.match(workflow.resolveError.value, /重新同步/)
  assert.equal(workflow.preview.value.reference, conflict.reference)
  failure = null
  await workflow.replace()
  assert.equal(view.lastInjectedOrder.value, null)
  assert.equal(view.editorSrc.value, '')
  assert.equal(workflow.preview.value, null)
  assert.deepEqual(replacements, [
    ['remote:5', 'local:2', null],
    ['remote:5', 'local:2', null],
  ])
})

test('upload and finish open the comparison without a separate sync action', async t => {
  const conflict = { orderNumber: 'ORDER-conflict', reference: 'shared-head', localVersion: 'local-head', changes: ['商家备注'] }
  const env = environment(t, {
    workflowOrders: async () => [],
    workflowUpload: async () => ({ updated: 1, conflicts: [conflict], errors: [], uploadedOrderNumbers: ['ORDER-ok'] }),
    workflowFinish: async () => ({ completed: 0, conflicts: [conflict], errors: [] }),
  })
  env.store.useOrdersStore().workflow.role = 'customer'
  const applied = []
  const workflow = env.mountWorkflow({ saveLayout: async () => {}, applySharedVersion: async value => applied.push(value) })
  const dialog = vue.markRaw({ open: false, showModal() { this.open = true }, close() { this.open = false } })
  workflow.dialog.value = dialog
  assert.deepEqual(await workflow.upload(['ORDER-conflict', 'ORDER-ok']), ['ORDER-ok'])
  assert.equal(dialog.open, true)
  assert.equal(workflow.preview.value.orderNumber, 'ORDER-conflict')
  workflow.dismiss(conflict)
  assert.equal(dialog.open, false)
  assert.equal(applied.length, 0)
  env.store.useOrdersStore().workflow.role = 'production'
  await workflow.finish(conflict.orderNumber)
  assert.equal(dialog.open, true)
  await workflow.replace()
  assert.equal(applied[0].reference, conflict.reference)
  assert.equal(dialog.open, false)
})

test('listOrderEntries populates sidebar entries in one batch without per-order getOrder IPC calls', async t => {
  let detailCalls = 0
  const batchEntries = [
    { summary: { id: 'one', orderNumber: 'ORDER-1', imageCount: 1, createdAt: '2026-11-26T00:00:00', updatedAt: '2026-11-26T00:00:00', metadata: null }, images: [image('img-1')] },
    { summary: { id: 'two', orderNumber: 'ORDER-2', imageCount: 1, createdAt: '2026-11-26T00:01:00', updatedAt: '2026-11-26T00:01:00', metadata: null }, images: [image('img-2')] },
  ]
  const env = environment(t, {
    listOrderEntries: async () => structuredClone(batchEntries),
    getOrder: async () => { detailCalls++; return null },
  })
  await env.store.loadOrders()
  const view = await env.mountView()
  assert.equal(detailCalls, 0)
  assert.equal(view.visibleEntries.value.length, 2)
  assert.equal(view.visibleEntries.value[0].images[0].id, 'img-2')
})

test('claim lock warns when another workstation is making the order and allows lazy production preview', async t => {
  const claims = []
  const downloadedIds = []
  const env = environment(t, {
    workflowOrders: async () => [{
      orderNumber: 'ORDER-one',
      localCompleted: false,
      sharedState: 'pending',
      pendingOperation: null,
      error: null,
      claimedBy: 'dev-other',
      claimedName: '制作2号机',
      claimedByMe: false,
    }],
    workflowClaimOrder: async (orderNumber, force) => {
      claims.push({ orderNumber, force: Boolean(force) })
      return { ok: true, claimedBy: 'dev-me', claimedName: '制作1号机' }
    },
    workflowDownloadProduction: async id => {
      downloadedIds.push(id)
      return { id, orderNumber: 'ORDER-one', imageId: null, filePath: 'D:/app/data/productions/done.png', createdAt: '2026-11-26T01:00:00', remoteOnly: false }
    },
  })
  env.rows([order('one', [image('photo-1')])])
  env.productions([{ id: 'prod-remote', orderNumber: 'ORDER-one', imageId: null, filePath: '', originalName: '成品.png', byteLength: 2048, remoteOnly: true }])
  env.fetchImage(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }))
  await env.store.refreshWorkflowOrders()
  await env.store.loadOrders()
  const view = await env.mountView()
  const frame = { async __picDoInject() {} }
  view.frame.value = vue.markRaw({ contentWindow: frame })
  view.editorSrc.value = '/embedded/heart-star/index.html'
  view.editorReady.value = true

  // Declining takeover keeps canvas untouched and sends no claim write.
  env.onConfirm(() => false)
  await view.injectImage(image('photo-1'), order('one'))
  assert.equal(claims.length, 0)
  assert.equal(view.lastInjectedOrder.value, null)

  // Confirming takeover claims with force=true and injects into editor.
  env.onConfirm(() => true)
  await view.injectImage(image('photo-1'), order('one'))
  assert.deepEqual(claims, [{ orderNumber: 'ORDER-one', force: true }])
  assert.equal(view.lastInjectedOrder.value, 'ORDER-one')

  // Clicking a cloud-only production downloads it on demand and opens preview.
  let modalOpened = false
  view.materialDialog.value = { open: false, showModal() { modalOpened = true } }
  view.expandedOrderId.value = 'one'
  await flush()
  await view.openOrDownloadProduction(view.orderProductions('ORDER-one')[0])
  assert.deepEqual(downloadedIds, ['prod-remote'])
  assert.equal(modalOpened, true)
  assert.equal(view.materialPath.value, 'D:/app/data/productions/done.png')
})
