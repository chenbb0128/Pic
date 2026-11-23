<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ClipboardList, CloudDownload, CloudUpload, LayoutTemplate, LoaderCircle, Settings } from '@lucide/vue'
import TitleBar from './components/TitleBar.vue'
import { Button } from './components/ui/button'
import OrdersView from './views/OrdersView.vue'
import WorkflowDialog from './components/WorkflowDialog.vue'
import SettingsView from './views/SettingsView.vue'
import TemplatesView from './views/TemplatesView.vue'
import { useOrdersStore, loadOrders, loadInfo, bindEvents, refreshQiniuStatus, refreshWorkflowOrders, refreshWorkflowSettings, toast } from './stores/orders'
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

async function upload() {
  if (!uploadSelection.value.length) return
  const uploaded = new Set(await workflow.value?.upload(uploadSelection.value))
  selectedUploadOrders.value = uploadSelection.value.filter(number => !uploaded.has(number))
}

function toggleUpload(orderNumber: string, checked: boolean) {
  selectedUploadOrders.value = checked
    ? [...uploadSelection.value, orderNumber]
    : uploadSelection.value.filter(number => number !== orderNumber)
}

function sync() {
  if (store.workflow.role !== 'customer') void workflow.value?.sync()
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
  void refreshWorkflowSettings().catch(() => {})
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
      </nav>
      <main class="pages">
        <OrdersView
          v-show="view === 'orders'"
          ref="ordersView"
          :visible="view === 'orders'"
          :upload-selection="selectedUploadOrders"
          :uploadable-orders="uploadableOrders"
          :workflow-busy="!!workflow?.operation"
          @finish="workflow?.finish($event)"
          @toggle-upload="toggleUpload"
        >
          <template #workflow-actions>
            <Button v-if="store.workflow.role !== 'production'" type="button" size="xs"
              :disabled="!!workflow?.operation || !uploadSelection.length" @click="upload">
              <LoaderCircle v-if="workflow?.operation === 'upload'" class="motion-safe:animate-spin" aria-hidden="true" />
              <CloudUpload v-else aria-hidden="true" />
              {{ workflow?.operation === 'upload' ? '正在上传…' : uploadSelection.length ? `上传（${uploadSelection.length}）` : '上传' }}
            </Button>
            <Button v-if="store.workflow.role !== 'customer'" type="button" size="xs"
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
    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
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
