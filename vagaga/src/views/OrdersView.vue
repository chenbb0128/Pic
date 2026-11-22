<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useOrdersStore, loadOrders, toast } from '../stores/orders'
import {
  assetUrl,
  cutoutImageBytes,
  deleteImage,
  deleteOrder,
  getCutoutConfig,
  getOrder,
  listOrders,
  listProductions,
  openPath,
  saveOrderImage,
  saveProduction,
  setImageTemplates,
  workflowResolveConflict,
  workflowSetLayout,
} from '../lib/tauri'
import type { OrderImage, OrderSummary, Production, SyncStatus, WorkflowPreview } from '../types'

const props = defineProps<{
  visible?: boolean
  uploadableOrders?: Set<string>
  uploadSelection?: string[]
  workflowBusy?: boolean
}>()
const emit = defineEmits<{ finish: [orderNumber: string]; toggleUpload: [orderNumber: string, checked: boolean] }>()
const store = useOrdersStore()
const canDelete = computed(() => store.workflow.role !== 'production')
const canFinish = computed(() => store.workflow.role !== 'customer')

const syncLabels: Record<SyncStatus, string> = {
  pending: '已保存本地 · 等待上传',
  uploading: '上传中',
  synced: '已同步服务器',
  failed: '同步失败',
  localOnly: '仅保存在本机',
  downloading: '下载中',
}

function syncLabel(asset: OrderImage | Production) {
  if ('source' in asset && asset.source === '七牛同步' && asset.syncStatus === 'synced' && asset.filePath) {
    return '原图下载完成'
  }
  return asset.syncStatus ? syncLabels[asset.syncStatus] : ''
}

function qualityLabel(img: OrderImage) {
  if (img.sourceQuality === 'scaled') return '来源为缩图'
  if (img.sourceQuality === 'unknown') return '原图来源未确认'
  return ''
}

function makeBlockReason(img: OrderImage) {
  if (img.syncStatus === 'downloading') return '原图正在下载'
  if (!img.filePath) return '本机原图尚不可用'
  if (img.sourceQuality === 'scaled') return '制作需要原图，请先获取原图'
  if (img.sourceQuality === 'unknown') return '制作需要来源已确认的原图'
  return ''
}

/* ---------- 左栏数据：订单 + 素材树 ---------- */
const entries = ref<{ summary: OrderSummary; images: OrderImage[] }[]>([])
const orderSearch = ref('')
const orderFilter = ref<'pending' | 'completed' | 'all'>('pending')
const isOrderComplete = (number: string) => Boolean(
  store.workflowOrders[number]?.localCompleted || store.workflowOrders[number]?.sharedState === 'completed',
)

function finishLabel(number: string) {
  if (!canFinish.value) return ''
  const state = store.workflowOrders[number]
  if (state?.pendingOperation === 'finish' || (state?.localCompleted && state.sharedState === 'pending')) {
    return '重试交付'
  }
  return isOrderComplete(number) ? '' : '标记完成'
}

function workflowLabel(number: string) {
  const state = store.workflowOrders[number]
  if (state?.pendingOperation === 'finish') return state.error ? '已标记完成 · 交付失败，待重试' : '已标记完成 · 等待交付'
  if (state?.sharedState === 'completed') return '共享已完成'
  if (state?.localCompleted && state.sharedState === 'pending') return '已标记完成 · 待交付'
  if (state?.localCompleted) return '已标记完成'
  if (state?.pendingOperation === 'publish') return state.error ? '发布失败 · 等待重试' : '等待发布'
  if (state?.sharedState === 'pending') return '已发布 · 待制作'
  return ''
}
const searchTerm = computed(() => orderSearch.value.trim().toLowerCase())
const matchingOrders = computed(() => store.orders.filter(matchesOrder))
const visibleEntries = computed(() => {
  const byId = new Map(entries.value.map(entry => [entry.summary.id, entry.images]))
  return matchingOrders.value.map(summary => ({ summary, images: byId.get(summary.id) ?? [] }))
})

function matchesOrder(order: OrderSummary) {
  if (orderFilter.value !== 'all' && (orderFilter.value === 'completed') !== isOrderComplete(order.orderNumber)) return false
  const term = searchTerm.value
  return !term || order.orderNumber.toLowerCase().includes(term)
    || (parseMeta(order.metadata)?.layoutNumber?.toLowerCase().includes(term) ?? false)
}

let sourcesRequest = 0
async function refreshSources(summaries?: OrderSummary[]) {
  const request = ++sourcesRequest
  const orders = summaries ?? await listOrders()
  const next = await Promise.all(
    orders.filter(matchesOrder).map(async summary => ({
      summary,
      images: (await getOrder(summary.id))?.images ?? [],
    })),
  )
  if (request === sourcesRequest) entries.value = next
}

watch(
  matchingOrders,
  orders => { void refreshSources(orders).catch(error => toast('error', `刷新素材失败：${error}`)) },
  { immediate: true },
)

/* ---------- 展开订单 ---------- */
const expandedOrderId = ref<string | null>(null)
const productionsByOrder = ref<Record<string, Production[]>>({})
const productionRequests = new Map<string, number>()
const expandedOrderNumber = computed(() =>
  store.orders.find(order => order.id === expandedOrderId.value)?.orderNumber,
)

watch(() => store.latestCapture, capture => {
  const order = store.orders.find(row => row.id === capture?.orderId)
  if (!order) return
  if (orderFilter.value !== 'all') {
    orderFilter.value = isOrderComplete(order.orderNumber) ? 'completed' : 'pending'
  }
  if (!matchesOrder(order)) orderSearch.value = ''
  expandedOrderId.value = order.id
})

async function refreshProductions(orderNumber: string) {
  const request = (productionRequests.get(orderNumber) ?? 0) + 1
  productionRequests.set(orderNumber, request)
  const productions = await listProductions(orderNumber)
  if (productionRequests.get(orderNumber) === request) {
    productionsByOrder.value[orderNumber] = productions
  }
}

function chooseOrder(id: string) {
  void persistLayout().catch(reportLayoutError)
  expandedOrderId.value = expandedOrderId.value === id ? null : id
}

/* ---------- 模板编号映射 ---------- */
function codeOf(templateId: string): string {
  return (
    store.info?.templates.find(t => t.webId === templateId)?.code ??
    templateId.replace(/\.[^.]+$/, '')
  )
}

function webIdOf(code: string): string {
  return store.info?.templates.find(t => t.code === code)?.webId ?? code
}

function specificationsFor(img: OrderImage) {
  const assigned = new Map(img.templates.map(t => [webIdOf(t.templateId), t.quantity]))
  const specs = (store.info?.templates ?? []).map(({ code, name, webId }) => {
    const quantity = assigned.get(webId) ?? null
    assigned.delete(webId)
    return { code, name, webId, quantity }
  })
  for (const [webId, quantity] of assigned) {
    const code = codeOf(webId)
    specs.push({ code, name: code, webId, quantity })
  }
  return specs
}

const editingTemplateIds = reactive(new Set<string>())
async function toggleTemplate(img: OrderImage, webId: string) {
  if (props.workflowBusy || editingTemplateIds.has(img.id)) return
  const matches = (templateId: string) => webIdOf(templateId) === webId
  const next = img.templates.some(t => matches(t.templateId))
    ? img.templates.filter(t => !matches(t.templateId))
    : [...img.templates, { templateId: webId, quantity: 1 }]
  editingTemplateIds.add(img.id)
  try {
    await setImageTemplates(img.id, next)
    img.templates = next
    await loadOrders()
  } catch (error) {
    toast('error', `保存模板失败：${error}`)
  } finally {
    editingTemplateIds.delete(img.id)
  }
}

/* ---------- 右栏：常驻编辑器 ---------- */
const frame = ref<HTMLIFrameElement | null>(null)
const editorReady = ref(false)
const editorSrc = ref('') // 惰性加载：首次制作时才设置
const status = ref('')
const busyImageId = ref('')
const lastInjectedOrder = ref<string | null>(null)
let lastInjectedImageId: string | null = null
const numberingDrafts = new Map<string, { prefix: string; value: string }>()
let numberingDocument: Document | null = null
let layoutTimer: ReturnType<typeof setTimeout> | undefined
let layoutWrites: Promise<void> = Promise.resolve()
const pendingLayouts = new Map<string, string>()
const savingProductions = new Map<string | null, number>()
const lastExport = ref<Production | null>(null)

function reportLayoutError(error: unknown) {
  toast('error', `保存排版编号失败：${error}`)
}

function rememberNumbering() {
  const orderNumber = lastInjectedOrder.value
  const draft = frame.value?.contentWindow?.__picReadOrderNumbering?.()
  if (!orderNumber || draft?.orderNumber !== orderNumber) return
  numberingDrafts.set(orderNumber, { prefix: draft.prefix, value: draft.value })
  return draft
}

function persistLayout(): Promise<void> {
  if (layoutTimer !== undefined) clearTimeout(layoutTimer)
  layoutTimer = undefined
  layoutWrites = layoutWrites.catch(() => {}).then(async () => {
    for (const [orderNumber, number] of pendingLayouts) {
      await workflowSetLayout(orderNumber, number)
      if (pendingLayouts.get(orderNumber) === number) pendingLayouts.delete(orderNumber)
    }
  })
  return layoutWrites
}

function onNumberingEdit(event: Event) {
  const id = (event.target as HTMLElement | null)?.id
  if (id !== 'footerText' && id !== 'footerPrefix') return
  const draft = rememberNumbering()
  if (!draft) return
  const value = draft.value.trim()
  if (!value && id !== 'footerText') return
  const number = value ? `${draft.prefix}-${value}` : ''
  if (value && !/^(ch|yy|x)-[A-Za-z0-9]{1,64}$/i.test(number)) return
  pendingLayouts.set(draft.orderNumber, number)
  if (layoutTimer !== undefined) clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => { void persistLayout().catch(reportLayoutError) }, 300)
}

function removeNumberingListeners() {
  numberingDocument?.removeEventListener('input', onNumberingEdit)
  numberingDocument?.removeEventListener('change', onNumberingEdit)
  numberingDocument = null
}

async function applySharedVersion({ orderNumber, reference, localVersion }: WorkflowPreview) {
  const activeOrder = lastInjectedOrder.value
  const replacingOpenOrder = activeOrder === orderNumber
  if (busyImageId.value) throw new Error('素材正在载入，请稍后重试。')
  if (savingProductions.has(orderNumber)
    || frame.value?.contentWindow?.__picHasPendingExport?.()) {
    throw new Error('成品正在导出或保存，请稍后重试。')
  }

  // The modal keeps the canvas inactive while the server checks and applies the replacement.
  await workflowResolveConflict(reference, localVersion, replacingOpenOrder ? null : activeOrder)
  numberingDrafts.delete(orderNumber)
  if (expandedOrderNumber.value === orderNumber) {
    expandedOrderId.value = null
  }
  if (!replacingOpenOrder) return
  removeNumberingListeners()
  lastInjectedOrder.value = null
  lastInjectedImageId = null
  lastExport.value = null
  editorReady.value = false
  editorSrc.value = ''
  status.value = ''
}

function requestFinish(orderNumber: string) {
  if (savingProductions.has(orderNumber)
    || (lastInjectedOrder.value === orderNumber && frame.value?.contentWindow?.__picHasPendingExport?.())) {
    toast('error', '成品正在导出或保存，请稍后再点击标记完成。')
    return
  }
  emit('finish', orderNumber)
}

watch(() => props.visible, visible => {
  if (visible === false) void persistLayout().catch(reportLayoutError)
})
defineExpose({ lastInjectedOrder, persistLayout, applySharedVersion })
const exportStatus = computed(() => {
  const saved = lastExport.value
  if (!saved) return ''
  const production = orderProductions(saved.orderNumber).find(row => row.id === saved.id) ?? saved
  if (!saved.orderNumber) return '成品已保存本地（未关联订单）。'
  const prefix = `订单 ${saved.orderNumber} 的成品`
  switch (production.syncStatus) {
    case 'synced': return `${prefix}已同步服务器。`
    case 'pending': return `${prefix}已保存本地，待回传。`
    case 'uploading': return `${prefix}已保存本地，正在回传。`
    case 'failed': return `${prefix}已保存本地，回传失败。${production.syncError ?? ''}`
    default: return `${prefix}已保存本地。`
  }
})

watch(
  [() => store.orders, expandedOrderNumber, () => lastExport.value?.orderNumber],
  ([, expandedNumber, exportedNumber]) => {
    if (expandedNumber) void refreshProductions(expandedNumber).catch(() => {})
    if (exportedNumber && exportedNumber !== expandedNumber) {
      void refreshProductions(exportedNumber).catch(() => {})
    }
  },
  { immediate: true },
)

const EDITOR_URL = '/embedded/heart-star/index.html'

function openEditor() {
  if (!editorSrc.value) editorSrc.value = EDITOR_URL
}

/* ---------- 素材注入 + 模板自动切换 ---------- */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function injectImage(img: OrderImage, order: Pick<OrderSummary, 'orderNumber' | 'metadata'>, templateId?: string) {
  const blocked = makeBlockReason(img)
  if (blocked) {
    status.value = blocked
    return
  }
  if (busyImageId.value || props.workflowBusy) return
  const { orderNumber, metadata } = order
  const layoutNumber = parseMeta(metadata)?.layoutNumber ?? null
  const template = templateId ? webIdOf(templateId) : ''
  busyImageId.value = img.id
  status.value = `正在读取「${img.originalName}」…`
  try {
    const response = await fetch(assetUrl(img.filePath))
    if (!response.ok) throw new Error(`读取素材失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    if (!blob.size) throw new Error('本地素材文件为空。')
    try {
      const decoded = await createImageBitmap(blob)
      decoded.close()
    } catch {
      throw new Error('本地素材无法作为图片打开。')
    }
    const b64 = await blobToBase64(blob)

    rememberNumbering()
    await persistLayout()
    openEditor()
    status.value = `正在注入「${img.originalName}」…`

    const isReady = () => editorReady.value && typeof frame.value?.contentWindow?.__picDoInject === 'function'
    if (!isReady()) {
      const ready = await new Promise<boolean>(resolve => {
        const timer = setInterval(() => {
          if (isReady()) {
            clearInterval(timer)
            clearTimeout(timeout)
            resolve(true)
          }
        }, 50)
        const timeout = setTimeout(() => {
          clearInterval(timer)
          resolve(false)
        }, 10000)
      })
      if (!ready) throw new Error('编辑器加载超时，请重试。')
    }

    const fw = frame.value?.contentWindow
    if (typeof fw?.__picDoInject !== 'function') throw new Error('编辑器尚未就绪，请重试。')
    await fw.__picDoInject({
      b64,
      name: img.originalName || 'order-image.png',
      mime: blob.type || 'image/png',
      template,
      orderNumber,
      imageId: img.id,
      layoutNumber,
      numberingDraft: numberingDrafts.get(orderNumber),
    })
    lastInjectedOrder.value = orderNumber
    lastInjectedImageId = img.id
    lastExport.value = null
    status.value = '素材已注入编辑器，请排版调整后导出。'
  } catch (error) {
    status.value = String(error)
  } finally {
    busyImageId.value = ''
  }
}

/* ---------- 编辑器 → 主窗口桥 ---------- */
async function onMessage(event: MessageEvent) {
  const editor = frame.value?.contentWindow
  if (!editor || event.source !== editor) return
  const data = event.data as
    | {
        type?: string
        id?: string
        dataB64?: string
        b64?: string
        fileName?: string
        orderNumber?: string | null
        imageId?: string | null
        action?: string
      }
    | null
  if (data?.type === 'heart-star-toolbar' && data.action === 'shortcuts') {
    showShortcutGuide.value = true
    return
  }
  if (data?.type === 'pic-cutout-request') {
    status.value = 'AI 抠图处理中；耗时和接口结果记录在“设置 → AI 抠图”的日志中。'
    try {
      const config = await getCutoutConfig()
      const timeoutSecs = config.timeoutSecs >= 30 ? config.timeoutSecs : 90
      editor.postMessage(
        { type: 'pic-cutout-started', id: data.id, timeoutMs: timeoutSecs * 2000 + 15000 },
        '*',
      )
      const result = await cutoutImageBytes(data.dataB64 ?? '')
      if (editor !== frame.value?.contentWindow) return
      status.value = result.cached ? 'AI 抠图完成（缓存命中）。' : 'AI 抠图完成。'
      editor.postMessage(
        { type: 'pic-cutout-response', id: data.id, pngB64: result.pngB64, cached: result.cached },
        '*',
      )
    } catch (error) {
      if (editor !== frame.value?.contentWindow) return
      status.value = `AI 抠图失败：${error}`
      editor.postMessage(
        { type: 'pic-cutout-response', id: data.id, error: String(error) },
        '*',
      )
    }
    return
  }
  if (data?.type === 'pic-make-exported') {
    const orderNumber = data.orderNumber === undefined ? lastInjectedOrder.value : data.orderNumber
    const imageId = data.imageId === undefined ? lastInjectedImageId : data.imageId
    savingProductions.set(orderNumber, (savingProductions.get(orderNumber) ?? 0) + 1)
    editor.__picAcknowledgeOrderExport?.()
    try {
      const saved = await saveProduction(orderNumber, data.b64 ?? '', data.fileName || '成品.png', imageId)
      if (orderNumber) numberingDrafts.delete(orderNumber)
      lastExport.value = saved
      status.value = ''
      if (orderNumber) {
        productionsByOrder.value[orderNumber] = [
          saved,
          ...orderProductions(orderNumber).filter(row => row.id !== saved.id),
        ]
        void refreshProductions(orderNumber).catch(() => {})
      }
      toast('ok', '成品已保存本地')
    } catch (error) {
      status.value = `成品保存失败：${error}`
      toast('error', '成品保存失败')
    } finally {
      const count = savingProductions.get(orderNumber) ?? 1
      if (count === 1) savingProductions.delete(orderNumber)
      else savingProductions.set(orderNumber, count - 1)
    }
  }
}

function onFrameLoad() {
  removeNumberingListeners()
  numberingDocument = frame.value?.contentDocument ?? null
  numberingDocument?.addEventListener('input', onNumberingEdit)
  numberingDocument?.addEventListener('change', onNumberingEdit)
  editorReady.value = true
  status.value = '编辑器已就绪：从左侧选择规格「制作」，或在编辑器内粘贴图片。'
}

function openImage(filePath: string) {
  if (filePath) void openPath(filePath).catch(error => toast('error', `打开文件失败：${error}`))
}

const materialDialog = ref<HTMLDialogElement | null>(null)
const previewMaterial = ref<OrderImage | null>(null)
const materialPath = computed(() => previewMaterial.value?.filePath || previewMaterial.value?.thumbnailPath || '')
const materialPreviewFailed = ref(false)

async function showMaterial(img: OrderImage) {
  if ((!img.filePath && !img.thumbnailPath) || !materialDialog.value) return
  previewMaterial.value = img
  materialPreviewFailed.value = false
  await nextTick()
  const dialog = materialDialog.value
  if (dialog && !dialog.open) dialog.showModal()
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const unit = bytes >= 1024 * 1024 ? 'MB' : 'KB'
  const value = bytes / (unit === 'MB' ? 1024 * 1024 : 1024)
  return `${Number(value.toFixed(value < 100 ? 1 : 0))} ${unit}`
}

const savingImageId = ref('')
async function saveImage(img: OrderImage) {
  if (savingImageId.value || !img.filePath || img.syncStatus === 'downloading') return
  savingImageId.value = img.id
  try {
    const path = await saveOrderImage(img.id)
    if (path) toast('ok', img.sourceQuality === 'scaled' ? '缩略图已保存' : '素材已保存')
  } catch (error) {
    toast('error', `另存素材失败：${error}`)
  } finally {
    savingImageId.value = ''
  }
}

/* ---------- 删除 ---------- */
async function removeOrder(id: string) {
  if (!canDelete.value) return
  if (!confirm('确认删除该订单？素材归档文件会保留在磁盘。')) return
  try {
    await deleteOrder(id)
    if (expandedOrderId.value === id) expandedOrderId.value = null
    await loadOrders()
  } catch (error) {
    toast('error', `删除订单失败：${error}`)
  }
}

async function removeImage(imageId: string) {
  if (!canDelete.value) return
  if (!confirm('确认删除该素材？归档文件会保留在磁盘。')) return
  try {
    await deleteImage(imageId)
    await loadOrders()
  } catch (error) {
    toast('error', `删除素材失败：${error}`)
  }
}

/* ---------- 生命周期与联动 ---------- */
onMounted(() => {
  window.addEventListener('message', onMessage)
})

onBeforeUnmount(() => {
  void persistLayout().catch(reportLayoutError)
  removeNumberingListeners()
  sourcesRequest++
  productionRequests.clear()
  window.removeEventListener('message', onMessage)
})

// 新素材入库（本机排单/云同步）时自动展开对应订单
watch(
  () => store.selectedId,
  id => {
    if (id) expandedOrderId.value = id
  },
  { immediate: true },
)

function fmtTime(iso: string): string {
  return iso.replace('T', ' ').slice(5, 19)
}

/* ---------- 订单悬浮详情卡（千帆透传的状态/金额/规格） ---------- */
const hoverOrderId = ref<string | null>(null)
const hoverPos = ref({ x: 0, y: 0 })

interface OrderMeta {
  status?: string
  amount?: string
  specText?: string
  layoutNumber?: string
}

function parseMeta(meta: string | null | undefined): OrderMeta | null {
  if (!meta) return null
  try {
    const parsed = JSON.parse(meta) as OrderMeta | null
    if (!parsed || typeof parsed !== 'object') return null
    const layoutNumber = typeof parsed.layoutNumber === 'string'
      && /^(ch|yy|x)-[A-Za-z0-9]{1,64}$/i.test(parsed.layoutNumber)
      ? parsed.layoutNumber : undefined
    return { ...parsed, layoutNumber }
  } catch {
    return null
  }
}

function onItemEnter(id: string, ev: MouseEvent) {
  hoverOrderId.value = id
  hoverPos.value = { x: ev.clientX + 12, y: ev.clientY + 8 }
}

function onItemMove(ev: MouseEvent) {
  const cardW = 260
  const cardH = 170
  hoverPos.value = {
    x: Math.min(ev.clientX + 12, window.innerWidth - cardW - 8),
    y: Math.min(ev.clientY + 8, window.innerHeight - cardH - 8),
  }
}

function onItemLeave() {
  hoverOrderId.value = null
}

/* ---------- 快捷键指南（编辑器顶栏按钮触发） ---------- */
const showShortcutGuide = ref(false)
const shortcutGroups = [
  { title: '选择图案', items: [
    { keys: ['Esc'], action: '取消全部选中', note: '输入框编辑、图片拖动或弹窗打开时不触发。' },
    { keys: ['鼠标拖框'], action: '框选多个图案', note: '框住图案中心即可选中；请先关闭"拖动图片"。' },
    { keys: ['Shift + 拖框'], action: '追加选中图案', note: '保留原选择，再添加框内图案。' },
  ] },
  { title: '调整图案', items: [
    { keys: ['Alt + 滚轮'], action: '缩放选中的图案', note: '鼠标放在画板上使用，向上放大、向下缩小；不适用于文案模板。' },
  ] },
  { title: '文案模板专用', items: [
    { keys: ['Ctrl / ⌘ + Z'], action: '撤销上一步', note: '仅用于文案排版；输入框内使用系统原有撤销。' },
    { keys: ['Ctrl / ⌘ + Shift + Z', 'Ctrl / ⌘ + Y'], action: '重做上一步', note: '仅用于文案排版。' },
  ] },
]

function orderProductions(orderNumber: string): Production[] {
  return productionsByOrder.value[orderNumber] ?? []
}
</script>

<template>
  <div class="body">
    <!-- 左栏：订单 + 素材（含编辑面板） -->
    <aside class="list glass">
      <div class="listHead">
        <span>订单</span>
        <button class="iconBtn" title="刷新本地列表" aria-label="刷新本地列表" @click="loadOrders().catch(error => toast('error', `刷新订单失败：${error}`))">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </button>
      </div>
      <div class="orderTools">
        <div class="orderSearch">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
          <input v-model="orderSearch" type="search" placeholder="搜索订单号或排版编号" aria-label="搜索订单号或排版编号" autocomplete="off" />
        </div>
        <select v-model="orderFilter" class="orderFilter" aria-label="按制作状态筛选">
          <option value="pending">待制作</option>
          <option value="completed">已完成</option>
          <option value="all">全部订单</option>
        </select>
      </div>
      <div class="items">
        <div v-for="entry in visibleEntries" :key="entry.summary.id" class="orderBlock">
          <div
            class="item"
            :class="{ on: expandedOrderId === entry.summary.id }"
            @click="chooseOrder(entry.summary.id)"
            @mouseenter="onItemEnter(entry.summary.id, $event)"
            @mousemove="onItemMove($event)"
            @mouseleave="onItemLeave"
          >
            <input v-if="uploadableOrders?.has(entry.summary.orderNumber)"
              type="checkbox" class="uploadCheck"
              :checked="uploadSelection?.includes(entry.summary.orderNumber)" :disabled="workflowBusy"
              :aria-label="'勾选订单 ' + entry.summary.orderNumber + ' 上传'" @click.stop
              @change="emit('toggleUpload', entry.summary.orderNumber, ($event.target as HTMLInputElement).checked)" />
            <svg class="chevron" :class="{ open: expandedOrderId === entry.summary.id }" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
            <div class="itemMain">
              <div class="orderHeading">
                <span class="num" :title="entry.summary.orderNumber">{{ entry.summary.orderNumber }}</span>
                <time class="orderTime" :datetime="entry.summary.updatedAt" :title="'更新时间 ' + entry.summary.updatedAt">{{ fmtTime(entry.summary.updatedAt).slice(0, 11) }}</time>
                <span v-if="store.workflowOrders[entry.summary.orderNumber]?.error" class="orderWarning"
                  role="img" :aria-label="workflowLabel(entry.summary.orderNumber)"
                  :title="store.workflowOrders[entry.summary.orderNumber]?.error ?? undefined">!</span>
              </div>
              <div v-if="parseMeta(entry.summary.metadata)?.layoutNumber || (orderFilter === 'all' && isOrderComplete(entry.summary.orderNumber)) || finishLabel(entry.summary.orderNumber) || canDelete" class="orderDetails">
                <div class="orderDescriptors">
                  <span v-if="parseMeta(entry.summary.metadata)?.layoutNumber" class="orderCode">{{ parseMeta(entry.summary.metadata)?.layoutNumber }}</span>
                  <span v-if="orderFilter === 'all' && isOrderComplete(entry.summary.orderNumber)" class="orderDone">已完成</span>
                </div>
                <button
                  v-if="finishLabel(entry.summary.orderNumber)"
                  class="miniBtn finishBtn"
                  type="button"
                  :disabled="workflowBusy"
                  @click.stop="requestFinish(entry.summary.orderNumber)"
                >{{ finishLabel(entry.summary.orderNumber) }}</button>
                <button
                  v-if="canDelete"
                  class="itemDel"
                  type="button"
                  title="删除订单（素材文件保留）"
                  aria-label="删除订单"
                  @click.stop="removeOrder(entry.summary.id)"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M6 6l1 15a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-15"/><path d="M10 11v6M14 11v6"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- 展开区：素材行 + 编辑面板 + 成品 -->
          <div v-if="expandedOrderId === entry.summary.id" class="imgRows">
            <div
              v-for="img in entry.images"
              :key="img.id"
              class="imgBlock"
              :class="{ busy: busyImageId === img.id }"
            >
              <div class="imgRow">
                <div class="materialTile">
                  <button v-if="img.thumbnailPath || img.filePath" class="thumb thumbButton" type="button"
                    :title="img.originalName" :aria-label="'预览素材 ' + img.originalName" @click="showMaterial(img)">
                    <img :src="assetUrl(img.thumbnailPath || img.filePath)" alt="" />
                  </button>
                  <span v-else class="thumb placeholder" aria-hidden="true">图</span>
                  <div v-if="img.thumbnailPath || img.filePath" class="materialFacts">
                    <span v-if="img.width > 0 && img.height > 0" :title="`${img.width} × ${img.height} px`">{{ img.width }}×{{ img.height }}</span>
                    <div class="materialFileActions">
                      <span>{{ formatBytes(img.byteLength) }}</span>
                      <button class="materialIcon" type="button"
                        :title="img.sourceQuality === 'scaled' ? '下载缩略图' : '下载素材'"
                        :aria-label="(img.sourceQuality === 'scaled' ? '下载缩略图 ' : '下载素材 ') + img.originalName"
                        :disabled="!!savingImageId || !img.filePath || img.syncStatus === 'downloading'" @click="saveImage(img)">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg>
                      </button>
                    </div>
                  </div>
                </div>
                <div class="imgInfo">
                  <div v-if="qualityLabel(img) || syncLabel(img)" class="imageLabels" :title="img.syncError">
                    <span v-if="qualityLabel(img)" class="caution">{{ qualityLabel(img) }}</span>
                    <span v-if="syncLabel(img)" class="syncLabel" :class="img.syncStatus">{{ syncLabel(img) }}</span>
                  </div>
                  <div class="specSection" role="group" aria-label="待制作规格">
                    <div class="rules">
                      <span v-if="!img.templates.length" class="specEmpty">请在下方勾选规格</span>
                      <span v-for="spec in specificationsFor(img).filter(spec => spec.quantity !== null)" :key="spec.webId" class="ruleGroup">
                        <span class="selectedSpec">{{ spec.code }} × {{ spec.quantity }}</span>
                        <button
                          type="button"
                          class="makeBtn"
                          :disabled="workflowBusy || !!busyImageId || !!makeBlockReason(img)"
                          :title="makeBlockReason(img) || spec.name"
                          :aria-label="`制作 ${spec.code}`"
                          @click.stop="injectImage(img, entry.summary, spec.webId)"
                        >制作</button>
                      </span>
                    </div>
                  </div>
                  <div class="specSection" role="group" aria-label="全部模板规格">
                    <span class="specLabel">全部模板规格</span>
                    <div class="rules">
                      <button
                        v-for="spec in specificationsFor(img)"
                        :key="spec.webId"
                        type="button"
                        role="checkbox"
                        class="ruleChip"
                        :aria-checked="spec.quantity !== null"
                        :aria-label="`${spec.code} ${spec.name}`"
                        :title="spec.name"
                        :disabled="workflowBusy || editingTemplateIds.has(img.id)"
                        @click.stop="toggleTemplate(img, spec.webId)"
                      >{{ spec.code }}</button>
                    </div>
                  </div>
                </div>
                <button
                  v-if="canDelete"
                  class="imgDel"
                  title="删除素材（归档文件保留）"
                  aria-label="删除素材"
                  @click.stop="removeImage(img.id)"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M6 6l1 15a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-15"/></svg>
                </button>
              </div>

              <p v-if="img.syncError" class="assetError">{{ img.syncError }}</p>
            </div>

            <div v-if="!entry.images.length" class="noImages">该订单还没有素材。</div>

            <!-- 成品（制作端回传） -->
            <div v-if="orderProductions(entry.summary.orderNumber).length" class="prodRow">
              <div class="prodLabel">成品 {{ orderProductions(entry.summary.orderNumber).length }}</div>
              <div class="prodList">
                <div
                  v-for="prod in orderProductions(entry.summary.orderNumber)"
                  :key="prod.id"
                  class="prodTile"
                  :title="prod.syncError || prod.filePath.split(/[\\\\/]/).pop()"
                >
                  <button v-if="prod.filePath" class="prodThumb" aria-label="打开本地成品" @click="openImage(prod.filePath)">
                    <img :src="assetUrl(prod.filePath)" alt="" />
                  </button>
                  <span v-else class="prodThumb placeholder" aria-hidden="true">成品</span>
                  <span v-if="syncLabel(prod)" class="syncLabel" :class="prod.syncStatus">{{ syncLabel(prod) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div v-if="!visibleEntries.length && searchTerm" class="empty">没有找到匹配的订单。</div>
        <div v-else-if="!visibleEntries.length" class="empty">
          <template v-if="orderFilter === 'completed'">本机暂无已完成订单。</template>
          <template v-else-if="orderFilter === 'all'">本机暂无订单。</template>
          <template v-else>
            暂无待制作订单。<br />{{ store.workflow.role === 'production' ? '同步后会显示已接收的订单。' : '在千帆客服里右键买家图片 → 进入排单。' }}
          </template>
        </div>
      </div>
    </aside>

    <!-- 右栏：常驻编辑器 -->
    <section class="editorWrap glass">
      <div class="editorBar">
        <span class="makingFor" v-if="lastInjectedOrder">制作中：订单 {{ lastInjectedOrder }}</span>
        <span class="dim" v-else>从左侧选择规格「制作」开始排版</span>
      </div>
      <div class="editorBox">
        <div v-if="!editorSrc" class="loading">
          <button class="miniBtn" @click="openEditor">打开编辑器</button>
        </div>
        <div v-else-if="!editorReady" class="loading">正在加载爱心星星编辑器…</div>
        <iframe
          v-if="editorSrc"
          ref="frame"
          class="frame"
          :src="editorSrc"
          title="素材制作编辑器"
          @load="onFrameLoad"
        ></iframe>
      </div>
      <div v-if="status || exportStatus" class="status" role="status">
        <div v-if="status">{{ status }}</div>
        <div v-if="exportStatus">{{ exportStatus }}</div>
      </div>
    </section>

    <!-- 订单悬浮详情卡 -->
    <div
      v-if="hoverOrderId"
      class="hoverCard"
      :style="{ left: hoverPos.x + 'px', top: hoverPos.y + 'px' }"
    >
      <template v-for="entry in visibleEntries" :key="'hc-' + entry.summary.id">
        <template v-if="entry.summary.id === hoverOrderId">
          <div class="hcTitle">{{ entry.summary.orderNumber }}</div>
          <template v-if="parseMeta(entry.summary.metadata)">
            <div class="hcRow" v-if="parseMeta(entry.summary.metadata)!.status">
              <span class="hcLabel">状态</span>{{ parseMeta(entry.summary.metadata)!.status }}
            </div>
            <div class="hcRow" v-if="parseMeta(entry.summary.metadata)!.amount">
              <span class="hcLabel">金额</span>¥{{ parseMeta(entry.summary.metadata)!.amount }}
            </div>
            <div class="hcRow" v-if="parseMeta(entry.summary.metadata)!.specText">
              <span class="hcLabel">规格</span>{{ parseMeta(entry.summary.metadata)!.specText }}
            </div>
          </template>
          <div v-else class="hcRow dim">暂无千帆面板详情（该订单在功能上线前排单）</div>
          <div class="hcRow"><span class="hcLabel">素材</span>{{ entry.images.length }} 张</div>
        </template>
      </template>
    </div>

    <dialog ref="materialDialog" class="materialDialog" aria-labelledby="material-preview-title"
      @click.self="materialDialog?.close()" @close="previewMaterial = null">
      <div v-if="previewMaterial" class="materialView">
        <header class="materialViewBar">
          <h2 id="material-preview-title">{{ previewMaterial.originalName }}</h2>
          <button class="materialIcon" type="button" aria-label="关闭素材预览" title="关闭" autofocus @click="materialDialog?.close()">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </header>
        <div class="materialStage">
          <img v-if="!materialPreviewFailed" :src="assetUrl(materialPath)" :alt="previewMaterial.originalName" @error="materialPreviewFailed = true" />
          <p v-else class="dim" role="status">无法读取这张素材。</p>
        </div>
        <footer class="materialViewBar materialViewFooter">
          <div class="materialViewFacts">
            <span v-if="previewMaterial.width > 0 && previewMaterial.height > 0">{{ previewMaterial.width }} × {{ previewMaterial.height }} px</span>
            <span v-if="previewMaterial.byteLength > 0">{{ formatBytes(previewMaterial.byteLength) }}</span>
            <span v-if="previewMaterial.sourceQuality === 'scaled' || !previewMaterial.filePath">缩略图</span>
          </div>
          <button class="materialIcon" type="button"
            :title="previewMaterial.sourceQuality === 'scaled' ? '下载缩略图' : '下载素材'"
            :aria-label="(previewMaterial.sourceQuality === 'scaled' ? '下载缩略图 ' : '下载素材 ') + previewMaterial.originalName"
            :disabled="!!savingImageId || !previewMaterial.filePath || previewMaterial.syncStatus === 'downloading'" @click="saveImage(previewMaterial)">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg>
          </button>
        </footer>
      </div>
    </dialog>

    <!-- 快捷键指南 -->
    <dialog
      class="guideDialog"
      @click="showShortcutGuide = false"
      @cancel.prevent="showShortcutGuide = false"
    >
      <div class="guideBox" @click.stop>
        <div class="guideHead">
          <h2>快捷键指南</h2>
          <button class="guideClose" @click="showShortcutGuide = false">×</button>
        </div>
        <p class="guideNote">先点击画板再使用快捷键。</p>
        <section v-for="g in shortcutGroups" :key="g.title" class="guideGroup">
          <h3>{{ g.title }}</h3>
          <div v-for="item in g.items" :key="item.action" class="guideItem">
            <div class="guideLine">
              <span class="guideAction">{{ item.action }}</span>
              <span class="guideKeys"><kbd v-for="k in item.keys" :key="k">{{ k }}</kbd></span>
            </div>
            <p class="guideNote">{{ item.note }}</p>
          </div>
        </section>
        <p class="guideNote">按 Esc、点击 × 或弹窗外部可关闭。</p>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.body {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 12px;
  padding: 12px;
}
.list {
  width: 340px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.listHead {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  padding: 12px 14px 8px;
  font-weight: 700;
}
.listHead span {
  flex: 1;
}
.orderTools {
  display: flex;
  gap: 6px;
  margin: 0 12px 9px;
}
.orderSearch {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  min-height: 32px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-dim);
}
.orderSearch:focus-within {
  border-color: var(--accent);
}
.orderSearch input {
  flex: 1;
  min-width: 0;
  padding: 5px 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
}
.orderFilter {
  flex-shrink: 0;
  padding: 0 6px 0 8px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.iconBtn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.items {
  overflow-y: auto;
  padding: 0 10px 10px;
  flex: 1;
}
.orderBlock {
  margin-bottom: 6px;
}
.item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.uploadCheck {
  flex: 0 0 auto;
  margin: 2px 0 0;
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}
.chevron {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--text-dim);
  transition: transform 0.15s;
}
.chevron.open {
  transform: rotate(90deg);
}
.itemMain {
  flex: 1;
  min-width: 0;
}
.orderHeading {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.num {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
  font-size: 13px;
}
.orderTime {
  flex-shrink: 0;
  color: #52647d;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.orderDetails {
  display: flex;
  align-items: center;
  gap: 5px;
}
.orderDescriptors {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.orderCode {
  color: var(--accent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.orderDone {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}
.orderWarning {
  flex-shrink: 0;
  color: var(--danger);
  font-size: 12px;
  font-weight: 700;
}
.dim {
  color: var(--text-dim);
  font-size: 11px;
}
.itemDel {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}
.item:hover .itemDel, .itemDel:focus-visible {
  opacity: 1;
}
.itemDel:hover {
  background: rgba(255, 107, 107, 0.15);
  color: var(--danger);
}
.item:hover {
  background: var(--bg-card-hover);
}
.item.on {
  background: rgba(56, 107, 255, 0.08);
  border: 1px solid rgba(56, 107, 255, 0.35);
  border-bottom: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}
.item.on + .imgRows {
  background: rgba(56, 107, 255, 0.05);
  border: 1px solid rgba(56, 107, 255, 0.22);
  border-top: none;
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
}
.imgRows {
  padding: 2px 4px 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.imgBlock {
  border-radius: var(--radius-sm);
}
.imgRow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 6px;
  border-radius: var(--radius-sm);
}
.imgRow:hover {
  background: var(--bg-card-hover);
}
.imgBlock.busy {
  opacity: 0.55;
  pointer-events: none;
}
.thumb {
  width: 64px;
  height: 64px;
  border-radius: 7px;
  background: var(--bg-input);
}
.materialTile {
  flex: 0 0 68px;
  min-width: 0;
}
.thumbButton {
  display: block;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--stroke);
  cursor: zoom-in;
}
.thumbButton:hover {
  border-color: var(--accent);
}
.thumbButton img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.materialFacts {
  display: grid;
  width: max-content;
  max-width: 100%;
  margin-top: 3px;
  color: #52647d;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.materialFileActions {
  display: flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.materialIcon {
  display: inline-grid;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}
.materialIcon:hover:not(:disabled) {
  background: var(--accent-soft);
}
.materialIcon:disabled {
  color: var(--text-dim);
  opacity: .45;
  cursor: default;
}
.placeholder {
  display: inline-grid;
  place-items: center;
  color: #52647d;
  font-size: 11px;
}
.imgInfo {
  flex: 1;
  min-width: 0;
}
.imageLabels {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1px 8px;
  margin-bottom: 4px;
  color: #52647d;
  font-size: 11px;
}
.syncLabel {
  color: #52647d;
  font-size: 11px;
}
.syncLabel.synced {
  color: #14704f;
}
.syncLabel.failed, .assetError {
  color: #a43138;
}
.syncLabel.downloading, .syncLabel.uploading {
  color: #2458be;
}
.caution {
  color: #81500c;
}
.assetError {
  font-size: 11px;
  margin: 0 6px 4px;
  overflow-wrap: anywhere;
}
.rules {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.specSection + .specSection {
  margin-top: 6px;
}
.specLabel, .specEmpty {
  display: block;
  font-size: 11px;
  color: var(--text-dim);
}
.specLabel {
  margin-bottom: 3px;
}
.ruleGroup {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  overflow: hidden;
  border: 1px solid var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}
.selectedSpec {
  padding: 2px 8px;
  font-size: 11px;
  white-space: nowrap;
}
.ruleChip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  padding: 2px 4px;
  border: 1px solid var(--stroke);
  border-radius: 5px;
  background: var(--bg-input);
  color: var(--text-dim);
  font-family: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.ruleChip::before {
  content: '';
  display: grid;
  place-content: center;
  width: 10px;
  height: 10px;
  border: 1px solid currentColor;
  border-radius: 2px;
}
.ruleChip[aria-checked="true"]::before {
  content: '✓';
  background: var(--accent);
  border-color: var(--accent);
  color: white;
  font-size: 9px;
}
.ruleChip:disabled {
  cursor: default;
}
.ruleChip:hover:not(:disabled),
.ruleChip[aria-checked="true"] {
  background: var(--accent-soft);
  color: var(--accent);
}
.ruleChip:focus-visible {
  outline-offset: -2px;
}
.makeBtn {
  border: none;
  font-size: 11px;
  padding: 2px 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}
.makeBtn:hover:not(:disabled) {
  background: #2f5fe0;
}
.makeBtn:disabled, .miniBtn:disabled {
  opacity: .55;
  cursor: default;
}
.imgDel {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}
.imgRow:hover .imgDel, .imgDel:focus-visible {
  opacity: 1;
}
.imgDel:hover {
  background: rgba(255, 107, 107, 0.15);
  color: var(--danger);
}
.noImages {
  font-size: 11px;
  color: var(--text-dim);
  padding: 2px 8px 4px;
}
.miniBtn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 8px;
  border: 1px solid var(--stroke);
  background: var(--bg-input);
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
/* 成品 */
.prodRow {
  padding: 6px 8px 4px 8px;
  border-top: 1px dashed var(--stroke);
}
.prodLabel {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.prodList {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.prodTile {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 0 0 84px;
  text-align: center;
}
.prodThumb {
  width: 56px;
  height: 56px;
  overflow: hidden;
  border-radius: 8px;
  padding: 0;
  background: #f0f3f8;
  border: 1px solid var(--stroke);
}
button.prodThumb {
  cursor: pointer;
}
.prodThumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
button.prodThumb:hover {
  border-color: rgba(91, 140, 255, 0.5);
}
.finishBtn { flex: 0 0 auto; white-space: nowrap; }
.empty {
  padding: 18px;
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
  line-height: 2;
}
/* 右栏编辑器 */
.editorWrap {
  flex: 1;
  min-width: 1150px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.editorBar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--stroke);
  font-size: 12px;
  flex-shrink: 0;
}
.makingFor {
  font-weight: 700;
  color: var(--accent);
}
.editorBox {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}
.frame {
  flex: 1;
  min-width: 1150px;
  border: none;
  background: #fff;
}
.loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 13px;
  z-index: 1;
  background: var(--bg-card);
}
.status {
  padding: 6px 14px;
  font-size: 11px;
  color: var(--text-dim);
  background: #f7f9fc;
  border-top: 1px solid var(--stroke);
  overflow-wrap: anywhere;
  flex-shrink: 0;
}
.hoverCard {
  position: fixed;
  z-index: 90;
  width: 240px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--stroke);
  border-radius: 10px;
  box-shadow: 0 10px 32px rgba(40, 60, 100, 0.18);
  pointer-events: none;
}
.hcTitle {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.hcRow {
  font-size: 11px;
  color: var(--text);
  padding: 2px 0;
}
.hcRow.dim,
.dim {
  color: var(--text-dim);
}
.hcLabel {
  display: inline-block;
  width: 40px;
  color: var(--text-dim);
}
.materialDialog {
  width: min(840px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  padding: 0;
  border: 1px solid var(--stroke);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text);
}
.materialDialog::backdrop {
  background: rgba(22, 32, 48, .65);
}
.materialViewBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px;
}
.materialViewBar h2 {
  min-width: 0;
  overflow: hidden;
  margin: 0;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.materialViewBar .materialIcon {
  width: 32px;
  height: 32px;
}
.materialStage {
  display: grid;
  min-height: 120px;
  place-items: center;
  padding: 12px;
  background: var(--bg-base);
}
.materialStage img {
  display: block;
  max-width: 100%;
  max-height: 68dvh;
  object-fit: contain;
}
.materialViewFooter {
  border-top: 1px solid var(--stroke);
}
.materialViewFacts {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 14px;
  color: #52647d;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.guideDialog {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  border: 1px solid var(--stroke);
  border-radius: 14px;
  background: var(--bg-card);
  padding: 20px;
  color: var(--text);
}
.guideDialog::backdrop {
  background: rgba(30, 40, 60, 0.45);
}
.guideHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.guideHead h2 {
  margin: 0;
  font-size: 16px;
}
.guideClose {
  width: 32px;
  height: 32px;
  border: 1px solid var(--stroke);
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 16px;
  cursor: pointer;
}
.guideNote {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
  margin: 4px 0 0;
}
.guideGroup h3 {
  margin: 14px 0 6px;
  font-size: 12px;
  color: var(--accent);
}
.guideItem {
  padding: 8px 0;
  border-bottom: 1px solid var(--stroke);
}
.guideLine {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
}
.guideAction {
  font-size: 13px;
  font-weight: 600;
}
.guideKeys kbd {
  border: 1px solid var(--stroke);
  background: var(--bg-card-hover);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-dim);
  font-family: inherit;
  margin-left: 4px;
}
</style>
