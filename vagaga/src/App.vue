<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TitleBar from './components/TitleBar.vue'
import OrdersView from './views/OrdersView.vue'
import WorkflowDialog from './components/WorkflowDialog.vue'
import SettingsView from './views/SettingsView.vue'
import { useOrdersStore, loadOrders, loadInfo, bindEvents, refreshQiniuStatus, refreshWorkflowOrders, refreshWorkflowSettings, toast } from './stores/orders'

const store = useOrdersStore()
const view = ref<'orders' | 'settings'>('orders')
const ordersView = ref<InstanceType<typeof OrdersView> | null>(null)
const workflow = ref<InstanceType<typeof WorkflowDialog> | null>(null)

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
      @upload="workflow?.openUpload()"
      @sync="workflow?.openSync()"
    />
    <OrdersView
      v-show="view === 'orders'"
      ref="ordersView"
      :visible="view === 'orders'"
      @finish="workflow?.finish($event)"
      @history="workflow?.openHistory('completed')"
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
