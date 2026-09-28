<script setup lang="ts">
import { useEditorStore } from '../../stores/editor'
import { usePngExport } from '../../composables/usePngExport'
import QualitySummary from './QualitySummary.vue'
import PricingTeaser from './PricingTeaser.vue'

const store = useEditorStore()
const {
  canExport,
  copyResult,
  buttonConfirmed,
  orderText,
  orderUrl,
  generate,
  download,
  downloadAndCopy,
  copyOrderText,
  openPreview,
} = usePngExport()

function onDpiChange(event: Event) { store.setDpi(Number((event.target as HTMLSelectElement).value)) }
function onNameChange(event: Event) { store.setFileName((event.target as HTMLInputElement).value) }
function selectManualText(event: FocusEvent) { (event.target as HTMLTextAreaElement).select() }
</script>

<template>
  <section class="space-y-3 border-t border-slate-200 pt-4">
    <h2 class="text-sm font-bold text-slate-900">④ 生成成品</h2>
    <PricingTeaser />
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
      <button
        type="button"
        class="min-h-12 w-full rounded-lg bg-emerald-700 px-3 font-semibold text-white transition hover:bg-emerald-800"
        @click="downloadAndCopy"
      >
        {{ buttonConfirmed ? '文案已复制 ✓' : '下载图片并复制下单文案' }}
      </button>
      <div class="grid grid-cols-2 gap-2">
        <button type="button" class="min-h-10 rounded-lg bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100" @click="copyOrderText">{{ buttonConfirmed ? '文案已复制 ✓' : '复制下单文案' }}</button>
        <button type="button" class="min-h-10 rounded-lg bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100" @click="download">仅下载图片</button>
      </div>
      <button type="button" class="min-h-10 w-full rounded-lg bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100" @click="openPreview">打开高清图</button>

      <div v-if="copyResult === 'copied'" class="rounded-lg border border-red-200 bg-white p-3" aria-live="polite">
        <p class="text-sm font-semibold text-slate-900">下单文案已复制</p>
        <p class="mt-1 text-xs leading-5 text-slate-600">打开小红书后粘贴口令，即可进入主页下单。</p>
        <a
          class="mt-2 flex min-h-10 w-full items-center justify-center rounded-lg bg-red-500 px-3 text-sm font-semibold text-white hover:bg-red-600"
          :href="orderUrl"
          target="_blank"
          rel="noopener noreferrer"
        >打开小红书去下单</a>
      </div>

      <div v-else-if="copyResult === 'manual'" class="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3" aria-live="polite">
        <p class="text-sm font-semibold text-amber-900">浏览器未允许自动复制</p>
        <p class="text-xs leading-5 text-amber-800">可再次点击复制；如果仍失败，请长按下面的文案手动复制。</p>
        <textarea
          class="h-24 w-full resize-none rounded-lg border border-amber-300 bg-white p-2 text-xs leading-5 text-slate-700 outline-none focus:ring-2 focus:ring-amber-200"
          :value="orderText"
          readonly
          @focus="selectManualText"
        />
        <button type="button" class="min-h-10 w-full rounded-lg bg-amber-600 px-3 text-sm font-semibold text-white hover:bg-amber-700" @click="copyOrderText">再次复制文案</button>
      </div>

      <p class="break-all text-xs text-emerald-800">{{ store.generated.name }}<br />{{ store.generated.width }} × {{ store.generated.height }} px｜{{ store.dpi }} DPI 已写入 PNG</p>
      <RouterLink class="flex min-h-10 items-center justify-center rounded-lg border border-emerald-200 bg-white px-3 text-sm font-semibold text-emerald-800 hover:bg-emerald-100" to="/pricing">
        查看价格与制作须知
      </RouterLink>
    </div>
  </section>
</template>
