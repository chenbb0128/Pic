<script setup lang="ts">
import { computed } from 'vue'
import { PREVIEW_SIZE } from '../../domain/layout/constants'
import { useEditorStore } from '../../stores/editor'
import { usePreviewRenderer } from '../../composables/usePreviewRenderer'

const store = useEditorStore()
const { canvas } = usePreviewRenderer()
const count2 = computed(() => store.layout.slots2.length)
const count3 = computed(() => store.layout.slots3.length)
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col">
    <div class="mb-3 flex flex-wrap gap-2 text-xs text-slate-600">
      <span class="rounded-full border border-slate-200 bg-white px-3 py-1.5">293 × 210 mm</span>
      <span class="rounded-full border border-slate-200 bg-white px-3 py-1.5">自动水平 / 垂直均匀分布</span>
      <span class="rounded-full border border-slate-200 bg-white px-3 py-1.5">2CM：{{ count2 }}</span>
      <span class="rounded-full border border-slate-200 bg-white px-3 py-1.5">3CM：{{ count3 }}</span>
      <span class="rounded-full border border-slate-200 bg-white px-3 py-1.5">印刷高清检测</span>
    </div>
    <div class="flex min-h-[360px] flex-1 items-center justify-center overflow-auto rounded-2xl bg-slate-200 p-2 sm:min-h-[520px] sm:p-5">
      <div class="w-full max-w-[1172px] overflow-hidden rounded-sm bg-white shadow-2xl">
        <canvas ref="canvas" class="block h-auto w-full" :width="PREVIEW_SIZE.width" :height="PREVIEW_SIZE.height" aria-label="贴纸排版预览" />
      </div>
    </div>
    <div class="mt-3 hidden gap-5 text-xs text-slate-600 sm:flex">
      <span><i class="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-blue-600" />上：2CM 区域 {{ count2 }} 个</span>
      <span><i class="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-pink-600" />下：3CM 区域 {{ count3 }} 个</span>
      <span>辅助框仅用于预览，不会导出</span>
    </div>
  </section>
</template>
