<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Copy, Minus, Square, X } from '@lucide/vue'
import { Button } from './ui/button'

const props = defineProps<{
  beforeClose: () => Promise<boolean>
}>()

const win = getCurrentWindow()
const maximized = ref(false)

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
async function close() {
  if (await props.beforeClose()) await win.close()
}
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <span class="brand" data-tauri-drag-region><span class="brandIcon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L9.5 22 19.5 9.5H13L13 2z" fill="currentColor" stroke="none"/></svg></span>vagaga</span>
    <div class="controls">
      <Button type="button" variant="ghost" size="icon-sm" title="最小化" aria-label="最小化" @click="minimize">
        <Minus class="size-4" aria-hidden="true" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm"
        :title="maximized ? '还原' : '最大化'" :aria-label="maximized ? '还原' : '最大化'" @click="toggleMaximize">
        <Copy v-if="maximized" class="size-3.5" aria-hidden="true" />
        <Square v-else class="size-3.5" aria-hidden="true" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" class="windowClose"
        title="关闭" aria-label="关闭" @click="close">
        <X class="size-4" aria-hidden="true" />
      </Button>
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
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
  font-size: 14px;
  color: var(--text);
}
.brandIcon {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
}
.controls {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.windowClose:hover,
.windowClose:focus-visible {
  background-color: var(--danger);
  color: white;
}
</style>
