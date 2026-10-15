<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { imageSizePresets, containRect, outputPixelSize, type ImageSizePreset } from '../domain/studio/imageSizeConversion'
import { DIRECT_CANVAS_MAX_PIXELS, exportSize } from '../domain/studio/exportSize'
import { canvasPng, downloadBlob, loadLocalImage, tiledCanvasPng, type LocalImage } from '../services/studioImage'

const image = shallowRef<LocalImage | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const preview = ref<HTMLCanvasElement | null>(null)
const presetValue = ref<ImageSizePreset['value']>('A4')
const dpi = ref(300)
const exporting = ref(false)
const exportProgress = ref<number | null>(null)
const status = ref('请选择一张图片，再选择目标尺寸。')
const generated = ref<{ url: string; name: string; size: number } | null>(null)

const selectedPreset = computed(() => imageSizePresets.find((preset) => preset.value === presetValue.value) ?? imageSizePresets[1])
const pixels = computed(() => outputPixelSize(selectedPreset.value, dpi.value))
const exportInfo = computed(() => exportSize({ widthMm: selectedPreset.value.widthMm, heightMm: selectedPreset.value.heightMm }, dpi.value))
const previewWidth = 1000
const previewHeight = computed(() => Math.max(1, Math.round(previewWidth * selectedPreset.value.heightMm / selectedPreset.value.widthMm)))

function clearGenerated(): void {
  if (generated.value) URL.revokeObjectURL(generated.value.url)
  generated.value = null
}

function drawContained(context: CanvasRenderingContext2D, width: number, height: number): void {
  if (!image.value) return
  const rect = containRect(image.value.width, image.value.height, width, height)
  context.drawImage(image.value.image, rect.x, rect.y, rect.width, rect.height)
}

function renderPreview(): void {
  const canvas = preview.value
  if (!canvas) return
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  drawContained(context, canvas.width, canvas.height)
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const loaded = await loadLocalImage(file)
    if (image.value) URL.revokeObjectURL(image.value.url)
    image.value = loaded
    status.value = `已读取 ${loaded.name} · ${loaded.width} × ${loaded.height}px`
  } catch (error) {
    status.value = error instanceof Error ? error.message : '图片读取失败。'
  }
}

function choosePreset(value: ImageSizePreset['value']): void {
  presetValue.value = value
  status.value = `目标尺寸：${value} · ${selectedPreset.value.widthMm} × ${selectedPreset.value.heightMm}mm`
}

async function exportPng(): Promise<void> {
  if (!image.value) {
    status.value = '请先选择一张图片。'
    return
  }
  if (!exportInfo.value.allowed) {
    status.value = '当前尺寸和 DPI 超过浏览器导出上限，请降低 DPI。'
    return
  }
  exporting.value = true
  exportProgress.value = null
  status.value = '正在生成透明 PNG…'
  clearGenerated()
  let canvas: HTMLCanvasElement | null = null
  try {
    await nextTick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    let blob: Blob
    if (pixels.value.width * pixels.value.height > DIRECT_CANVAS_MAX_PIXELS) {
      exportProgress.value = 0
      blob = await tiledCanvasPng(pixels.value.width, pixels.value.height, dpi.value, (context, width, height) => {
        drawContained(context, width, height)
      }, (completed, total) => { exportProgress.value = Math.round(completed / total * 100) })
    } else {
      canvas = document.createElement('canvas')
      canvas.width = pixels.value.width
      canvas.height = pixels.value.height
      const context = canvas.getContext('2d', { alpha: true })
      if (!context) throw new Error('浏览器无法创建画布。')
      drawContained(context, canvas.width, canvas.height)
      blob = await canvasPng(canvas, dpi.value)
    }
    const url = URL.createObjectURL(blob)
    generated.value = { url, name: `尺寸转换-${selectedPreset.value.value}-${dpi.value}DPI-${Date.now()}.png`, size: blob.size }
    status.value = `已生成透明 PNG · ${pixels.value.width} × ${pixels.value.height}px`
  } catch (error) {
    status.value = error instanceof Error ? error.message : '导出失败，请降低 DPI 后重试。'
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0 }
    exportProgress.value = null
    exporting.value = false
  }
}

function download(): void {
  if (generated.value) downloadBlob(generated.value.url, generated.value.name)
}

watch([image, selectedPreset, dpi], () => {
  clearGenerated()
  void nextTick(renderPreview)
})
onMounted(() => { void nextTick(renderPreview) })
onBeforeUnmount(() => {
  if (image.value) URL.revokeObjectURL(image.value.url)
  clearGenerated()
})
</script>

<template>
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3 overflow-x-hidden p-3 lg:flex-row lg:gap-0 lg:p-0">
    <aside class="w-full shrink-0 space-y-5 overflow-y-auto bg-slate-900 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-white lg:max-h-full lg:w-[390px] lg:pb-4">
      <div>
        <h1 class="text-xl font-bold">尺寸转换</h1>
        <p class="mt-1 text-xs leading-5 text-slate-300">把图片放入指定纸张尺寸，保持比例并保留透明底。</p>
      </div>
      <section class="space-y-2">
        <h2 class="text-xs font-bold uppercase tracking-widest text-indigo-200">导入图片</h2>
        <input ref="fileInput" class="hidden" type="file" accept="image/png,image/webp,image/jpeg" @change="onFileChange" />
        <button type="button" class="flex min-h-24 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-600 bg-slate-800 text-sm hover:border-indigo-400" @click="fileInput?.click()">
          <span class="text-2xl" aria-hidden="true">▧</span>
          <span class="mt-1 truncate px-3">{{ image ? image.name : '点击选择图片' }}</span>
          <small class="mt-1 text-xs text-slate-400">支持 PNG / JPG / WebP</small>
        </button>
        <p v-if="image" class="text-xs text-slate-400">原图：{{ image.width }} × {{ image.height }}px</p>
      </section>
      <section class="space-y-2">
        <h2 class="text-xs font-bold uppercase tracking-widest text-indigo-200">目标尺寸</h2>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-5 lg:grid-cols-2">
          <button v-for="option in imageSizePresets" :key="option.value" type="button" class="flex min-h-14 flex-col items-center justify-center rounded-lg text-xs" :class="presetValue === option.value ? 'bg-indigo-400 font-bold text-slate-950' : 'bg-slate-800'" @click="choosePreset(option.value)">
            <span class="text-sm">{{ option.label }}</span>
            <span class="mt-1 text-[10px] opacity-75">{{ option.widthMm }} × {{ option.heightMm }}mm</span>
          </button>
        </div>
      </section>
      <section class="space-y-2">
        <h2 class="text-xs font-bold uppercase tracking-widest text-indigo-200">导出精度</h2>
        <div class="grid grid-cols-3 gap-2">
          <button v-for="value in [300, 500, 600]" :key="value" type="button" class="min-h-10 rounded-lg text-sm" :class="dpi === value ? 'bg-indigo-400 font-bold text-slate-950' : 'bg-slate-800'" :disabled="!exportSize({ widthMm: selectedPreset.widthMm, heightMm: selectedPreset.heightMm }, value).allowed" @click="dpi = value">{{ value }} DPI</button>
        </div>
        <p class="text-xs text-slate-400">当前输出：{{ pixels.width }} × {{ pixels.height }}px</p>
      </section>
      <div class="rounded-xl border border-indigo-400/40 bg-indigo-950/40 p-3 text-xs leading-5 text-indigo-100">
        <p class="font-bold">透明底处理</p>
        <p class="mt-1 text-indigo-200">图片会等比例缩放并居中，空白区域保持透明，不会拉伸或裁切。</p>
      </div>
    </aside>
    <main class="flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:p-5">
      <div class="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span class="rounded-full bg-white px-3 py-1.5">{{ selectedPreset.value }} · {{ selectedPreset.widthMm }} × {{ selectedPreset.heightMm }}mm</span>
        <span class="rounded-full bg-white px-3 py-1.5">{{ dpi }} DPI</span>
        <span class="rounded-full bg-white px-3 py-1.5">透明背景 PNG</span>
      </div>
      <div class="flex min-h-[45dvh] min-w-0 flex-1 items-center justify-center overflow-auto rounded-2xl bg-slate-800 p-3 sm:min-h-[480px] sm:p-6 lg:min-h-0">
        <canvas ref="preview" :width="previewWidth" :height="previewHeight" class="block h-auto max-h-[calc(100dvh-250px)] max-w-full bg-[linear-gradient(45deg,#ddd_25%,transparent_25%),linear-gradient(-45deg,#ddd_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#ddd_75%),linear-gradient(-45deg,transparent_75%,#ddd_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0] bg-white shadow-2xl lg:max-h-full" aria-label="尺寸转换透明底预览" />
      </div>
      <div class="sticky bottom-2 z-10 space-y-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-lg lg:static">
        <p class="text-xs text-slate-600" aria-live="polite">{{ status }}</p>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" class="min-h-11 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white disabled:opacity-50" :disabled="exporting || !image" @click="exportPng">{{ exporting ? '生成中…' : '生成透明 PNG' }}</button>
          <button type="button" class="min-h-11 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white disabled:opacity-50" :disabled="!generated" @click="download">下载图片</button>
        </div>
        <p v-if="generated" class="text-xs text-emerald-700">{{ generated.name }} · {{ Math.ceil(generated.size / 1024) }} KB</p>
      </div>
    </main>
    <div v-if="exporting" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-5" role="status">
      <div class="rounded-2xl bg-white p-6 text-center shadow-xl">
        <span class="mx-auto block h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-indigo-600"></span>
        <p class="mt-4 font-bold">正在生成 {{ selectedPreset.value }} 透明 PNG</p>
        <p v-if="exportProgress !== null" class="mt-1 text-sm text-slate-500">已处理 {{ exportProgress }}%</p>
        <p class="mt-1 text-sm text-slate-500">请勿关闭页面</p>
      </div>
    </div>
  </div>
</template>
