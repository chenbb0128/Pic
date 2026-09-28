<script setup lang="ts">
import { computed } from 'vue'
import { requiredPixels } from '../../domain/assets/quality'
import { useEditorStore } from '../../stores/editor'

const store = useEditorStore()
const text = computed(() => {
  if (!store.quality.total) return '上传素材后自动检测印刷清晰度。'
  const bad = store.quality.insufficient ? `${store.quality.insufficient} 张不足` : ''
  const warning = store.quality.warning ? `${store.quality.warning} 张一般` : ''
  return `${store.dpi} DPI 参考：2CM ≥${requiredPixels('2cm', store.dpi)}px，3CM ≥${requiredPixels('3cm', store.dpi)}px；当前 ${store.quality.total} 张，${bad || warning || '全部够用 ✓'}`
})
</script>

<template>
  <p class="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600" aria-live="polite">{{ text }}</p>
</template>
