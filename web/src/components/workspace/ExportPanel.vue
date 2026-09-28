<script setup lang="ts">
import { useEditorStore } from '../../stores/editor'
import { usePngExport } from '../../composables/usePngExport'
import QualitySummary from './QualitySummary.vue'

const store = useEditorStore()
const { canExport, generate, download, openPreview } = usePngExport()

function onDpiChange(event: Event) { store.setDpi(Number((event.target as HTMLSelectElement).value)) }
function onNameChange(event: Event) { store.setFileName((event.target as HTMLInputElement).value) }
</script>

<template>
  <section class="space-y-3 border-t border-slate-200 pt-4">
    <h2 class="text-sm font-bold text-slate-900">④ 生成成品</h2>
    <div class="grid grid-cols-[92px_1fr] items-center gap-2 text-sm">
      <label for="dpi">导出精度</label>
      <select id="dpi" class="min-h-10 rounded-lg border border-slate-300 bg-white px-2" :value="store.dpi" @change="onDpiChange">
        <option value="300">300 DPI</option>
        <option value="600">600 DPI</option>
      </select>
      <label for="file-name">文件名称</label>
      <input id="file-name" class="min-h-10 rounded-lg border border-slate-300 bg-white px-2 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200" type="text" placeholder="例如：张三-0924" :value="store.fileName" @input="onNameChange" />
    </div>
    <p class="text-xs text-slate-500">无需输入 .png，系统会自动添加。600 DPI 在手机上可能需要更长生成时间或更多内存。</p>
    <QualitySummary />
    <button type="button" class="min-h-12 w-full rounded-xl bg-slate-900 px-4 font-bold text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50" :disabled="store.exporting || !canExport" @click="generate">
      {{ store.exporting ? '正在生成高清 PNG…' : '生成高清透明 PNG' }}
    </button>
    <p class="text-xs leading-5 text-slate-500" aria-live="polite">{{ store.exportStatus }}</p>
    <div v-if="store.generated" class="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
      <button type="button" class="min-h-11 w-full rounded-lg bg-emerald-700 px-3 font-semibold text-white hover:bg-emerald-800" @click="download">下载高清 PNG（{{ (store.generated.blob.size / 1024 / 1024).toFixed(2) }} MB）</button>
      <button type="button" class="min-h-10 w-full rounded-lg bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-100" @click="openPreview">打开高清 PNG</button>
      <p class="break-all text-xs text-emerald-800">{{ store.generated.name }}<br />{{ store.generated.width }} × {{ store.generated.height }} px｜{{ store.dpi }} DPI 已写入 PNG</p>
    </div>
  </section>
</template>
