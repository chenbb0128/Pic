<script setup lang="ts">
import { computed, ref } from 'vue'
import { assessQuality } from '../../domain/assets/quality'
import type { StickerType } from '../../domain/layout/types'
import { useAssetUpload } from '../../composables/useAssetUpload'
import { useEditorStore } from '../../stores/editor'

const props = defineProps<{ type: StickerType; title: string; hint: string }>()
const store = useEditorStore()
const input = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const { loading, status, errors, handleFiles, clear } = useAssetUpload(props.type)
const assets = computed(() => (props.type === '2cm' ? store.assets2 : store.assets3))

function openPicker() { input.value?.click() }
function onInput(event: Event) {
  const target = event.target as HTMLInputElement
  if (target.files) void handleFiles(target.files)
  target.value = ''
}
function onDrop(event: DragEvent) {
  event.preventDefault()
  dragging.value = false
  if (event.dataTransfer?.files) void handleFiles(event.dataTransfer.files)
}
function qualityLabel(width: number, height: number) {
  return assessQuality(width, height, props.type, store.dpi).label
}
function qualityClass(width: number, height: number) {
  return `quality-${assessQuality(width, height, props.type, store.dpi).level}`
}
</script>

<template>
  <section class="space-y-2">
    <h2 class="text-sm font-bold text-slate-900">{{ title }}</h2>
    <button
      type="button"
      class="w-full rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-3 py-5 text-center text-sm text-slate-700 transition hover:border-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-300"
      :class="{ 'border-slate-700 bg-slate-100': dragging }"
      @click="openPicker"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop="onDrop"
    >
      点击选择透明 PNG / WebP
      <span class="mt-1 block text-xs text-slate-500">{{ hint }}</span>
    </button>
    <input ref="input" class="hidden" type="file" accept="image/png,image/webp" multiple @change="onInput" />
    <p class="text-xs text-slate-500" aria-live="polite">{{ loading ? '正在处理…' : status }}</p>
    <div v-if="errors.length" class="space-y-1 rounded-lg bg-red-50 p-2 text-xs text-red-700" role="alert">
      <p v-for="error in errors" :key="error">{{ error }}</p>
    </div>
    <div v-if="assets.length" class="grid grid-cols-4 gap-2 sm:grid-cols-5">
      <div v-for="asset in assets" :key="asset.id" class="min-w-0">
        <img class="aspect-square w-full rounded-md bg-slate-100 object-contain" :src="asset.url" :alt="asset.name" />
        <p class="mt-1 truncate text-center text-[10px]" :class="qualityClass(asset.width, asset.height)">{{ qualityLabel(asset.width, asset.height) }}</p>
      </div>
    </div>
    <button v-if="assets.length" type="button" class="min-h-10 w-full rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-800 hover:bg-slate-200" @click="clear">
      清空{{ type }}素材
    </button>
  </section>
</template>

<style scoped>
.quality-clear { color: #15803d; }
.quality-usable { color: #15803d; }
.quality-warning { color: #b45309; }
.quality-insufficient { color: #b91c1c; }
</style>
