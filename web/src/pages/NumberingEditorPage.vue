<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { DIRECT_CANVAS_MAX_PIXELS } from '../domain/studio/exportSize'
import { canvasPng, downloadBlob, loadLocalImage, tiledCanvasPng, type LocalImage } from '../services/studioImage'
import { composeFooterText, FOOTER_PREFIXES, type FooterPrefix, type NumberingSide } from '../services/studioNumbering'
import { drawRenumberedImage, numberingRegion } from '../services/numberingEditor'

const image = shallowRef<LocalImage | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const preview = ref<HTMLCanvasElement | null>(null)
const side = ref<NumberingSide>('bottom')
const stripMm = ref(3)
const dpi = ref<number | ''>('')
const prefix = ref<FooterPrefix>('ch')
const number = ref('')
const sheetTotal = ref(1)
const sheetIndex = ref(1)
const loading = ref(false)
const exporting = ref(false)
const status = ref('上传已导出的排版图片，选择旧编号所在区域，再填写新编号。')
const generated = ref<{ url: string; name: string } | null>(null)
const sides: { value: NumberingSide; label: string }[] = [
  { value: 'top', label: '上方' }, { value: 'bottom', label: '下方' },
  { value: 'left', label: '左边' }, { value: 'right', label: '右边' },
]
let loadRequest = 0
const label = computed(() => composeFooterText(prefix.value, number.value.trim(), { total: sheetTotal.value, index: sheetIndex.value }))
const validation = computed(() => {
  if (!image.value) return ''
  try {
    numberingRegion(image.value.width, image.value.height, Number(dpi.value), stripMm.value, side.value)
    if (image.value.width * image.value.height > 100_000_000) return '图片超过 1 亿像素，请使用较小的图片。'
    return ''
  } catch (error) { return error instanceof Error ? error.message : '请检查区域设置。' }
})
const previewSize = computed(() => {
  const ratio = image.value ? Math.min(1, 1400 / Math.max(image.value.width, image.value.height)) : 1
  return { width: Math.max(1, Math.round((image.value?.width ?? 1) * ratio)), height: Math.max(1, Math.round((image.value?.height ?? 1) * ratio)) }
})
const overlay = computed(() => {
  const source = image.value
  if (!source || validation.value) return null
  const r = numberingRegion(source.width, source.height, Number(dpi.value), stripMm.value, side.value)
  return { left: `${r.x / source.width * 100}%`, top: `${r.y / source.height * 100}%`, width: `${r.width / source.width * 100}%`, height: `${r.height / source.height * 100}%` }
})

function clearGenerated(): void {
  if (generated.value) URL.revokeObjectURL(generated.value.url)
  generated.value = null
}

function renderPreview(): void {
  const canvas = preview.value, source = image.value
  const context = canvas?.getContext('2d')
  if (!canvas || !source || !context) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  if (validation.value) context.drawImage(source.image, 0, 0, canvas.width, canvas.height)
  else drawRenumberedImage(context, source, canvas.width, canvas.height,
    { dpi: Number(dpi.value), stripMm: stripMm.value, side: side.value, text: label.value })
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || exporting.value) return
  const request = ++loadRequest
  loading.value = true
  try {
    const loaded = await loadLocalImage(file)
    if (request !== loadRequest) { URL.revokeObjectURL(loaded.url); return }
    if (image.value) URL.revokeObjectURL(image.value.url)
    image.value = loaded
    dpi.value = loaded.sourceDpi ? Number(loaded.sourceDpi.toFixed(4)) : ''
    status.value = loaded.sourceDpi ? '已读取原图 DPI，请检查高亮区域并填写新编号。' : '图片没有 DPI 信息，请填写原图导出时使用的 DPI，再检查覆盖区域。'
  } catch (error) {
    if (request === loadRequest) status.value = error instanceof Error ? error.message : '图片读取失败。'
  } finally { if (request === loadRequest) loading.value = false }
}

async function exportPng(): Promise<void> {
  const source = image.value
  if (!source || exporting.value || loading.value) return
  if (validation.value || !label.value) {
    status.value = validation.value || '请先填写新编号。'
    return
  }
  const edit = { dpi: Number(dpi.value), stripMm: stripMm.value, side: side.value,
    text: composeFooterText(prefix.value, number.value.trim(), { total: sheetTotal.value, index: sheetIndex.value }) }
  exporting.value = true
  status.value = '正在重写编号并生成 PNG…'
  clearGenerated()
  let canvas: HTMLCanvasElement | null = null
  try {
    await nextTick()
    await document.fonts.ready
    const draw = (context: CanvasRenderingContext2D, width: number, height: number) => drawRenumberedImage(context, source, width, height, edit)
    let blob: Blob
    if (source.width * source.height > DIRECT_CANVAS_MAX_PIXELS || Math.max(source.width, source.height) > 16384) {
      blob = await tiledCanvasPng(source.width, source.height, edit.dpi, draw)
    } else {
      canvas = document.createElement('canvas')
      canvas.width = source.width
      canvas.height = source.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法创建画布。')
      draw(context, source.width, source.height)
      blob = await canvasPng(canvas, edit.dpi)
    }
    const safeNumber = edit.text.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150)
    generated.value = { url: URL.createObjectURL(blob), name: `${safeNumber}_修改编号.png` }
    downloadBlob(generated.value.url, generated.value.name)
    status.value = `已导出 ${source.width} × ${source.height}px PNG，保留 ${edit.dpi} DPI。`
  } catch (error) { status.value = error instanceof Error ? error.message : '生成失败，请重试。' }
  finally {
    if (canvas) { canvas.width = 0; canvas.height = 0 }
    exporting.value = false
  }
}

watch([image, dpi, side, stripMm, prefix, number, sheetTotal, sheetIndex], () => {
  clearGenerated()
  void nextTick(renderPreview)
})
onBeforeUnmount(() => {
  loadRequest++
  if (image.value) URL.revokeObjectURL(image.value.url)
  clearGenerated()
})
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto lg:flex-row">
    <aside class="w-full shrink-0 space-y-5 bg-slate-900 p-5 text-white lg:w-[360px] lg:overflow-y-auto">
      <div>
        <h1 class="text-xl font-bold">修改排版编号</h1>
        <p class="mt-2 text-xs leading-5 text-slate-300">复用已导出的排版，覆盖旧编号区域并填写新编号。</p>
      </div>
      <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" aria-label="上传排版图片" :disabled="loading || exporting" @change="onFileChange" />
      <button type="button" class="min-h-24 w-full break-all rounded-xl border-2 border-dashed border-slate-600 bg-slate-800 p-3 text-sm hover:border-indigo-400 disabled:opacity-50" :disabled="loading || exporting" @click="fileInput?.click()">
        {{ loading ? '读取中…' : image ? image.name : '上传排版图片' }}
        <span class="mt-2 block text-xs text-slate-400">PNG / JPG / WebP · 在浏览器本地处理</span>
      </button>
      <fieldset class="space-y-5" :disabled="exporting || loading">
        <section class="space-y-2">
          <h2 class="text-sm font-bold text-indigo-200">原编号区域</h2>
          <div class="grid grid-cols-4 gap-2">
            <button v-for="option in sides" :key="option.value" type="button" class="min-h-10 rounded-lg text-sm" :class="side === option.value ? 'bg-indigo-400 font-bold text-slate-950' : 'bg-slate-800'" :aria-pressed="side === option.value" @click="side = option.value">{{ option.label }}</button>
          </div>
          <label class="block text-xs">区域大小（mm）<input v-model.number="stripMm" type="number" min="0.1" step="0.1" class="control mt-1" /></label>
          <label class="block text-xs">原图 DPI<input v-model.number="dpi" type="number" min="1" step="any" placeholder="填写原图导出时的 DPI" class="control mt-1" /></label>
          <p v-if="image?.sourceDpi" class="text-xs text-slate-400">已读取图片 DPI，可手动修正。</p>
          <p v-else class="text-xs leading-5 text-slate-400">有 DPI 信息时自动读取；没有时请填写，避免毫米区域计算不准确。</p>
          <p v-if="image && dpi && !validation" class="text-xs text-slate-300">原图尺寸：{{ (image.width / Number(dpi) * 25.4).toFixed(2) }} × {{ (image.height / Number(dpi) * 25.4).toFixed(2) }} mm</p>
        </section>
        <section class="space-y-2">
          <h2 class="text-sm font-bold text-indigo-200">新排版编号</h2>
          <label class="block text-xs">编号前缀<select v-model="prefix" class="control mt-1"><option v-for="value in FOOTER_PREFIXES" :key="value" :value="value">{{ value }}</option></select></label>
          <label class="block text-xs">编号内容<input v-model="number" type="text" maxlength="200" placeholder="输入订单号或客户编号" class="control mt-1" /></label>
          <div class="grid grid-cols-2 gap-2">
            <label class="text-xs">共几张<input v-model.number="sheetTotal" type="number" min="1" max="999" step="1" class="control mt-1" /></label>
            <label class="text-xs">第几张<input v-model.number="sheetIndex" type="number" min="1" max="999" step="1" class="control mt-1" /></label>
          </div>
          <p class="break-all rounded-lg bg-slate-800 p-3 text-xs leading-5 text-indigo-200" aria-live="polite">{{ label || '填写后显示完整编号' }}</p>
        </section>
      </fieldset>
      <p class="text-xs leading-5 text-slate-400">高亮区域会被整条替换，请确认没有覆盖图案。导出保持原像素尺寸、DPI 和透明背景，并保留原有编号区的使用说明样式。</p>
    </aside>
    <main class="flex min-h-[420px] min-w-0 flex-1 flex-col gap-3 p-3 sm:p-5 lg:min-h-0">
      <div class="flex flex-wrap gap-2 text-xs text-slate-600">
        <span class="rounded-full bg-white px-3 py-2">{{ image ? `${image.width} × ${image.height} px` : '等待上传图片' }}</span>
        <span class="rounded-full bg-white px-3 py-2">{{ sides.find(option => option.value === side)?.label }} · {{ stripMm }} mm</span>
      </div>
      <div class="flex min-h-[320px] flex-1 items-start justify-center overflow-auto rounded-2xl bg-slate-800 p-4 lg:min-h-0">
        <div v-if="image" class="relative my-auto max-w-full shrink-0" :style="{ width: `${previewSize.width}px` }">
          <canvas ref="preview" :width="previewSize.width" :height="previewSize.height" class="block h-auto w-full bg-white shadow-xl" aria-label="修改编号预览" />
          <div v-if="overlay" :style="overlay" class="pointer-events-none absolute border border-indigo-500 bg-indigo-400/20" aria-label="编号覆盖区域" />
        </div>
        <p v-else class="my-auto text-sm text-slate-300">上传图片后，在这里预览编号替换效果</p>
      </div>
      <div class="space-y-2 rounded-xl bg-white p-3 shadow-sm">
        <p v-if="validation" class="text-sm text-red-600" role="alert">{{ validation }}</p>
        <p class="text-xs text-slate-600" role="status">{{ status }}</p>
        <button type="button" class="min-h-11 w-full rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white disabled:opacity-50" :disabled="!image || !label || !!validation || exporting || loading" @click="exportPng">{{ exporting ? '正在生成…' : '下载修改后的 PNG' }}</button>
      </div>
    </main>
  </div>
</template>

<style scoped>
.control { width: 100%; min-height: 40px; border: 1px solid #475569; border-radius: 8px; background: #1e293b; color: white; padding: 8px 10px; font-size: 14px; }
.control:focus { outline: 2px solid #818cf8; outline-offset: 1px; }
fieldset:disabled { opacity: .6; }
</style>
