<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BookOpen, ClipboardList, CloudDownload, CloudUpload, LayoutTemplate, LoaderCircle, Settings } from '@lucide/vue'
import { Toaster } from 'vue-sonner'
import 'vue-sonner/style.css'
import TitleBar from './components/TitleBar.vue'
import { Button } from './components/ui/button'
import OrdersView from './views/OrdersView.vue'
import WorkflowDialog from './components/WorkflowDialog.vue'
import QuickStartDialog from './components/QuickStartDialog.vue'
import SettingsView from './views/SettingsView.vue'
import TemplatesView from './views/TemplatesView.vue'
import { useOrdersStore, loadOrders, loadInfo, bindEvents, refreshQiniuStatus, refreshShops, refreshWorkflowOrders, refreshWorkflowSettings, toast } from './stores/orders'
import { markQuickStartSeen } from './lib/tauri'
import type { WorkflowPreview } from './types'

const store = useOrdersStore()
const pages = [
  { id: 'orders', label: '订单', icon: ClipboardList },
  { id: 'templates', label: '模板中心', icon: LayoutTemplate },
  { id: 'settings', label: '设置', icon: Settings },
] as const
const view = ref<typeof pages[number]['id']>('orders')
const ordersView = ref<InstanceType<typeof OrdersView> | null>(null)
const workflow = ref<InstanceType<typeof WorkflowDialog> | null>(null)
const quickStart = ref<InstanceType<typeof QuickStartDialog> | null>(null)
const finishingOrder = ref<string | null>(null)
const uploadingUnpublished = ref(false)
const selectedUploadOrders = ref<string[]>([])
const uploadableOrders = computed(() => new Set(store.workflow.role === 'production' ? [] :
  store.orders.filter(({ orderNumber, imageCount }) => {
    const state = store.workflowOrders[orderNumber]
    return (imageCount > 0 && !state?.localCompleted && state?.sharedState !== 'completed')
      || state?.pendingOperation === 'publish'
  }).map(order => order.orderNumber),
))
const uploadSelection = computed(() => {
  return selectedUploadOrders.value.filter(number => uploadableOrders.value.has(number))
})
const unpublishedOrders = computed(() => [...uploadableOrders.value].filter(number => {
  const state = store.workflowOrders[number]
  return state && !state.sharedState && !state.remoteOperationId
    && !state.localCompleted && state.pendingOperation !== 'finish'
}))

async function upload(orderNumbers: string[], unpublishedOnly = false) {
  const dialog = workflow.value
  if (!dialog || dialog.operation || !orderNumbers.length) return
  uploadingUnpublished.value = unpublishedOnly
  try {
    const uploaded = new Set(await dialog.upload(orderNumbers, unpublishedOnly))
    selectedUploadOrders.value = uploadSelection.value.filter(number => !uploaded.has(number))
  } finally {
    uploadingUnpublished.value = false
  }
}

function toggleUpload(orderNumber: string, checked: boolean) {
  selectedUploadOrders.value = checked
    ? [...uploadSelection.value, orderNumber]
    : uploadSelection.value.filter(number => number !== orderNumber)
}

function sync() {
  void workflow.value?.sync()
}

async function finish(orderNumber: string) {
  const dialog = workflow.value
  if (!dialog || dialog.operation || finishingOrder.value !== null) return
  finishingOrder.value = orderNumber
  try {
    await dialog.finish(orderNumber)
  } finally {
    finishingOrder.value = null
  }
}

function saveLayout() {
  return ordersView.value?.persistLayout() ?? Promise.resolve()
}

function applySharedVersion(target: WorkflowPreview) {
  if (!ordersView.value) throw new Error('订单列表尚未加载，请稍后重试。')
  return ordersView.value.applySharedVersion(target)
}
let stopEvents: (() => void) | undefined
let disposed = false
let quickStartDismissed = false

function dismissQuickStart() {
  if (quickStartDismissed || store.workflow.quickStartSeen) return
  quickStartDismissed = true
  void markQuickStartSeen().catch(error => {
    quickStartDismissed = false
    toast('error', `保存操作帮助状态失败：${error}`)
  })
}

async function saveLayoutBeforeClose() {
  try {
    await saveLayout()
    return true
  } catch (error) {
    toast('error', `保存排版编号失败：${error}`)
    return false
  }
}

onMounted(async () => {
  void refreshWorkflowSettings().then(() => {
    if (!quickStartDismissed && store.workflow.quickStartSeen === false) quickStart.value?.open()
  }).catch(() => {})
  void refreshShops().catch(() => {})
  void refreshWorkflowOrders().catch(() => {})
  const stop = await bindEvents()
  if (disposed) { stop(); return }
  stopEvents = stop
  await Promise.all([loadInfo(), loadOrders(), refreshQiniuStatus().catch(() => {})])
})

onBeforeUnmount(() => {
  disposed = true
  stopEvents?.()
})
</script>

<template>
  <div class="shell" @dragover.prevent @drop.prevent>
    <TitleBar :before-close="saveLayoutBeforeClose" />
    <div class="workspace">
      <nav class="rail" aria-label="主导航">
        <Button
          v-for="page in pages"
          :key="page.id"
          type="button"
          variant="ghost"
          size="icon-lg"
          class="text-muted-foreground hover:bg-primary/8 hover:text-primary aria-[current=page]:bg-primary/12 aria-[current=page]:text-primary"
          :aria-label="page.label"
          :title="page.label"
          :aria-current="view === page.id ? 'page' : undefined"
          @click="view = page.id"
        >
          <component :is="page.icon" class="size-5" aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-lg"
          class="text-muted-foreground hover:bg-primary/8 hover:text-primary"
          aria-label="操作帮助" title="操作帮助" @click="quickStart?.open()">
          <BookOpen class="size-5" aria-hidden="true" />
        </Button>
      </nav>
      <main class="pages">
        <OrdersView
          v-show="view === 'orders'"
          ref="ordersView"
          :visible="view === 'orders'"
          :upload-selection="selectedUploadOrders"
          :uploadable-orders="uploadableOrders"
          :workflow-busy="!!workflow?.operation"
          :finishing-order="finishingOrder"
          @finish="finish"
          @reopen="workflow?.reopen($event)"
          @toggle-upload="toggleUpload"
          @clear-uploads="selectedUploadOrders = []"
        >
          <template #workflow-actions>
            <Button v-if="store.workflow.role !== 'production'" type="button" size="xs"
              :disabled="!!workflow?.operation || !uploadSelection.length" @click="upload(uploadSelection)">
              <LoaderCircle v-if="workflow?.operation === 'upload' && !uploadingUnpublished" class="motion-safe:animate-spin" aria-hidden="true" />
              <CloudUpload v-else aria-hidden="true" />
              {{ workflow?.operation === 'upload' && !uploadingUnpublished ? '正在上传…' : uploadSelection.length ? `上传（${uploadSelection.length}）` : '上传' }}
            </Button>
            <Button v-if="unpublishedOrders.length || uploadingUnpublished" type="button" size="xs" variant="outline"
              title="上传所有店铺的未上传订单" :disabled="!!workflow?.operation" :aria-busy="uploadingUnpublished"
              @click="upload(unpublishedOrders, true)">
              <LoaderCircle v-if="uploadingUnpublished" class="motion-safe:animate-spin" aria-hidden="true" />
              {{ uploadingUnpublished ? '正在批量上传…' : `上传全部未上传（${unpublishedOrders.length}）` }}
            </Button>
            <Button type="button" size="xs"
              :variant="store.workflow.role === 'production' ? 'default' : 'outline'" :disabled="!!workflow?.operation" @click="sync">
              <LoaderCircle v-if="workflow?.operation === 'sync'" class="motion-safe:animate-spin" aria-hidden="true" />
              <CloudDownload v-else aria-hidden="true" />
              {{ workflow?.operation === 'sync' ? '正在同步…' : '同步' }}
            </Button>
          </template>
        </OrdersView>
        <KeepAlive>
          <TemplatesView v-if="view === 'templates'" />
        </KeepAlive>
        <SettingsView v-if="view === 'settings'" :active-order="ordersView?.lastInjectedOrder ?? null" @back="view = 'orders'" />
      </main>
    </div>
    <WorkflowDialog
      ref="workflow"
      :active-order="ordersView?.lastInjectedOrder ?? null"
      :save-layout="saveLayout"
      :apply-shared-version="applySharedVersion"
    />
    <QuickStartDialog ref="quickStart" @close="dismissQuickStart" @settings="view = 'settings'" />
    <Toaster position="top-right" :offset="{ top: 54, right: 16 }" :duration="3200"
      rich-colors close-button container-aria-label="消息提醒"
      :toast-options="{ closeButtonAriaLabel: '关闭消息' }" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.workspace,
.pages {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.rail {
  display: flex;
  flex: 0 0 52px;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 0;
  border-right: 1px solid var(--stroke);
  background: #f8faff;
}
</style>
