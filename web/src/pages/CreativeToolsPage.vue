<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { imageSizePresets } from '../domain/studio/imageSizeConversion'
import { paperSize, type Orientation, type PaperPreset } from '../domain/studio/layout'
import { XIAOHONGSHU_ORDER_TEXT, XIAOHONGSHU_ORDER_URL } from '../domain/order'
import { copyText } from '../services/clipboard'
import { renderCreative, type CreativeKind, type CreativeSettings, type FrameShape, type PolkaShape } from '../services/creativeCanvas'
import { canvasPng, downloadBlob, loadLocalImage, type LocalImage } from '../services/studioImage'

const route = useRoute()
const kind = computed(() => route.params.kind as CreativeKind)
const titles: Record<CreativeKind, string> = { recolor: '线稿改色', polka: '波点生成', frame: '框架对比', name: '姓名排版', text: '文字方格' }
const descriptions: Record<CreativeKind, string> = {
  recolor: '给透明底线稿换颜色，保留原图透明区域。',
  polka: '组合形状、颜色和间距，生成透明底波点图。',
  frame: '比较图案与框架尺寸，拖动图片调整裁剪位置。',
  name: '输入姓名或短句，自动重复排满纸张。',
  text: '把多行文字依次放进方格，生成整张透明 PNG。',
}

const image = shallowRef<LocalImage | null>(null)
const input = ref<HTMLInputElement | null>(null)
const preview = ref<HTMLCanvasElement | null>(null)
const controlsOpen = ref(false)
const preset = ref<Exclude<PaperPreset, 'custom'>>('A4')
const orientation = ref<Orientation>('landscape')
const dpi = ref(300)
const text = ref('小星贴')
const font = ref('Arial, sans-serif')
const fontMm = ref(8)
const cellMm = ref(20)
const gapMm = ref(5)
const color = ref('#7c3aed')
const secondColor = ref('#ec4899')
const thirdColor = ref('#f59e0b')
const colorMode = ref<CreativeSettings['colorMode']>('solid')
const pattern = ref<CreativeSettings['pattern']>('grid')
const polkaShape = ref<PolkaShape>('circle')
const dotMm = ref(3)
const seed = ref(1)
const frameShape = ref<FrameShape>('circle')
const frameWidthMm = ref(50)
const frameHeightMm = ref(50)
const frameFit = ref<CreativeSettings['frameFit']>('cover')
const frameZoom = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const textEffect = ref<CreativeSettings['textEffect']>('none')
const status = ref('调整左侧设置，右侧会实时显示效果。')
const count = ref(0)
const exporting = ref(false)
const generated = ref<{ url: string; name: string } | null>(null)
const copied = ref(false)
let dragAt: { x: number; y: number } | null = null
const paperOptions = computed(() => imageSizePresets.map((option) => {
  const size = paperSize(option.value, orientation.value)
  return { value: option.value, label: option.label, size: `${size.widthMm}×${size.heightMm}mm` }
}))

const paper = computed(() => paperSize(preset.value, orientation.value))
const outputRatio = computed(() => kind.value === 'recolor' && image.value
  ? image.value.width / image.value.height
  : kind.value === 'frame'
    ? frameWidthMm.value / frameHeightMm.value
    : paper.value.widthMm / paper.value.heightMm)
const previewWidth = 900
const previewHeight = computed(() => Math.max(1, Math.round(previewWidth / outputRatio.value)))
const settings = computed<CreativeSettings>(() => ({
  kind: kind.value,
  image: image.value,
  widthMm: kind.value === 'frame' ? frameWidthMm.value : paper.value.widthMm,
  heightMm: kind.value === 'frame' ? frameHeightMm.value : paper.value.heightMm,
  text: text.value,
  font: font.value,
  fontMm: fontMm.value,
  cellMm: cellMm.value,
  gapMm: gapMm.value,
  color: color.value,
  secondColor: secondColor.value,
  thirdColor: thirdColor.value,
  colorMode: colorMode.value,
  pattern: pattern.value,
  polkaShape: polkaShape.value,
  dotMm: dotMm.value,
  seed: seed.value,
  frameShape: frameShape.value,
  frameFit: frameFit.value,
  frameZoom: frameZoom.value,
  offsetX: offsetX.value,
  offsetY: offsetY.value,
  textEffect: textEffect.value,
}))

function clearGenerated(): void {
  if (generated.value) URL.revokeObjectURL(generated.value.url)
  generated.value = null
  copied.value = false
}

async function onFileChange(event: Event): Promise<void> {
  const field = event.target as HTMLInputElement
  const file = field.files?.[0]
  field.value = ''
  if (!file) return
  try {
    const loaded = await loadLocalImage(file)
    if (image.value) URL.revokeObjectURL(image.value.url)
    image.value = loaded
    offsetX.value = 0
    offsetY.value = 0
    status.value = `已读取 ${loaded.name} · ${loaded.width} × ${loaded.height}px`
  } catch (error) {
    status.value = error instanceof Error ? error.message : '图片读取失败。'
  }
}

function renderPreview(): void {
  const canvas = preview.value
  if (!canvas) return
  try {
    count.value = renderCreative(canvas, settings.value)
  } catch (error) {
    status.value = error instanceof Error ? error.message : '预览失败。'
  }
}

watch(settings, () => { clearGenerated(); void nextTick(renderPreview) })
onMounted(() => { void nextTick(renderPreview) })
onBeforeUnmount(() => {
  if (image.value) URL.revokeObjectURL(image.value.url)
  clearGenerated()
})

function onPointerDown(event: PointerEvent): void {
  if (kind.value !== 'frame' || !image.value) return
  dragAt = { x: event.clientX, y: event.clientY }
  ;(event.target as HTMLCanvasElement).setPointerCapture(event.pointerId)
}
function onPointerMove(event: PointerEvent): void {
  if (!dragAt || !preview.value) return
  const bounds = preview.value.getBoundingClientRect()
  offsetX.value += (event.clientX - dragAt.x) / bounds.width
  offsetY.value += (event.clientY - dragAt.y) / bounds.height
  dragAt = { x: event.clientX, y: event.clientY }
}
function onPointerUp(): void { dragAt = null }

async function exportPng(): Promise<void> {
  if ((kind.value === 'recolor' || kind.value === 'frame') && !image.value) {
    status.value = '请先选择一张图片。'
    return
  }
  exporting.value = true
  status.value = '正在生成透明 PNG…'
  clearGenerated()
  try {
    await nextTick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const width = kind.value === 'recolor' && image.value ? image.value.width : Math.round(settings.value.widthMm / 25.4 * dpi.value)
    const height = kind.value === 'recolor' && image.value ? image.value.height : Math.round(settings.value.heightMm / 25.4 * dpi.value)
    if (width * height > 40_000_000) throw new Error('当前图片太大，请降低 DPI 或使用更小图片。')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const rendered = renderCreative(canvas, settings.value)
    if (!rendered) throw new Error('没有可导出的内容，请检查图片或文字。')
    const blob = await canvasPng(canvas, dpi.value)
    const url = URL.createObjectURL(blob)
    generated.value = { url, name: `${titles[kind.value]}-${Date.now()}.png` }
    status.value = `已生成 ${width} × ${height}px 透明 PNG`
    canvas.width = 0
    canvas.height = 0
  } catch (error) {
    status.value = error instanceof Error ? error.message : '导出失败。'
  } finally {
    exporting.value = false
  }
}

function download(): void {
  if (generated.value) downloadBlob(generated.value.url, generated.value.name)
}
async function copyOrder(): Promise<void> {
  copied.value = await copyText(XIAOHONGSHU_ORDER_TEXT)
  if (!copied.value) status.value = '浏览器未允许复制，可在帮助页长按文案手动复制。'
}
</script>

<template>
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3 overflow-x-hidden p-3 lg:flex-row lg:gap-0 lg:p-0">
    <button type="button" class="min-h-11 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white lg:hidden" @click="controlsOpen = !controlsOpen">{{ controlsOpen ? '收起工具设置' : `打开${titles[kind]}设置` }}</button>
    <div v-if="controlsOpen" class="fixed inset-0 z-30 bg-slate-950/60 lg:hidden" @click="controlsOpen = false"></div>
    <aside :class="controlsOpen ? 'fixed inset-x-0 bottom-0 top-0 z-40 block' : 'hidden lg:block'" class="w-full shrink-0 space-y-5 overflow-y-auto bg-slate-900 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-white lg:static lg:max-h-full lg:w-[390px] lg:rounded-none lg:pb-4">
      <button type="button" class="sticky top-0 z-10 flex min-h-11 w-full items-center justify-between rounded-xl bg-indigo-500 px-4 text-sm font-bold text-white lg:hidden" @click="controlsOpen = false"><span>{{ titles[kind] }}设置</span><span>完成 ✓</span></button>
      <div><h1 class="text-xl font-bold">{{ titles[kind] }}</h1><p class="mt-1 text-xs leading-5 text-slate-300">{{ descriptions[kind] }}</p></div>
      <section v-if="kind === 'recolor' || kind === 'frame'" class="space-y-2">
        <h2 class="text-xs font-bold uppercase tracking-widest text-indigo-200">导入图片</h2>
        <input ref="input" class="hidden" type="file" accept="image/png,image/webp,image/jpeg" @change="onFileChange" />
        <button type="button" class="min-h-16 w-full rounded-xl border-2 border-dashed border-slate-600 bg-slate-800 text-sm" @click="input?.click()">{{ image ? image.name : '＋ 选择图片' }}</button>
        <p v-if="kind === 'recolor'" class="text-xs leading-5 text-slate-400">建议使用透明底黑色线稿；白色区域会变透明。</p>
      </section>
      <section v-if="kind === 'polka' || kind === 'name' || kind === 'text'" class="space-y-2">
        <h2 class="text-xs font-bold uppercase tracking-widest text-indigo-200">纸张</h2>
        <div class="grid grid-cols-3 gap-2"><button v-for="option in paperOptions" :key="option.value" type="button" class="flex min-h-12 flex-col items-center justify-center rounded-lg text-xs leading-tight" :class="preset === option.value ? 'bg-indigo-400 font-bold text-slate-950' : 'bg-slate-800'" @click="preset = option.value"><span>{{ option.label }}</span><span class="mt-1 text-[10px] opacity-75">{{ option.size }}</span></button></div>
        <div class="grid grid-cols-2 gap-2"><button v-for="value in (['landscape', 'portrait'] as const)" :key="value" type="button" class="min-h-10 rounded-lg text-sm" :class="orientation === value ? 'bg-indigo-400 font-bold text-slate-950' : 'bg-slate-800'" @click="orientation = value">{{ value === 'landscape' ? '横排' : '竖排' }}</button></div>
      </section>
      <section v-if="kind === 'frame'" class="space-y-2">
        <h2 class="text-xs font-bold uppercase tracking-widest text-indigo-200">框架</h2>
        <div class="grid grid-cols-5 gap-1"><button v-for="option in ([['circle','圆形'],['heart','心形'],['rect','矩形'],['rounded','圆角'],['star','星形']] as const)" :key="option[0]" type="button" class="min-h-10 rounded-lg text-xs" :class="frameShape === option[0] ? 'bg-indigo-400 font-bold text-slate-950' : 'bg-slate-800'" @click="frameShape = option[0]">{{ option[1] }}</button></div>
        <div class="grid grid-cols-2 gap-2 text-xs"><label>宽 mm<input v-model.number="frameWidthMm" type="number" min="5" max="300" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white" /></label><label>高 mm<input v-model.number="frameHeightMm" type="number" min="5" max="300" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white" /></label></div>
        <div class="grid grid-cols-2 gap-2"><button type="button" class="min-h-10 rounded-lg text-sm" :class="frameFit === 'cover' ? 'bg-indigo-400 text-slate-950' : 'bg-slate-800'" @click="frameFit = 'cover'">填充框架</button><button type="button" class="min-h-10 rounded-lg text-sm" :class="frameFit === 'contain' ? 'bg-indigo-400 text-slate-950' : 'bg-slate-800'" @click="frameFit = 'contain'">完整显示</button></div>
        <label class="block text-xs">图片缩放 {{ frameZoom.toFixed(1) }}×<input v-model.number="frameZoom" type="range" min="0.3" max="3" step="0.1" class="mt-2 w-full" /></label>
        <button type="button" class="text-xs text-indigo-200" @click="offsetX = 0; offsetY = 0; frameZoom = 1">重置位置与缩放</button>
      </section>
      <section v-if="kind === 'polka'" class="space-y-3">
        <h2 class="text-xs font-bold uppercase tracking-widest text-indigo-200">图案</h2>
        <div class="grid grid-cols-5 gap-1"><button v-for="option in ([['circle','圆'],['ring','环'],['star','星'],['heart','心'],['hex','六边']] as const)" :key="option[0]" type="button" class="min-h-10 rounded-lg text-xs" :class="polkaShape === option[0] ? 'bg-indigo-400 font-bold text-slate-950' : 'bg-slate-800'" @click="polkaShape = option[0]">{{ option[1] }}</button></div>
        <div class="grid grid-cols-2 gap-2"><button type="button" class="min-h-10 rounded-lg text-sm" :class="pattern === 'grid' ? 'bg-indigo-400 text-slate-950' : 'bg-slate-800'" @click="pattern = 'grid'">均匀网格</button><button type="button" class="min-h-10 rounded-lg text-sm" :class="pattern === 'random' ? 'bg-indigo-400 text-slate-950' : 'bg-slate-800'" @click="pattern = 'random'">随机散布</button></div>
        <div class="grid grid-cols-2 gap-2 text-xs"><label>大小 mm<input v-model.number="dotMm" type="number" min="0.5" max="30" step="0.5" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white" /></label><label>间距 mm<input v-model.number="gapMm" type="number" min="0" max="50" step="0.5" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white" /></label></div>
        <button type="button" class="min-h-10 w-full rounded-lg bg-slate-800 text-sm" @click="seed += 1">🎲 换一组随机分布</button>
      </section>
      <section v-if="kind === 'name' || kind === 'text'" class="space-y-3">
        <h2 class="text-xs font-bold uppercase tracking-widest text-indigo-200">文字</h2>
        <textarea v-model="text" :rows="kind === 'text' ? 5 : 2" class="w-full rounded-lg bg-slate-800 p-3 text-sm text-white" :placeholder="kind === 'text' ? '每行一个文字或短句' : '输入姓名或短句'" />
        <label class="block text-xs">字体<select v-model="font" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white"><option value="Arial, sans-serif">无衬线</option><option value="Georgia, serif">衬线</option><option value="cursive">手写</option><option value="monospace">等宽</option></select></label>
        <div class="grid grid-cols-2 gap-2 text-xs"><label>字号 mm<input v-model.number="fontMm" type="number" min="1" max="40" step="0.5" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white" /></label><label>{{ kind === 'text' ? '方格 mm' : '间距 mm' }}<input v-if="kind === 'text'" v-model.number="cellMm" type="number" min="5" max="100" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white" /><input v-else v-model.number="gapMm" type="number" min="0" max="50" step="0.5" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white" /></label></div>
        <label v-if="kind === 'text'" class="block text-xs">特效<select v-model="textEffect" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white"><option value="none">无</option><option value="outline">描边</option><option value="shadow">阴影</option><option value="glow">发光</option></select></label>
      </section>
      <section v-if="kind !== 'frame'" class="space-y-3">
        <h2 class="text-xs font-bold uppercase tracking-widest text-indigo-200">颜色</h2>
        <div class="grid grid-cols-3 gap-2"><button v-for="option in ([['solid','单色'],['gradient','渐变'],['rainbow','彩虹']] as const)" :key="option[0]" type="button" class="min-h-10 rounded-lg text-xs" :class="colorMode === option[0] ? 'bg-indigo-400 font-bold text-slate-950' : 'bg-slate-800'" @click="colorMode = option[0]">{{ option[1] }}</button></div>
        <div class="flex items-center gap-3"><label class="text-xs">主色<input v-model="color" type="color" class="ml-2 h-9 w-12 align-middle" /></label><label v-if="colorMode !== 'solid'" class="text-xs">第二色<input v-model="secondColor" type="color" class="ml-2 h-9 w-12 align-middle" /></label><label v-if="kind === 'polka' && colorMode !== 'solid'" class="text-xs">第三色<input v-model="thirdColor" type="color" class="ml-2 h-9 w-12 align-middle" /></label></div>
      </section>
      <label v-if="kind !== 'recolor'" class="block text-xs">导出精度<select v-model.number="dpi" class="mt-1 h-10 w-full rounded bg-slate-800 px-2 text-white"><option :value="300">300 DPI</option><option :value="600">600 DPI</option></select></label>
      <p class="text-xs leading-5 text-slate-400">{{ kind === 'recolor' ? '按原图像素导出。' : '透明背景；600 DPI 在手机上可能需要更多内存。' }}</p>
    </aside>
    <main class="flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:p-5">
      <div class="flex flex-wrap items-center gap-2 text-xs text-slate-600"><span class="rounded-full bg-white px-3 py-1.5">{{ titles[kind] }}</span><span class="rounded-full bg-white px-3 py-1.5">{{ count }} {{ kind === 'polka' ? '个图案' : kind === 'name' || kind === 'text' ? '个文字' : '张图片' }}</span><span class="rounded-full bg-white px-3 py-1.5">透明背景 PNG</span></div>
      <div class="flex min-h-[45dvh] min-w-0 flex-1 items-center justify-center overflow-auto rounded-2xl bg-slate-800 p-3 sm:min-h-[480px] sm:p-6 lg:min-h-0">
        <canvas ref="preview" :width="previewWidth" :height="previewHeight" class="block h-auto max-h-[calc(100dvh-230px)] max-w-full touch-none bg-[linear-gradient(45deg,#ddd_25%,transparent_25%),linear-gradient(-45deg,#ddd_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#ddd_75%),linear-gradient(-45deg,transparent_75%,#ddd_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0] bg-white shadow-2xl lg:max-h-full" :class="kind === 'frame' ? 'cursor-grab' : ''" :aria-label="`${titles[kind]}实时预览`" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp" />
      </div>
      <div class="sticky bottom-2 z-10 space-y-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-lg lg:static">
        <p class="text-xs text-slate-600" aria-live="polite">{{ status }}</p>
        <div class="grid grid-cols-2 gap-2"><button type="button" class="min-h-11 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white disabled:opacity-50" :disabled="exporting" @click="exportPng">{{ exporting ? '生成中…' : '生成透明 PNG' }}</button><button type="button" class="min-h-11 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white disabled:opacity-50" :disabled="!generated" @click="download">下载图片</button></div>
        <div v-if="generated" class="flex flex-wrap items-center gap-3 text-xs"><span class="text-emerald-700">{{ generated.name }}</span><button type="button" class="font-bold text-rose-600" @click="copyOrder">{{ copied ? '文案已复制 ✓' : '复制下单文案' }}</button><a :href="XIAOHONGSHU_ORDER_URL" target="_blank" rel="noopener noreferrer" class="font-bold text-rose-600">去小红书下单 ↗</a></div>
      </div>
    </main>
    <div v-if="exporting" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-5" role="status"><div class="rounded-2xl bg-white p-6 text-center shadow-xl"><span class="mx-auto block h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-indigo-600"></span><p class="mt-4 font-bold">正在生成 PNG</p><p class="mt-1 text-sm text-slate-500">请勿关闭页面</p></div></div>
  </div>
</template>
