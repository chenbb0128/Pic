<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'

const props = defineProps<{ view: 'orders' | 'settings' }>()
const emit = defineEmits<{ change: ['orders' | 'settings'] }>()

const win = getCurrentWindow()
const maximized = ref(false)

const tabs: { key: 'orders' | 'settings'; label: string }[] = [
  { key: 'orders', label: '订单' },
  { key: 'settings', label: '设置' },
]

onMounted(async () => {
  const sync = () => {
    void win.isMaximized().then(v => (maximized.value = v)).catch(() => {})
  }
  sync()
  void win.onResized(sync)
})

function minimize() {
  void win.minimize()
}
function toggleMaximize() {
  void win.toggleMaximize()
}
function close() {
  void win.close()
}
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <span class="brand" data-tauri-drag-region><span class="brandIcon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L9.5 22 19.5 9.5H13L13 2z" fill="currentColor" stroke="none"/></svg></span>vagaga</span>
    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ on: props.view === tab.key }"
        @click="emit('change', tab.key)"
      >{{ tab.label }}</button>
    </nav>
    <div class="controls">
      <button class="ctl" title="最小化" @click="minimize">─</button>
      <button class="ctl" :title="maximized ? '还原' : '最大化'" @click="toggleMaximize">{{ maximized ? '❐' : '□' }}</button>
      <button class="ctl close" title="关闭" @click="close">✕</button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 14px;
  border-bottom: 1px solid var(--stroke);
  background: rgba(255, 255, 255, 0.82);
  flex-shrink: 0;
}
.brand {
  font-weight: 700;
  font-size: 14px;
  color: var(--text);
}
.tabs {
  display: flex;
  gap: 4px;
  margin-left: 10px;
}
.tab {
  border: none;
  border-radius: 8px;
  padding: 4px 14px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.tab:hover {
  background: var(--bg-card-hover);
  color: var(--text);
}
.tab.on {
  background: rgba(56, 107, 255, 0.12);
  color: var(--accent);
  font-weight: 600;
}
.controls {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.ctl {
  width: 30px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}
.ctl:hover {
  background: #e8edf5;
}
.ctl.close:hover {
  background: var(--danger);
  color: #fff;
}
</style>
