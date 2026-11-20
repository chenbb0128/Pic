<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
} from '../lib/tauri'
import type { OrderImage, OrderSummary, Production, SyncStatus } from '../types'

const store = useOrdersStore()
const qiniuEnabled = computed(() => store.qiniu?.enabled === true)
const qiniuDirectory = computed(() => qiniuEnabled.value || store.qiniu?.legacyEnabled === false)
const canDelete = computed(() => store.qiniu?.enabled === false ||
  store.qiniu?.role === 'customer' || store.qiniu?.role === 'both')
const canEditTemplates = computed(() => store.qiniu?.enabled === false || !!store.qiniu?.role)

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
  return asset.syncStatus ? syncLabels[asset.syncStatus] : qiniuEnabled.value ? syncLabels.localOnly : ''
}

function qualityLabel(img: OrderImage) {
  if (img.sourceQuality === 'scaled') return '来源为缩图'
  if (img.sourceQuality === 'original') return '原图'
  if (img.sourceQuality === 'unknown' && qiniuDirectory.value) return '原图来源未确认'
  return qiniuDirectory.value ? '历史本地素材' : ''
}

function makeBlockReason(img: OrderImage) {
  if (!store.qiniu) return '正在读取当前同步模式'
  if (img.syncStatus === 'downloading') return '原图正在下载'
  if (!img.filePath) return '本机原图尚不可用'
  if (qiniuDirectory.value && (img.sourceQuality === 'scaled' || img.sourceQuality === 'unknown')) {
    return '制作需要来源已确认的原图'
  }
  return ''
}

/* ---------- 左栏数据：订单 + 素材树 ---------- */
const entries = ref<{ summary: OrderSummary; images: OrderImage[] }[]>([])
const orderSearch = ref('')
const searchTerm = computed(() => orderSearch.value.trim().toLowerCase())
const matchingOrders = computed(() => store.orders.filter(matchesOrder))
const visibleEntries = computed(() => {
  const byId = new Map(entries.value.map(entry => [entry.summary.id, entry.images]))
  return matchingOrders.value.map(summary => ({ summary, images: byId.get(summary.id) ?? [] }))
})

function matchesOrder(order: OrderSummary) {
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

/* ---------- 展开状态：订单块 / 素材编辑面板 ---------- */
const expandedOrderId = ref<string | null>(null)
const expandedImageId = ref<string | null>(null)
const productionsByOrder = ref<Record<string, Production[]>>({})
const productionRequests = new Map<string, number>()
const expandedOrderNumber = computed(() =>
  store.orders.find(order => order.id === expandedOrderId.value)?.orderNumber,
)

async function refreshProductions(orderNumber: string) {
  const request = (productionRequests.get(orderNumber) ?? 0) + 1
  productionRequests.set(orderNumber, request)
  const productions = await listProductions(orderNumber)
  if (productionRequests.get(orderNumber) === request) {
    productionsByOrder.value[orderNumber] = productions
  }
}

function chooseOrder(id: string) {
  expandedImageId.value = null
  expandedOrderId.value = expandedOrderId.value === id ? null : id
}

function toggleImagePanel(img: OrderImage) {
  expandedImageId.value = expandedImageId.value === img.id ? null : img.id
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

/** 切换素材关联的模板（详情页 ImageCard 的同款语义，移入左栏） */
async function toggleTemplate(img: OrderImage, code: string) {
  if (!canEditTemplates.value) return
  const webId = webIdOf(code)
  const current = img.templates.map(t => ({ id: t.templateId, qty: t.quantity }))
  const exists = current.find(t => t.id === webId)
  const next = exists
    ? current.filter(t => t.id !== webId)
    : [...current, { id: webId, qty: 1 }]
  try {
    await setImageTemplates(
      img.id,
      next.map(t => ({ templateId: t.id, quantity: t.qty })),
    )
    await loadOrders()
  } catch (error) {
    toast('error', `保存模板失败：${error}`)
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
let pendingInjection: { orderNumber: string; imageId: string } | null = null
const lastExport = ref<Production | null>(null)
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
  editorSrc.value = EDITOR_URL
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

async function injectImage(img: OrderImage, orderNumber: string, templateId?: string) {
  const blocked = makeBlockReason(img)
  if (blocked) {
    status.value = blocked
    return
  }
  if (busyImageId.value) return
  busyImageId.value = img.id
  status.value = `正在读取「${img.originalName}」…`
  try {
    const response = await fetch(assetUrl(img.filePath))
    if (!response.ok) throw new Error(`读取素材失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    if (!blob.size) throw new Error('本地素材文件为空。')
    if (qiniuDirectory.value) {
      try {
        const decoded = await createImageBitmap(blob)
        decoded.close()
      } catch {
        throw new Error('本地素材无法作为图片打开。')
      }
    }
    const b64 = await blobToBase64(blob)

    const editingOrder = lastInjectedOrder.value
    if (editingOrder) {
      const draft = frame.value?.contentWindow?.__picReadOrderNumbering?.()
      if (draft?.orderNumber === editingOrder) {
        numberingDrafts.set(editingOrder, { prefix: draft.prefix, value: draft.value })
      } else {
        numberingDrafts.delete(editingOrder)
      }
    }
    const targetUrl = templateId
      ? `${EDITOR_URL}?template=${encodeURIComponent(templateId)}`
      : editorSrc.value || EDITOR_URL
    if (editorSrc.value !== targetUrl) {
      lastInjectedOrder.value = null
      lastInjectedImageId = null
      editorSrc.value = targetUrl
      editorReady.value = false
    }
    status.value = `正在注入「${img.originalName}」…`

    const isReady = () => editorReady.value && frame.value?.contentWindow?.__picTemplateLoaded === true
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
      if (!ready) throw new Error('模板加载超时，请重试。')
    }

    const fw = frame.value?.contentWindow
    if (typeof fw?.__picDoInject !== 'function') throw new Error('编辑器尚未就绪，请重试。')
    pendingInjection = { orderNumber, imageId: img.id }
    const order = store.orders.find(item => item.orderNumber === orderNumber)
    fw.__picDoInject({
      b64,
      name: img.originalName || 'order-image.png',
      mime: blob.type || 'image/png',
      template: templateId ?? '',
      orderNumber,
      layoutNumber: parseMeta(order?.metadata)?.layoutNumber ?? null,
      numberingDraft: numberingDrafts.get(orderNumber),
    })
  } catch (error) {
    pendingInjection = null
    status.value = String(error)
  } finally {
    if (!pendingInjection) busyImageId.value = ''
  }
}

/* ---------- 编辑器 → 主窗口桥 ---------- */
async function onMessage(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow) return
  const data = event.data as
    | {
        type?: string
        id?: string
        dataB64?: string
        b64?: string
        fileName?: string
        action?: string
        message?: string
        ready?: boolean
      }
    | null
  if (data?.type === 'pic-make-done') {
    if (pendingInjection) {
      lastInjectedOrder.value = pendingInjection.orderNumber
      lastInjectedImageId = pendingInjection.imageId
      pendingInjection = null
      busyImageId.value = ''
      lastExport.value = null
    }
    status.value = '素材已注入编辑器，请排版调整后导出。'
    return
  }
  if (data?.type === 'pic-make-inject-error') {
    pendingInjection = null
    busyImageId.value = ''
    status.value = `素材注入失败：${data.message}`
    return
  }
  if (data?.type === 'heart-star-toolbar' && data.action === 'shortcuts') {
    showShortcutGuide.value = true
    return
  }
  if (data?.type === 'pic-cutout-request') {
    status.value = 'AI 抠图处理中；耗时和接口结果记录在“设置 → AI 抠图”的日志中。'
    try {
      const config = await getCutoutConfig()
      const timeoutSecs = config.timeoutSecs >= 30 ? config.timeoutSecs : 90
      frame.value?.contentWindow?.postMessage(
        { type: 'pic-cutout-started', id: data.id, timeoutMs: timeoutSecs * 2000 + 15000 },
        '*',
      )
      const result = await cutoutImageBytes(data.dataB64 ?? '')
      status.value = result.cached ? 'AI 抠图完成（缓存命中）。' : 'AI 抠图完成。'
      frame.value?.contentWindow?.postMessage(
        { type: 'pic-cutout-response', id: data.id, pngB64: result.pngB64, cached: result.cached },
        '*',
      )
    } catch (error) {
      status.value = `AI 抠图失败：${error}`
      frame.value?.contentWindow?.postMessage(
        { type: 'pic-cutout-response', id: data.id, error: String(error) },
        '*',
      )
    }
    return
  }
  if (data?.type === 'pic-make-exported') {
    const orderNumber = lastInjectedOrder.value
    const imageId = lastInjectedImageId
    try {
      const saved = await saveProduction(orderNumber, data.b64 ?? '', data.fileName || '成品.png', imageId)
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
    }
  }
}

function onFrameLoad() {
  editorReady.value = true
  status.value = '编辑器已就绪：从左侧选择规格「制作」，或在编辑器内粘贴图片。'
}

function openImage(filePath: string) {
  if (filePath) void openPath(filePath).catch(error => toast('error', `打开文件失败：${error}`))
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
      <div class="orderSearch">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
        <input v-model="orderSearch" type="search" placeholder="搜索订单号或排版编号" aria-label="搜索订单号或排版编号" autocomplete="off" />
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
            <svg class="chevron" :class="{ open: expandedOrderId === entry.summary.id }" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
            <div class="itemMain">
              <div class="num">{{ entry.summary.orderNumber }}</div>
              <div v-if="parseMeta(entry.summary.metadata)?.layoutNumber" class="orderCode">{{ parseMeta(entry.summary.metadata)?.layoutNumber }}</div>
              <div class="stat">{{ entry.images.length }} 图 · {{ entry.summary.taskCount }} 任务</div>
              <div class="stat dim">{{ fmtTime(entry.summary.updatedAt) }}</div>
            </div>
            <button
              v-if="canDelete"
              class="itemDel"
              title="删除订单（素材文件保留）"
              aria-label="删除订单"
              @click.stop="removeOrder(entry.summary.id)"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M6 6l1 15a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-15"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>

          <!-- 展开区：素材行 + 编辑面板 + 成品 -->
          <div v-if="expandedOrderId === entry.summary.id" class="imgRows">
            <div
              v-for="img in entry.images"
              :key="img.id"
              class="imgBlock"
              :class="{ busy: busyImageId === img.id }"
            >
              <div
                class="imgRow"
                @click="toggleImagePanel(img)"
              >
                <svg class="chevron small" :class="{ open: expandedImageId === img.id }" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                <img v-if="img.thumbnailPath || img.filePath" class="thumb" :src="assetUrl(img.thumbnailPath || img.filePath)" alt="" />
                <span v-else class="thumb placeholder" aria-hidden="true">图</span>
                <div class="imgInfo">
                  <div v-if="qualityLabel(img) || syncLabel(img)" class="imageLabels" :title="img.syncError">
                    <span v-if="qualityLabel(img)" :class="{ caution: img.sourceQuality !== 'original' }">{{ qualityLabel(img) }}</span>
                    <span v-if="syncLabel(img)" class="syncLabel" :class="img.syncStatus">{{ syncLabel(img) }}</span>
                  </div>
                  <div class="rules">
                    <span v-if="!img.templates.length" class="noRule">未关联模板</span>
                    <span v-for="t in img.templates" :key="t.templateId" class="ruleGroup">
                      <span class="ruleChip">{{ codeOf(t.templateId) }} × {{ t.quantity }}</span>
                      <button
                        class="makeBtn"
                        :disabled="!!busyImageId || !!makeBlockReason(img)"
                        :title="makeBlockReason(img) || `注入素材并切换到 ${codeOf(t.templateId)} 模板`"
                        @click.stop="injectImage(img, entry.summary.orderNumber, t.templateId)"
                      >制作</button>
                    </span>
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

              <!-- 素材编辑面板（展开） -->
              <div v-if="expandedImageId === img.id" class="imgPanel">
                <div v-if="img.filePath" class="panelRow meta">
                  {{ img.width }}×{{ img.height }} · {{ (img.byteLength / 1024).toFixed(0) }}KB ·
                  {{ fmtTime(img.createdAt) }}
                </div>
                <div v-if="img.filePath" class="panelRow materialActions">
                  <button class="fileLink" @click="openImage(img.filePath)">打开本地文件</button>
                  <button class="fileLink" :disabled="!!savingImageId || img.syncStatus === 'downloading'" @click="saveImage(img)">
                    {{ img.sourceQuality === 'scaled' ? '另存缩略图' : '另存素材' }}
                  </button>
                </div>
                <p v-if="img.syncError" class="assetError">{{ img.syncError }}</p>
                <div class="panelRow">
                  <span class="panelLabel">制作</span>
                  <button
                    v-for="t in img.templates"
                    :key="'make-' + t.templateId"
                    class="miniBtn make"
                    :disabled="!!busyImageId || !!makeBlockReason(img)"
                    :title="makeBlockReason(img) || `注入素材并切换到 ${codeOf(t.templateId)} 模板`"
                    @click.stop="injectImage(img, entry.summary.orderNumber, t.templateId)"
                  >{{ codeOf(t.templateId) }} × {{ t.quantity }}</button>
                </div>
                <div class="panelRow" v-if="canEditTemplates">
                  <span class="panelLabel">关联模板</span>
                  <div class="tplBtns">
                    <button
                      v-for="t in store.info?.templates ?? []"
                      :key="t.code"
                      class="miniBtn tpl"
                      :class="{ on: img.templates.some(x => x.templateId === t.webId) }"
                      :title="`点击${img.templates.some(x => x.templateId === t.webId) ? '取消' : '关联'} ${t.name}`"
                      @click.stop="toggleTemplate(img, t.code)"
                    >{{ t.code }}</button>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="!entry.images.length" class="noImages">{{ qiniuEnabled ? '等待订单素材。' : '该订单还没有素材。' }}</div>

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
          暂无订单。<br />{{ qiniuEnabled && store.qiniu?.role === 'production' ? '同步后会显示已接收的订单。' : '在千帆客服里右键买家图片 → 进入排单。' }}
        </div>
      </div>
    </aside>

    <!-- 右栏：常驻编辑器 -->
    <section class="editorWrap glass">
      <div class="editorBar">
        <span class="makingFor" v-if="lastInjectedOrder">制作中：订单 {{ lastInjectedOrder }}</span>
        <span class="dim" v-else>从左侧选择规格「制作」开始排版</span>
        <span class="dim">完成后点击「下载 PNG」保存成品，回传状态见订单。</span>
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
          <div class="hcRow"><span class="hcLabel">素材</span>{{ entry.images.length }} 张 · {{ entry.summary.taskCount }} 任务</div>
        </template>
      </template>
    </div>

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
.orderSearch {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 12px 9px;
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
.chevron {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--text-dim);
  transition: transform 0.15s;
}
.chevron.open {
  transform: rotate(90deg);
}
.chevron.small {
  margin-top: 0;
}
.itemMain {
  flex: 1;
  min-width: 0;
}
.num {
  font-weight: 700;
  font-size: 13px;
}
.orderCode {
  color: var(--accent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.stat {
  font-size: 11px;
  color: var(--text);
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
.item:hover .itemDel {
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
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  cursor: pointer;
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
  width: 34px;
  height: 34px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
  background: #f0f3f8;
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
  margin: 0;
  overflow-wrap: anywhere;
}
.fileLink {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
}
.fileLink:disabled {
  color: var(--text-dim);
  cursor: wait;
}
.materialActions {
  font-size: 12px;
  gap: 14px;
}
.rules {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ruleGroup {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  overflow: hidden;
  border: 1px solid var(--accent-border);
}
.ruleChip {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--accent-soft);
  color: var(--accent);
  white-space: nowrap;
}
.makeBtn {
  border: none;
  font-size: 11px;
  padding: 2px 8px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font-family: inherit;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}
.imgRow:hover .makeBtn, .makeBtn:focus-visible {
  opacity: 1;
}
.makeBtn:hover:not(:disabled) {
  background: #2f5fe0;
}
.makeBtn:disabled, .miniBtn:disabled {
  opacity: .55;
  cursor: default;
}
.noRule {
  font-size: 11px;
  color: var(--text-dim);
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
.imgRow:hover .imgDel {
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
/* 素材编辑面板 */
.imgPanel {
  padding: 8px 10px 10px 24px;
  border-top: 1px dashed var(--stroke);
}
.panelRow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 0;
  flex-wrap: wrap;
}
.panelRow.meta {
  font-size: 11px;
  color: var(--text-dim);
}
.panelLabel {
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
  width: 58px;
  line-height: 24px;
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
.miniBtn.make {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}
.miniBtn.make:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}
.miniBtn.tpl.on {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.tplBtns {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
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
