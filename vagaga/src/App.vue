<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TitleBar from './components/TitleBar.vue'
import OrdersView from './views/OrdersView.vue'
import SettingsView from './views/SettingsView.vue'
import { useOrdersStore, loadOrders, loadInfo, bindEvents, refreshQiniuStatus } from './stores/orders'

const store = useOrdersStore()
const view = ref<'orders' | 'settings'>('orders')
let stopEvents: (() => void) | undefined
let disposed = false

onMounted(async () => {
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
    <TitleBar :view="view" @change="view = $event" />
    <OrdersView v-show="view === 'orders'" />
    <SettingsView v-if="view === 'settings'" @back="view = 'orders'" />
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
