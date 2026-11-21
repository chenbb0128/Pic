<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import TitleBar from './components/TitleBar.vue'
import OrdersView from './views/OrdersView.vue'
import WorkflowDialog from './components/WorkflowDialog.vue'
import SettingsView from './views/SettingsView.vue'
import { useOrdersStore, loadOrders, loadInfo, bindEvents, refreshQiniuStatus, refreshWorkflowOrders, refreshWorkflowSettings, toast } from './stores/orders'

const store = useOrdersStore()
const view = ref<'orders' | 'settings'>('orders')
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

function requireStorage() {
  if (store.workflow.target) return true
  toast('error', '请先在设置中启用共享存储。')
  return false
}

async function upload() {
  if (!uploadSelection.value.length || !requireStorage()) return
  const uploaded = new Set(await workflow.value?.upload(uploadSelection.value))
  selectedUploadOrders.value = uploadSelection.value.filter(number => !uploaded.has(number))
}

function toggleUpload(orderNumber: string, checked: boolean) {
  selectedUploadOrders.value = checked
    ? [...uploadSelection.value, orderNumber]
    : uploadSelection.value.filter(number => number !== orderNumber)
}

function sync() {
  if (requireStorage()) void workflow.value?.sync()
}

function saveLayout() {
  return ordersView.value?.persistLayout() ?? Promise.resolve()
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
  <div class="shell">
    <TitleBar
      :view="view"
      :before-close="saveLayoutBeforeClose"
      @change="view = $event"
      :upload-count="uploadSelection.length"
      :operation="workflow?.operation ?? null"
      @upload="upload"
      @sync="sync"
    />
    <OrdersView
      v-show="view === 'orders'"
      ref="ordersView"
      :visible="view === 'orders'"
      :upload-selection="selectedUploadOrders"
      :uploadable-orders="uploadableOrders"
      :workflow-busy="!!workflow?.operation"
      @finish="workflow?.finish($event)"
      @toggle-upload="toggleUpload"
    />
    <WorkflowDialog ref="workflow" :active-order="ordersView?.lastInjectedOrder ?? null" :save-layout="saveLayout" />
    <SettingsView v-if="view === 'settings'" :active-order="ordersView?.lastInjectedOrder ?? null" @back="view = 'orders'" />
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
</style>
