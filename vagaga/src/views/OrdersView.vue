<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Boxes, Check, CircleCheck, Clock3, CloudDownload, Download, GripVertical, PanelsTopLeft, RefreshCw, RotateCcw, Search, X } from '@lucide/vue'
import OptionSelect from '../components/OptionSelect.vue'
import TemplateSaveDialog from '../components/TemplateSaveDialog.vue'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { useOrdersStore, loadOrders, refreshWorkflowOrders, toast } from '../stores/orders'
import { mountEditorExportControls } from '../lib/editor-export-controls'
import { connectTemplateEditor } from '../lib/template-editor'
import {
  assetUrl,
  copyOrderNumberToClipboard,
  cutoutImageBytes,
  deleteImage,
  deleteOrder,
  getCutoutConfig,
  getOrder,
  getOrderSort,
  listOrders,
  listProductions,
  openPath,
  saveOrderImage,
  saveOrderSort,
  saveProduction,
  setImageRemark,
  setImageTemplates,
  workflowClaimOrder,
  workflowDownloadImage,
  workflowDownloadProduction,
  workflowReleaseOrder,
  workflowResolveConflict,
  workflowSetLayout,
} from '../lib/tauri'
import type { OrderImage, OrderSort, OrderSortMode, OrderSummary, Production, SyncStatus, TemplateQty, WorkflowPreview } from '../types'

const props = defineProps<{
  visible?: boolean
  uploadableOrders?: Set<string>
  uploadSelection?: string[]
  workflowBusy?: boolean
}>()
const emit = defineEmits<{ finish: [orderNumber: string]; reopen: [orderNumber: string]; toggleUpload: [orderNumber: string, checked: boolean] }>()
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
  if (img.syncStatus === 'downloading' || downloadingImageIds.has(img.id)) return '原图正在下载'
  if (img.remoteOnly && !img.filePath) return '云端原图尚未下载，请先点击左侧缩略卡下载'
  if (!img.filePath) return '本机原图尚不可用'
  if (img.sourceQuality === 'scaled') return '制作需要原图，请先获取原图'
  if (img.sourceQuality === 'unknown') return '制作需要来源已确认的原图'
  return ''
}

const downloadingImageIds = reactive(new Set<string>())
const downloadingProdIds = reactive(new Set<string>())
const claimBusyOrders = reactive(new Set<string>())

function claimBadge(number: string) {
  if (isOrderComplete(number)) return null
  const state = store.workflowOrders[number]
  if (!state?.claimedBy) return null
  const holder = state.claimedName || state.claimedBy
  return {
    mine: Boolean(state.claimedByMe),
    holder,
    label: state.claimedByMe ? '本机制作中' : `制作中 · ${holder}`,
  }
}

async function ensureClaimBeforeMake(orderNumber: string): Promise<boolean> {
  if (!canFinish.value || typeof workflowClaimOrder !== 'function') return true
  const existing = store.workflowOrders[orderNumber]
  let force = false
  if (existing?.claimedBy && !existing.claimedByMe) {
    const holder = existing.claimedName || existing.claimedBy
    if (!confirm(`订单 ${orderNumber} 正由「${holder}」制作中，是否强制接手制作？`)) {
      return false
    }
    force = true
  }
  try {
    let res = await workflowClaimOrder(orderNumber, force)
    if (!res.ok) {
      if (res.claimedBy) {
        if (!confirm(`${res.message ?? '该订单正由其他设备制作中'}，是否强制接手制作？`)) {
          status.value = res.message ?? '已取消接手。'
          await refreshWorkflowOrders().catch(() => {})
          return false
        }
        res = await workflowClaimOrder(orderNumber, true)
      }
      if (!res.ok) {
        toast('error', res.message ?? '无法认领该订单。')
        await Promise.all([loadOrders(), refreshWorkflowOrders()]).catch(() => {})
        return false
      }
    }
    void refreshWorkflowOrders().catch(() => {})
    return true
  } catch {
    // 单机或离线制作不阻断本地打开画板
    return true
  }
}

async function releaseClaim(orderNumber: string) {
  if (claimBusyOrders.has(orderNumber) || typeof workflowReleaseOrder !== 'function') return
  claimBusyOrders.add(orderNumber)
  try {
    await workflowReleaseOrder(orderNumber, false)
    await refreshWorkflowOrders()
    toast('ok', `已释放订单 ${orderNumber} 的制作状态。`)
  } catch (error) {
    toast('error', `释放失败：${error}`)
  } finally {
    claimBusyOrders.delete(orderNumber)
  }
}

function requestReopen(orderNumber: string) {
  if (props.workflowBusy) return
  if (!confirm(`确认将已完成订单 ${orderNumber} 返工重开为待制作？重开后可继续补图或重新交付成品。`)) return
  emit('reopen', orderNumber)
}

/* ---------- 左栏数据：订单 + 素材树 ---------- */
const entries = ref<{ summary: OrderSummary; images: OrderImage[] }[]>([])
const orderSearch = ref('')
const orderFilter = ref<'pending' | 'completed' | 'all'>('pending')
const orderFilters = [
  { id: 'pending', label: '待制作', detail: '查看还需要制作的订单', icon: Clock3 },
  { id: 'completed', label: '已完成', detail: '查看已标记完成的订单', icon: CircleCheck },
  { id: 'all', label: '全部订单', detail: '查看所有制作状态', icon: Boxes },
] as const
const orderSort = ref<OrderSort>({ mode: 'time-desc', manual: [] })
const sortReady = ref(false)
const sortOptions = [
  { id: 'time-desc', label: '下单时间 · 新到旧', icon: Clock3 },
  { id: 'time-asc', label: '下单时间 · 旧到新', icon: Clock3 },
  { id: 'amount-desc', label: '价格 · 高到低', icon: ArrowDown },
  { id: 'amount-asc', label: '价格 · 低到高', icon: ArrowUp },
  { id: 'manual', label: '手动排序', icon: GripVertical },
] as const
const draggedOrder = ref<string | null>(null)
const dropTarget = ref<string | null>(null)

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
const sortedOrders = computed(() => {
  const { mode, manual } = orderSort.value
  const ranks = new Map(manual.map((number, index) => [number, index]))
  const orders = store.orders.map(summary => {
    const meta = parseMeta(summary.metadata)
    const orderedAt = meta?.orderedAt
    const placedAt = typeof orderedAt === 'string' && Number.isFinite(Date.parse(orderedAt)) ? orderedAt : null
    const priceText = String(meta?.amount ?? '').trim()
    const amount = /^[¥￥]?\s*\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(priceText)
      ? Number(priceText.replace(/[¥￥,\s]/g, '')) : null
    return {
      summary, placedAt,
      time: Date.parse(placedAt ?? summary.createdAt) || 0,
      amount: amount !== null && Number.isFinite(amount) ? amount : null,
    }
  })
  return orders.sort((a, b) => {
    if (mode === 'manual') {
      const rank = (number: string) => ranks.get(number) ?? manual.length
      const byRank = rank(a.summary.orderNumber) - rank(b.summary.orderNumber)
      if (byRank) return byRank
    }
    if (mode === 'amount-desc' || mode === 'amount-asc') {
      if (a.amount === null || b.amount === null) {
        return Number(a.amount === null) - Number(b.amount === null) || b.time - a.time
      }
      const byAmount = a.amount - b.amount
      if (byAmount) return mode === 'amount-asc' ? byAmount : -byAmount
    }
    return mode === 'time-asc' ? a.time - b.time : b.time - a.time
  })
})
const visibleEntries = computed(() => {
  const byId = new Map(entries.value.map(entry => [entry.summary.id, entry.images]))
  return sortedOrders.value.filter(entry => matchesOrder(entry.summary)).map(entry => ({
    ...entry, images: byId.get(entry.summary.id) ?? [],
  }))
})

let sortWrites = Promise.resolve()
function persistOrderSort(sort: OrderSort) {
  orderSort.value = sort
  sortWrites = sortWrites.then(() => saveOrderSort(sort))
    .catch(error => toast('error', '保存订单排序失败：' + error))
}

function changeOrderSort(mode: OrderSortMode) {
  const current = orderSort.value
  if (mode === current.mode) return
  endOrderDrag()
  const manual = mode === 'manual' && !current.manual.length
    ? sortedOrders.value.map(entry => entry.summary.orderNumber) : current.manual
  persistOrderSort({ mode, manual })
}

function moveOrder(from: string, to: string) {
  if (orderSort.value.mode !== 'manual' || from === to) return
  const visible = visibleEntries.value.map(entry => entry.summary.orderNumber)
  const source = visible.indexOf(from)
  const target = visible.indexOf(to)
  if (source < 0 || target < 0) return
  visible.splice(source, 1)
  visible.splice(target, 0, from)
  const visibleNumbers = new Set(visible)
  let index = 0
  const manual = sortedOrders.value.map(({ summary }) => visibleNumbers.has(summary.orderNumber)
    ? visible[index++] : summary.orderNumber)
  persistOrderSort({ mode: 'manual', manual })
}

function moveOrderStep(number: string, direction: number) {
  const rows = visibleEntries.value
  const index = rows.findIndex(entry => entry.summary.orderNumber === number)
  const target = rows[index + direction]
  if (target) moveOrder(number, target.summary.orderNumber)
}

function startOrderDrag(number: string, event: DragEvent) {
  if (!event.dataTransfer) return
  event.stopPropagation()
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', number)
  draggedOrder.value = number
  hoverOrderId.value = null
}

function hoverOrderDrop(number: string, event: DragEvent) {
  if (!draggedOrder.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dropTarget.value = number === draggedOrder.value ? null : number
}

function dropOrder(number: string, event: DragEvent) {
  if (!draggedOrder.value) return
  event.preventDefault()
  event.stopPropagation()
  moveOrder(draggedOrder.value, number)
  endOrderDrag()
}

function endOrderDrag() {
  draggedOrder.value = null
  dropTarget.value = null
}

function matchesOrder(order: OrderSummary) {
  if (orderFilter.value !== 'all' && (orderFilter.value === 'completed') !== isOrderComplete(order.orderNumber)) return false
  const term = searchTerm.value
  return !term || order.orderNumber.toLowerCase().includes(term)
    || (parseMeta(order.metadata)?.layoutNumber?.toLowerCase().includes(term) ?? false)
}

let sourcesRequest = 0
async function refreshSources(summaries?: OrderSummary[]) {
  const request = ++sourcesRequest
  if (store.entries !== null) {
    if (!summaries) {
      entries.value = store.entries.filter(entry => matchesOrder(entry.summary))
      return
    }
    const byId = new Map(store.entries.map(entry => [entry.summary.id, entry.images]))
    entries.value = summaries.filter(matchesOrder).map(summary => ({
      summary,
      images: byId.get(summary.id) ?? [],
    }))
    return
  }
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
  return productions
}

function chooseOrder(id: string) {
  void persistLayout().catch(reportLayoutError)
  expandedOrderId.value = expandedOrderId.value === id ? null : id
}

async function copyOrderNumber(orderNumber: string) {
  try {
    await copyOrderNumberToClipboard(orderNumber)
    toast('ok', '订单号已复制')
  } catch (error) {
    toast('error', `复制订单号失败：${error}`)
  }
}

/* ---------- 模板编号映射 ---------- */
function codeOf(templateId: string): string {
  return (
    store.info?.templates.find(t => t.webId === templateId)?.code ??
    templateId.replace(/\.[^.]+$/, '')
  )
}

function webIdOf(templateId: string): string {
  const template = store.info?.templates.find(t => t.code === templateId)
  return template?.legacyWebId ?? template?.webId ?? templateId
}

function specificationsFor(img: OrderImage) {
  const assigned = new Map(img.templates.map(t => [webIdOf(t.templateId), t.quantity]))
  const available = (store.info?.templates ?? []).filter(item => item.enabled !== false || assigned.has(item.webId))
  const specs = available.map(({ code, name, webId }) => {
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
async function persistTemplates(img: OrderImage, next: TemplateQty[]) {
  if (props.workflowBusy || editingTemplateIds.has(img.id)) return
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

function toggleTemplate(img: OrderImage, webId: string) {
  const matches = (template: TemplateQty) => webIdOf(template.templateId) === webId
  const next = img.templates.some(matches)
    ? img.templates.filter(template => !matches(template))
    : [...img.templates, { templateId: webId, quantity: 1 }]
  return persistTemplates(img, next)
}

async function changeTemplateQuantity(img: OrderImage, webId: string, event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const current = img.templates.find(template => webIdOf(template.templateId) === webId)
  if (!current) return
  const quantity = input.valueAsNumber
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    input.value = String(current.quantity)
    toast('error', '数量请输入大于或等于 1 的整数。')
    return
  }
  if (quantity !== current.quantity) {
    await persistTemplates(img, img.templates.map(template =>
      template === current ? { ...template, quantity } : template,
    ))
  }
  input.value = String(img.templates.find(template => template.templateId === current.templateId)?.quantity ?? current.quantity)
}

const remarkDrafts = reactive<Record<string, string | undefined>>({})
const savingRemarks = reactive(new Set<string>())

async function saveRemark(img: OrderImage) {
  const draft = remarkDrafts[img.id]
  if (draft === undefined || props.workflowBusy || savingRemarks.has(img.id)) return
  const remark = draft.trim()
  savingRemarks.add(img.id)
  try {
    await setImageRemark(img.id, remark)
    img.remark = remark
    delete remarkDrafts[img.id]
    await loadOrders()
  } catch (error) {
    toast('error', `保存图片备注失败：${error}`)
  } finally {
    savingRemarks.delete(img.id)
  }
}

/* ---------- 右栏：常驻编辑器 ---------- */
const frame = ref<HTMLIFrameElement | null>(null)
const templateSaveDialog = ref<InstanceType<typeof TemplateSaveDialog> | null>(null)
const editorReady = ref(false)
const editorSrc = ref('') // 惰性加载：首次制作时才设置
const status = ref('')
const busyImageId = ref('')
const lastInjectedOrder = ref<string | null>(null)
let lastInjectedImageId: string | null = null
const numberingDrafts = new Map<string, { prefix: string; value: string }>()
const sheetOverrides = new Map<string, Partial<OrderSheets>>()
let activePlannedSheetTotal = 1
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
  const input = event.target as HTMLInputElement | null
  const id = input?.id
  if (id === 'sheetTotal' || id === 'sheetIndex') {
    const orderNumber = lastInjectedOrder.value
    if (!orderNumber || !input) return
    const override = sheetOverrides.get(orderNumber) ?? {}
    const field = id === 'sheetTotal' ? 'total' : 'index'
    const number = input.valueAsNumber
    if (Number.isInteger(number) && number >= 1 && number <= 999) override[field] = number
    else if (input.value === '') delete override[field]
    sheetOverrides.set(orderNumber, override)
    return
  }
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

function plannedSheetTotal(images: OrderImage[]) {
  const quantity = images.reduce((total, image) =>
    total + specificationsFor(image).reduce((sum, spec) => sum + Math.max(0, spec.quantity ?? 0), 0), 0)
  return Math.min(999, Math.max(1, quantity))
}

function orderSheets(orderNumber: string, plannedTotal: number, productions: Production[]): OrderSheets {
  const override = sheetOverrides.get(orderNumber)
  const total = override?.total ?? plannedTotal
  const used = new Set<number>()
  let unnumbered = 0
  for (const production of productions) {
    const file = production.filePath?.split(/[\\/]/).pop() ?? ''
    // The existing export filename stores the page across devices and restarts.
    const match = / 共\d{1,3}张·第([1-9]\d{0,2})张_/.exec(file)
    if (match) used.add(Number(match[1]))
    else unnumbered++
  }
  let index = 1
  while (index < total && (used.has(index) || unnumbered > 0)) {
    if (!used.has(index)) unnumbered--
    index++
  }
  return { total, index: override?.index ?? index }
}

function updateActiveOrderSheets(orderNumber: string) {
  if (orderNumber !== lastInjectedOrder.value) return
  frame.value?.contentWindow?.__picUpdateOrderSheets?.(
    orderNumber, orderSheets(orderNumber, activePlannedSheetTotal, orderProductions(orderNumber)),
  )
}

watch(entries, current => {
  const active = current.find(({ summary }) => summary.orderNumber === lastInjectedOrder.value)
  if (!active) return
  const total = plannedSheetTotal(active.images)
  if (total === activePlannedSheetTotal) return
  activePlannedSheetTotal = total
  updateActiveOrderSheets(active.summary.orderNumber)
})

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
  sheetOverrides.delete(orderNumber)
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
  const claim = claimBadge(orderNumber)
  if (claim && !claim.mine) {
    if (!confirm(`该订单正由「${claim.holder}」制作中，确认由本机标记完成并交付？`)) return
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

function updateEditorHeader() {
  const orderLabel = numberingDocument?.getElementById('desktopOrderNumber')
  if (orderLabel) {
    orderLabel.textContent = lastInjectedOrder.value ?? ''
    orderLabel.title = lastInjectedOrder.value ?? ''
  }
  const feedback = numberingDocument?.getElementById('desktopEditorFeedback')
  if (feedback) feedback.textContent = status.value || exportStatus.value
}

watch([lastInjectedOrder, status, exportStatus], updateEditorHeader)

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

async function injectImage(img: OrderImage, order: Pick<OrderSummary, 'id' | 'orderNumber' | 'metadata'>, templateId?: string) {
  const blocked = makeBlockReason(img)
  if (blocked) {
    status.value = blocked
    return
  }
  if (busyImageId.value || props.workflowBusy) return
  const { id, orderNumber, metadata } = order
  if (savingProductions.has(orderNumber) || frame.value?.contentWindow?.__picHasPendingExport?.()) {
    status.value = '成品正在保存，请稍后再制作。'
    return
  }
  if (!(await ensureClaimBeforeMake(orderNumber))) return
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
    if (store.info?.templates.some(item => item.custom && item.webId === template)) {
      if (!fw.__picOpenTemplate) throw new Error('编辑器无法载入本机模板。')
      await fw.__picOpenTemplate(template, lastInjectedOrder.value !== orderNumber)
    }
    const [detail, productions] = await Promise.all([getOrder(id), refreshProductions(orderNumber)])
    const total = plannedSheetTotal(detail?.images ?? [img])
    await fw.__picDoInject({
      b64,
      name: img.originalName || 'order-image.png',
      mime: blob.type || 'image/png',
      template,
      orderNumber,
      imageId: img.id,
      layoutNumber,
      numberingDraft: numberingDrafts.get(orderNumber),
      sheets: orderSheets(orderNumber, total, productions),
    })
    activePlannedSheetTotal = total
    lastInjectedOrder.value = orderNumber
    lastInjectedImageId = img.id
    lastExport.value = null
    status.value = ''
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
        removeWatermark?: boolean
        b64?: string
        fileName?: string
        orderNumber?: string | null
        imageId?: string | null
        sheetIndex?: number
        action?: string
      }
    | null
  if (data?.type === 'heart-star-toolbar' && data.action === 'shortcuts') {
    showShortcutGuide.value = true
    return
  }
  if (data?.type === 'pic-cutout-request') {
    const action = data.removeWatermark === true ? '去水印' : 'AI 抠图'
    status.value = action + '处理中…'
    try {
      const config = await getCutoutConfig()
      const timeoutSecs = config.timeoutSecs >= 30 ? config.timeoutSecs : 90
      editor.postMessage(
        { type: 'pic-cutout-started', id: data.id, timeoutMs: timeoutSecs * 2000 + 15000 },
        '*',
      )
      const result = await cutoutImageBytes(data.dataB64 ?? '', data.removeWatermark === true)
      if (editor !== frame.value?.contentWindow) return
      status.value = action + (result.cached ? '完成（缓存命中）。' : '完成。')
      editor.postMessage(
        { type: 'pic-cutout-response', id: data.id, pngB64: result.pngB64, cached: result.cached },
        '*',
      )
    } catch (error) {
      if (editor !== frame.value?.contentWindow) return
      status.value = `${action}失败：${error}`
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
        const override = sheetOverrides.get(orderNumber)
        if (override && override.index === data.sheetIndex) delete override.index
        updateActiveOrderSheets(orderNumber)
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
      editor.__picAcknowledgeOrderExport?.()
    }
  }
}

let unmountExportControls: (() => void) | undefined

function saveCurrentTemplate() {
  const capture = frame.value?.contentWindow?.__picCaptureTemplate
  if (capture) templateSaveDialog.value?.open(capture)
}

function refreshFrameCatalog() {
  connectTemplateEditor(frame.value?.contentWindow, store.info?.templates ?? [], saveCurrentTemplate)
}

watch(() => store.info?.templates, refreshFrameCatalog)

function onFrameLoad() {
  removeNumberingListeners()
  unmountExportControls?.()
  numberingDocument = frame.value?.contentDocument ?? null
  unmountExportControls = numberingDocument ? mountEditorExportControls(numberingDocument) : undefined
  numberingDocument?.addEventListener('input', onNumberingEdit)
  numberingDocument?.addEventListener('change', onNumberingEdit)
  refreshFrameCatalog()
  editorReady.value = true
  updateEditorHeader()
}

function productionName(production: Production) {
  const fileName = production.filePath.split(/[\\/]/).pop() || production.originalName || '成品图片'
  const archivePrefix = production.id + '_'
  return fileName.startsWith(archivePrefix) ? fileName.slice(archivePrefix.length) : fileName
}

async function openOrDownloadProduction(prod: Production) {
  if (prod.filePath) {
    await showMaterial(prod)
    return
  }
  if (downloadingProdIds.has(prod.id) || typeof workflowDownloadProduction !== 'function') return
  downloadingProdIds.add(prod.id)
  try {
    const downloaded = await workflowDownloadProduction(prod.id)
    const list = productionsByOrder.value[prod.orderNumber] ?? []
    productionsByOrder.value[prod.orderNumber] = list.map(item => item.id === prod.id ? downloaded : item)
    await showMaterial(downloaded)
  } catch (error) {
    toast('error', `下载云端成品失败：${error}`)
  } finally {
    downloadingProdIds.delete(prod.id)
  }
}

async function downloadCloudImage(img: OrderImage) {
  if (downloadingImageIds.has(img.id) || typeof workflowDownloadImage !== 'function') return
  downloadingImageIds.add(img.id)
  try {
    const downloaded = await workflowDownloadImage(img.id)
    await loadOrders()
    await showMaterial(downloaded)
  } catch (error) {
    toast('error', `下载云端原图失败：${error}`)
  } finally {
    downloadingImageIds.delete(img.id)
  }
}

const materialDialog = ref<HTMLDialogElement | null>(null)
const previewMaterial = ref<OrderImage | Production | null>(null)
const previewOrderImage = computed((): OrderImage | null => {
  const image = previewMaterial.value
  return image && 'templates' in image ? image : null
})
const materialPath = computed(() => previewMaterial.value?.filePath || previewOrderImage.value?.thumbnailPath || '')
const materialName = computed(() => {
  const image = previewMaterial.value
  if (!image) return ''
  return 'templates' in image ? image.originalName : productionName(image)
})
const materialPreviewFailed = ref(false)
const productionSize = ref('')

async function showMaterial(image: OrderImage | Production) {
  if ((!image.filePath && !('thumbnailPath' in image && image.thumbnailPath)) || !materialDialog.value) return
  previewMaterial.value = image
  materialPreviewFailed.value = false
  productionSize.value = ''
  await nextTick()
  const dialog = materialDialog.value
  if (dialog && !dialog.open) dialog.showModal()
}

function updateProductionSize(event: Event) {
  if (previewOrderImage.value) return
  const image = event.currentTarget as HTMLImageElement
  if (image.naturalWidth && image.naturalHeight) {
    productionSize.value = `${image.naturalWidth} × ${image.naturalHeight} px`
  }
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
  void getOrderSort().then(saved => { orderSort.value = saved })
    .catch(error => toast('error', '读取订单排序失败：' + error))
    .finally(() => { sortReady.value = true })
})

onBeforeUnmount(() => {
  void persistLayout().catch(reportLayoutError)
  removeNumberingListeners()
  unmountExportControls?.()
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
const hoveredEntry = computed(() => {
  const id = hoverOrderId.value
  if (!id || props.visible === false) return undefined
  return visibleEntries.value.find(entry => entry.summary.id === id)
})
const hoveredMeta = computed(() => parseMeta(hoveredEntry.value?.summary.metadata))
watch(hoveredEntry, entry => {
  if (!entry) hoverOrderId.value = null
})

interface OrderMeta {
  status?: string
  amount?: string | number
  orderedAt?: string
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
        <div class="orderActions" role="group" aria-label="订单同步操作">
          <slot name="workflow-actions" />
        </div>
        <Button variant="ghost" size="icon-xs" title="刷新本地列表" aria-label="刷新本地列表" @click="loadOrders().catch(error => toast('error', `刷新订单失败：${error}`))">
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
      <div class="orderTools">
        <div class="orderSearch">
          <Search class="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" aria-hidden="true" />
          <Input v-model="orderSearch" class="h-8 pl-8 text-xs md:text-xs" type="search" placeholder="搜索订单号或排版编号" aria-label="搜索订单号或排版编号" autocomplete="off" />
        </div>
        <OptionSelect v-model="orderFilter" :options="orderFilters" compact aria-label="按制作状态筛选" />
      </div>
      <div class="orderSort">
        <span>排序</span>
        <OptionSelect :model-value="orderSort.mode" :options="sortOptions" :disabled="!sortReady"
          compact aria-label="订单排序" @update:model-value="changeOrderSort" />
      </div>
      <div class="items">
        <div v-for="entry in visibleEntries" :key="entry.summary.id" class="orderBlock">
          <div
            class="item"
            :class="{ on: expandedOrderId === entry.summary.id, dropTarget: dropTarget === entry.summary.orderNumber }"
            @click="chooseOrder(entry.summary.id)"
            @mouseenter="onItemEnter(entry.summary.id, $event)"
            @mousemove="onItemMove($event)"
            @mouseleave="onItemLeave"
            @dragover="hoverOrderDrop(entry.summary.orderNumber, $event)"
            @drop="dropOrder(entry.summary.orderNumber, $event)"
          >
            <button v-if="orderSort.mode === 'manual'" class="reorderHandle" type="button" draggable="true"
              :aria-label="'调整订单 ' + entry.summary.orderNumber + ' 的顺序'"
              title="拖动调整顺序，也可按方向键 ↑ / ↓"
              @click.stop
              @dragstart="startOrderDrag(entry.summary.orderNumber, $event)"
              @dragend="endOrderDrag"
              @keydown.up.stop.prevent="moveOrderStep(entry.summary.orderNumber, -1)"
              @keydown.down.stop.prevent="moveOrderStep(entry.summary.orderNumber, 1)"
            ><GripVertical aria-hidden="true" /></button>
            <Checkbox v-if="uploadableOrders?.has(entry.summary.orderNumber)"
              class="mt-0.5"
              :model-value="uploadSelection?.includes(entry.summary.orderNumber) ?? false" :disabled="workflowBusy"
              :aria-label="'勾选订单 ' + entry.summary.orderNumber + ' 上传'" @click.stop
              @update:model-value="emit('toggleUpload', entry.summary.orderNumber, $event === true)" />
            <svg class="chevron" :class="{ open: expandedOrderId === entry.summary.id }" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
            <div class="itemMain">
              <div class="orderHeading">
                <button type="button" class="num" :title="'点击复制订单号 ' + entry.summary.orderNumber"
                  :aria-label="'复制订单号 ' + entry.summary.orderNumber"
                  @click.stop="copyOrderNumber(entry.summary.orderNumber)">{{ entry.summary.orderNumber }}</button>
                <time class="orderTime" :datetime="entry.placedAt ?? entry.summary.createdAt"
                  :title="(entry.placedAt ? '下单时间 ' : '入库时间 ') + (entry.placedAt ?? entry.summary.createdAt)"
                >{{ fmtTime(entry.placedAt ?? entry.summary.createdAt).slice(0, 11) }}</time>
                <span v-if="store.workflowOrders[entry.summary.orderNumber]?.error" class="orderWarning"
                  role="img" :aria-label="workflowLabel(entry.summary.orderNumber)"
                  :title="store.workflowOrders[entry.summary.orderNumber]?.error ?? undefined">!</span>
              </div>
              <div v-if="entry.amount !== null || parseMeta(entry.summary.metadata)?.layoutNumber || claimBadge(entry.summary.orderNumber) || isOrderComplete(entry.summary.orderNumber) || finishLabel(entry.summary.orderNumber) || canDelete" class="orderDetails">
                <div class="orderDescriptors">
                  <span v-if="parseMeta(entry.summary.metadata)?.layoutNumber" class="orderCode">{{ parseMeta(entry.summary.metadata)?.layoutNumber }}</span>
                  <span v-if="entry.amount !== null" class="orderPrice">¥{{ entry.amount.toFixed(2) }}</span>
                  <span v-if="claimBadge(entry.summary.orderNumber)" class="claimTag" :class="{ mine: claimBadge(entry.summary.orderNumber)?.mine }">
                    {{ claimBadge(entry.summary.orderNumber)?.label }}
                    <button v-if="claimBadge(entry.summary.orderNumber)?.mine" type="button" class="claimRelease"
                      :disabled="claimBusyOrders.has(entry.summary.orderNumber)" title="释放领单锁"
                      @click.stop="releaseClaim(entry.summary.orderNumber)">释放</button>
                  </span>
                  <span v-if="orderFilter === 'all' && isOrderComplete(entry.summary.orderNumber)" class="orderDone">已完成</span>
                </div>
                <Button
                  v-if="isOrderComplete(entry.summary.orderNumber)"
                  variant="outline"
                  size="xs"
                  class="finishBtn"
                  type="button"
                  :disabled="workflowBusy"
                  title="将已完成订单重开为待制作，以便补图或重新交付成品"
                  @click.stop="requestReopen(entry.summary.orderNumber)"
                ><RotateCcw aria-hidden="true" />返工重开</Button>
                <Button
                  v-else-if="finishLabel(entry.summary.orderNumber)"
                  variant="outline"
                  size="xs"
                  class="finishBtn"
                  type="button"
                  :disabled="workflowBusy"
                  @click.stop="requestFinish(entry.summary.orderNumber)"
                ><Check aria-hidden="true" />{{ finishLabel(entry.summary.orderNumber) }}</Button>
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
                  <button v-else-if="img.remoteOnly" class="thumb thumbButton placeholder cloudThumb" type="button"
                    :disabled="downloadingImageIds.has(img.id)"
                    :title="'点击下载云端素材 ' + img.originalName"
                    @click="downloadCloudImage(img)">
                    <CloudDownload class="size-4 text-primary" aria-hidden="true" />
                    <span>{{ downloadingImageIds.has(img.id) ? '下载中…' : '下载原图' }}</span>
                  </button>
                  <span v-else class="thumb placeholder" aria-hidden="true">图</span>
                  <div v-if="img.thumbnailPath || img.filePath || img.remoteOnly" class="materialFacts">
                    <span v-if="img.width > 0 && img.height > 0" :title="`${img.width} × ${img.height} px`">{{ img.width }}×{{ img.height }}</span>
                    <div class="materialFileActions">
                      <span>{{ formatBytes(img.byteLength) }}</span>
                      <Button variant="outline" size="icon-xs" type="button"
                        :title="img.sourceQuality === 'scaled' ? '下载缩略图' : '下载素材'"
                        :aria-label="(img.sourceQuality === 'scaled' ? '下载缩略图 ' : '下载素材 ') + img.originalName"
                        :disabled="!!savingImageId || !img.filePath || img.syncStatus === 'downloading'" @click="saveImage(img)">
                        <Download aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </div>
                <div v-if="qualityLabel(img) || syncLabel(img)" class="imageLabels" :title="img.syncError">
                  <span v-if="qualityLabel(img)" class="caution">{{ qualityLabel(img) }}</span>
                  <span v-if="syncLabel(img)" class="syncLabel" :class="img.syncStatus">{{ syncLabel(img) }}</span>
                </div>
                <div class="imgInfo">
                  <div class="specSection" role="group" aria-label="待制作规格">
                    <div class="selectedRules">
                      <span v-if="!img.templates.length" class="specEmpty">请在下方勾选规格</span>
                      <span v-for="spec in specificationsFor(img).filter(spec => spec.quantity !== null)" :key="spec.webId" class="ruleGroup">
                        <label class="selectedSpec" :title="spec.code + ' × ' + spec.quantity">
                          <span>{{ spec.code }} ×</span>
                          <input class="specQuantity" type="number" min="1" step="1" inputmode="numeric"
                            :value="spec.quantity" :aria-label="`${spec.code} 数量`"
                            :disabled="workflowBusy || editingTemplateIds.has(img.id)"
                            @change="changeTemplateQuantity(img, spec.webId, $event)"
                            @keydown.enter.prevent="($event.currentTarget as HTMLInputElement).blur()" />
                        </label>
                        <Button
                          type="button"
                          size="xs"
                          :disabled="workflowBusy || !!busyImageId || !!makeBlockReason(img)"
                          :title="makeBlockReason(img) || spec.name"
                          :aria-label="`制作 ${spec.code}`"
                          @click.stop="injectImage(img, entry.summary, spec.webId)"
                        >制作</Button>
                      </span>
                    </div>
                  </div>
                  <div class="specSection" role="group" aria-label="全部模板规格">
                    <span class="specLabel">全部模板规格</span>
                    <div class="allRules">
                      <button
                        v-for="spec in specificationsFor(img)"
                        :key="spec.webId"
                        type="button"
                        role="checkbox"
                        class="ruleChip"
                        :aria-checked="spec.quantity !== null"
                        :aria-label="spec.code === spec.name ? spec.name : `${spec.code} ${spec.name}`"
                        :title="spec.name"
                        :disabled="workflowBusy || editingTemplateIds.has(img.id)"
                        @click.stop="toggleTemplate(img, spec.webId)"
                      >{{ spec.code }}</button>
                    </div>
                  </div>
                  <form v-if="remarkDrafts[img.id] !== undefined" class="remarkEditor" @submit.prevent="saveRemark(img)">
                    <textarea v-model="remarkDrafts[img.id]" rows="2" aria-label="图片备注" placeholder="输入备注"
                      :disabled="workflowBusy || savingRemarks.has(img.id)" />
                    <div class="remarkActions">
                      <button type="submit" :disabled="workflowBusy || savingRemarks.has(img.id)">保存</button>
                      <button type="button" :disabled="savingRemarks.has(img.id)" @click="delete remarkDrafts[img.id]">取消</button>
                    </div>
                  </form>
                  <div v-else class="imageRemark">
                    <p v-if="img.remark">{{ img.remark }}</p>
                    <button type="button" :disabled="workflowBusy" @click="remarkDrafts[img.id] = img.remark ?? ''">
                      {{ img.remark ? '编辑备注' : '加备注' }}
                    </button>
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
                  :title="prod.syncError || productionName(prod)"
                >
                  <button v-if="prod.filePath" class="prodThumb" type="button"
                    :aria-label="'预览成品 ' + productionName(prod)" @click="showMaterial(prod)">
                    <img :src="assetUrl(prod.filePath)" alt="" />
                  </button>
                  <button v-else-if="prod.remoteOnly" class="prodThumb placeholder cloudThumb" type="button"
                    :disabled="downloadingProdIds.has(prod.id)"
                    :title="'点击下载并查看云端成品 ' + productionName(prod)"
                    :aria-label="'下载并预览成品 ' + productionName(prod)"
                    @click="openOrDownloadProduction(prod)">
                    <CloudDownload class="size-3.5 text-primary" aria-hidden="true" />
                    <span>{{ downloadingProdIds.has(prod.id) ? '下载中' : '查看成品' }}</span>
                  </button>
                  <span v-else class="prodThumb placeholder" aria-hidden="true">成品</span>
                  <span v-if="syncLabel(prod)" class="syncLabel" :class="prod.syncStatus">{{ syncLabel(prod) }}</span>
                  <span v-else-if="prod.remoteOnly && prod.byteLength" class="syncLabel">{{ formatBytes(prod.byteLength) }}</span>
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
      <div class="editorBox">
        <div v-if="!editorSrc" class="loading">
          <span class="editorPrompt">从左侧选择规格「制作」开始排版</span>
          <Button @click="openEditor"><PanelsTopLeft aria-hidden="true" />打开编辑器</Button>
          <div v-if="status" class="editorPrompt" role="status">{{ status }}</div>
        </div>
        <div v-else-if="!editorReady" class="loading" role="status">{{ status || '正在加载编辑器…' }}</div>
        <iframe
          v-if="editorSrc"
          ref="frame"
          class="frame"
          :src="editorSrc"
          title="素材制作编辑器"
          @load="onFrameLoad"
        ></iframe>
      </div>
    </section>

    <TemplateSaveDialog ref="templateSaveDialog" />

    <!-- 订单悬浮详情卡 -->
    <div
      v-if="hoveredEntry"
      class="hoverCard"
      :style="{ left: hoverPos.x + 'px', top: hoverPos.y + 'px' }"
    >
      <div class="hcTitle">{{ hoveredEntry.summary.orderNumber }}</div>
      <template v-if="hoveredMeta">
        <div class="hcRow" v-if="hoveredMeta.status">
          <span class="hcLabel">状态</span>{{ hoveredMeta.status }}
        </div>
        <div class="hcRow" v-if="hoveredEntry.amount !== null">
          <span class="hcLabel">金额</span>¥{{ hoveredEntry.amount.toFixed(2) }}
        </div>
        <div class="hcRow" v-if="hoveredEntry.placedAt">
          <span class="hcLabel">下单</span>{{ fmtTime(hoveredEntry.placedAt) }}
        </div>
        <div class="hcRow" v-if="hoveredMeta.specText">
          <span class="hcLabel">规格</span>{{ hoveredMeta.specText }}
        </div>
      </template>
      <div v-else class="hcRow dim">暂无千帆面板详情（该订单在功能上线前排单）</div>
      <div class="hcRow"><span class="hcLabel">素材</span>{{ hoveredEntry.images.length }} 张</div>
    </div>

    <dialog ref="materialDialog" class="materialDialog" aria-labelledby="material-preview-title"
      @click.self="materialDialog?.close()" @close="previewMaterial = null">
      <div v-if="previewMaterial" class="materialView">
        <header class="materialViewBar">
          <h2 id="material-preview-title">{{ materialName }}</h2>
          <Button variant="ghost" size="icon-sm" type="button" aria-label="关闭图片预览" title="关闭" autofocus @click="materialDialog?.close()">
            <X aria-hidden="true" />
          </Button>
        </header>
        <div class="materialStage">
          <img v-if="!materialPreviewFailed" :key="materialPath" :src="assetUrl(materialPath)" :alt="materialName"
            @load="updateProductionSize" @error="materialPreviewFailed = true" />
          <p v-else class="dim" role="status">无法读取这张图片。</p>
        </div>
        <footer v-if="previewOrderImage || productionSize" class="materialViewBar materialViewFooter">
          <div v-if="previewOrderImage" class="materialViewFacts">
            <span v-if="previewOrderImage.width > 0 && previewOrderImage.height > 0">{{ previewOrderImage.width }} × {{ previewOrderImage.height }} px</span>
            <span v-if="previewOrderImage.byteLength > 0">{{ formatBytes(previewOrderImage.byteLength) }}</span>
            <span v-if="previewOrderImage.sourceQuality === 'scaled' || !previewOrderImage.filePath">缩略图</span>
          </div>
          <div v-else class="materialViewFacts">{{ productionSize }}</div>
          <Button v-if="previewOrderImage" variant="outline" size="icon-sm" class="border-primary/25 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary" type="button"
            :title="previewOrderImage.sourceQuality === 'scaled' ? '下载缩略图' : '下载素材'"
            :aria-label="(previewOrderImage.sourceQuality === 'scaled' ? '下载缩略图 ' : '下载素材 ') + materialName"
            :disabled="!!savingImageId || !previewOrderImage.filePath || previewOrderImage.syncStatus === 'downloading'" @click="saveImage(previewOrderImage)">
            <Download aria-hidden="true" />
          </Button>
          <Button v-else-if="previewMaterial?.filePath" variant="outline" size="xs" type="button"
            @click="openPath(previewMaterial.filePath).catch(err => toast('error', String(err)))">
            打开成品文件
          </Button>
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
          <Button variant="ghost" size="icon-sm" aria-label="关闭快捷键指南" @click="showShortcutGuide = false"><X aria-hidden="true" /></Button>
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
  --editor-min-width: 1150px;
  --panel-gap: 8px;
  display: flex;
  flex: 1;
  min-height: 0;
  gap: var(--panel-gap);
  padding: var(--panel-gap);
}
.list {
  --list-inset: 10px;
  --list-scrollbar-width: 6px;
  width: clamp(304px, calc(100% - var(--editor-min-width) - var(--panel-gap)), 340px);
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
  padding: 8px calc(var(--list-inset) + var(--list-scrollbar-width)) 6px var(--list-inset);
  font-size: 15px;
  font-weight: 700;
}
.listHead > span {
  margin-right: auto;
  white-space: nowrap;
}
.orderActions {
  display: flex;
  gap: 6px;
}
.orderTools {
  display: flex;
  gap: 6px;
  margin: 0 calc(var(--list-inset) + var(--list-scrollbar-width)) 9px var(--list-inset);
}
.orderSearch {
  position: relative;
  flex: 1;
  min-width: 0;
}
.orderSort {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 calc(var(--list-inset) + var(--list-scrollbar-width)) 6px var(--list-inset);
  color: var(--text-dim);
  font-size: 12px;
}
.items {
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 0 var(--list-inset) 10px;
  flex: 1;
}
.items::-webkit-scrollbar {
  width: var(--list-scrollbar-width);
}
.orderBlock {
  margin-bottom: 6px;
}
.item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.item.dropTarget {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.reorderHandle {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 20px;
  height: 22px;
  border-radius: 4px;
  color: var(--text-dim);
  cursor: grab;
}
.reorderHandle:hover, .reorderHandle:focus-visible {
  background: var(--accent-soft);
  color: var(--accent);
}
.reorderHandle:active { cursor: grabbing; }
.reorderHandle svg {
  width: 15px;
  height: 15px;
  pointer-events: none;
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
  padding: 0;
  border: 0;
  background: transparent;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.num:hover, .num:focus-visible {
  color: var(--accent);
  text-decoration: underline;
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
.orderPrice {
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.orderDone {
  border-radius: 5px;
  background: #eaf7ef;
  padding: 1px 5px;
  font-size: 11px;
  color: #14704f;
  white-space: nowrap;
}
.claimTag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 5px;
  background: #fff4e5;
  border: 1px solid #f7d59c;
  padding: 1px 5px;
  font-size: 11px;
  color: #9a5700;
  white-space: nowrap;
}
.claimTag.mine {
  background: #eef4ff;
  border-color: #c5d9ff;
  color: #1d4ed8;
}
.claimRelease {
  border: none;
  background: transparent;
  padding: 0 2px;
  font: inherit;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.cloudThumb {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  font-size: 10px;
  color: var(--accent);
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
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr) auto;
  align-items: flex-start;
  gap: 8px;
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
.placeholder {
  display: inline-grid;
  place-items: center;
  color: #52647d;
  font-size: 11px;
}
.imgInfo {
  grid-area: 2 / 1 / auto / -1;
  min-width: 0;
}
.imageLabels {
  grid-area: 1 / 2;
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
.selectedRules,
.allRules {
  display: grid;
  gap: 4px;
}
.selectedRules {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 142px), 1fr));
}
.allRules {
  grid-template-columns: repeat(4, minmax(0, 1fr));
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-radius: var(--radius-sm);
  padding: 2px;
  border: 1px solid var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}
.selectedSpec {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 4px 1px 7px;
  font-size: 11px;
  white-space: nowrap;
}
.selectedSpec > span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.specQuantity {
  box-sizing: border-box;
  flex: none;
  width: 43px;
  padding: 1px 2px 1px 4px;
  border: 1px solid var(--accent-border);
  border-radius: 5px;
  background: var(--bg-input);
  color: var(--text);
  font: inherit;
}
.imageRemark, .remarkEditor {
  display: grid;
  justify-items: start;
  gap: 4px;
  margin-top: 6px;
  font-size: 11px;
}
.imageRemark p {
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 5px 7px;
  border-left: 2px solid var(--accent-border);
  background: var(--bg-input);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.remarkEditor textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid var(--stroke);
  border-radius: 5px;
  background: var(--bg-input);
  color: var(--text);
  font: inherit;
  resize: vertical;
}
.remarkActions {
  display: flex;
  gap: 4px;
}
.imageRemark button, .remarkActions button {
  padding: 2px 6px;
  border: 1px solid var(--stroke);
  border-radius: 5px;
  background: var(--bg-input);
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.imageRemark button:hover:not(:disabled), .remarkActions button:hover:not(:disabled) {
  background: var(--accent-soft);
}
.ruleChip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
  border-color: var(--accent-border);
  color: var(--accent);
}
.ruleChip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.imgDel {
  grid-area: 1 / 3;
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
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.prodTile {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.prodThumb {
  width: min(100%, 56px);
  aspect-ratio: 1;
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
  min-width: var(--editor-min-width);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.editorBox {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}
.frame {
  flex: 1;
  min-width: var(--editor-min-width);
  border: none;
  background: #fff;
}
.loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 13px;
  z-index: 1;
  background: var(--bg-card);
}
.editorPrompt {
  max-width: 70%;
  overflow-wrap: anywhere;
  text-align: center;
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
  box-shadow: 0 16px 52px #17234138;
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
