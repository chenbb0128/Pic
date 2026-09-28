<script setup lang="ts">
import { computed } from 'vue'
import type { LayoutMode } from '../../domain/layout/types'
import { useEditorStore } from '../../stores/editor'

const store = useEditorStore()
const rows2Options = Array.from({ length: 10 }, (_, index) => index + 1)
const rows3Options = Array.from({ length: 7 }, (_, index) => index + 1)

const modeInfo = computed(() => {
  const count2 = store.layout.slots2.length
  const count3 = store.layout.slots3.length
  if (store.mode === 'full2') return `2CM 整版：${count2} 个（12 列 × ${store.rows2} 行）。`
  if (store.mode === 'full3') return `3CM 整版：${count3} 个（8 列 × ${store.rows3} 行）。`
  return `混合版：2CM ${count2} 个 + 3CM ${count3} 个。`
})

const rowInfo = computed(() => {
  if (!store.layout.valid) return store.layout.error
  return `当前统一垂直间距约 ${store.layout.gapY.toFixed(2)}mm。`
})

function onModeChange(event: Event) {
  store.setMode((event.target as HTMLSelectElement).value as LayoutMode)
}

function onRows2Change(event: Event) {
  store.setRows2(Number((event.target as HTMLSelectElement).value))
}

function onRows3Change(event: Event) {
  store.setRows3(Number((event.target as HTMLSelectElement).value))
}
</script>

<template>
  <section class="space-y-3">
    <h2 class="text-sm font-bold text-slate-900">① 选择规格</h2>
    <label class="sr-only" for="layout-mode">排版规格</label>
    <select
      id="layout-mode"
      class="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
      :value="store.mode"
      @change="onModeChange"
    >
      <option value="mixed">2CM + 3CM 混合版</option>
      <option value="full2">2CM 铺满整版</option>
      <option value="full3">3CM 铺满整版</option>
    </select>
    <p class="text-xs leading-5 text-slate-500">{{ modeInfo }}</p>

    <div class="space-y-2 rounded-lg bg-slate-50 p-3">
      <label v-if="store.mode !== 'full3'" class="flex items-center justify-between gap-3 text-sm">
        <span>2CM 行数</span>
        <select
          class="min-h-10 min-w-24 rounded-md border border-slate-300 bg-white px-2"
          :value="store.rows2"
          @change="onRows2Change"
        >
          <option v-for="row in rows2Options" :key="row" :value="row">{{ row }} 行</option>
        </select>
      </label>
      <label v-if="store.mode !== 'full2'" class="flex items-center justify-between gap-3 text-sm">
        <span>3CM 行数</span>
        <select
          class="min-h-10 min-w-24 rounded-md border border-slate-300 bg-white px-2"
          :value="store.rows3"
          @change="onRows3Change"
        >
          <option v-for="row in rows3Options" :key="row" :value="row">{{ row }} 行</option>
        </select>
      </label>
      <p class="text-xs leading-5 text-slate-500">{{ rowInfo }}</p>
    </div>
  </section>
</template>
