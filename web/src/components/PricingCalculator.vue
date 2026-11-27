<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { imageSizePresets, type ImageSizePreset } from '../domain/studio/imageSizeConversion'
import { calculateLayoutPricing } from '../domain/studio/layoutPricing'

const defaultPaper = imageSizePresets.find(preset => preset.value === 'A4') ?? imageSizePresets[0]
const form = reactive({
  canvasWidthMm: defaultPaper.widthMm as number | '',
  canvasHeightMm: defaultPaper.heightMm as number | '',
  patternWidthMm: '' as number | '',
  patternHeightMm: '' as number | '',
  gapMm: 4 as number | '',
  marginMm: 4 as number | '',
  sheetPrice: 5 as number | '',
})

const fields = [
  { key: 'canvasWidthMm', label: '画布宽度', unit: 'mm', min: 0.1, step: 0.1, required: true },
  { key: 'canvasHeightMm', label: '画布高度', unit: 'mm', min: 0.1, step: 0.1, required: true },
  { key: 'patternWidthMm', label: '图案宽度', unit: 'mm', min: 0.1, step: 0.1, required: true },
  { key: 'patternHeightMm', label: '图案高度', unit: 'mm', min: 0.1, step: 0.1, required: true },
  { key: 'gapMm', label: '图案间隔', unit: 'mm', min: 0, step: 0.1, required: false },
  { key: 'marginMm', label: '每边留白', unit: 'mm', min: 0, step: 0.1, required: false },
  { key: 'sheetPrice', label: '单张费用', unit: '元', min: 0, step: 0.01, required: true },
] as const

function choosePaper(preset: ImageSizePreset) {
  form.canvasWidthMm = preset.widthMm
  form.canvasHeightMm = preset.heightMm
}

const submitted = ref(false)
const estimate = computed(() => submitted.value ? calculateLayoutPricing({
  canvasWidthMm: Number(form.canvasWidthMm),
  canvasHeightMm: Number(form.canvasHeightMm),
  patternWidthMm: Number(form.patternWidthMm),
  patternHeightMm: Number(form.patternHeightMm),
  gapMm: Number(form.gapMm),
  marginMm: Number(form.marginMm),
  sheetPrice: form.sheetPrice === '' ? NaN : form.sheetPrice,
}) : null)
</script>

<template>
  <section class="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6" aria-labelledby="pricing-calculator-title">
    <h2 id="pricing-calculator-title" class="text-xl font-bold text-slate-900">排版价格计算器</h2>
    <div class="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <form class="min-w-0 space-y-4" @submit.prevent="submitted = true">
        <fieldset>
          <legend class="mb-2 text-sm font-semibold text-slate-700">纸张尺寸</legend>
          <div class="grid grid-cols-3 gap-2 sm:grid-cols-5">
            <button
              v-for="preset in imageSizePresets"
              :key="preset.value"
              type="button"
              :aria-pressed="form.canvasWidthMm === preset.widthMm && form.canvasHeightMm === preset.heightMm"
              class="min-h-12 rounded-lg border border-slate-200 px-1 py-1.5 text-sm font-semibold text-slate-700 hover:border-sky-500 aria-pressed:border-sky-500 aria-pressed:bg-sky-50 aria-pressed:text-sky-800"
              @click="choosePaper(preset)"
            >
              {{ preset.label }}
              <span class="block text-xs font-normal text-slate-500">{{ preset.widthMm }}×{{ preset.heightMm }}</span>
            </button>
          </div>
        </fieldset>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label v-for="field in fields" :key="field.key" class="block min-w-0 text-sm text-slate-700">
            <span>{{ field.label }}</span>
            <span class="relative mt-1 block">
              <input
                v-model.number="form[field.key]"
                type="number"
                inputmode="decimal"
                :min="field.min"
                :step="field.step"
                :required="field.required"
                class="min-h-10 w-full rounded-lg border border-slate-300 bg-white py-2 pl-2.5 pr-9 text-slate-900 focus:border-sky-600 focus:outline-2 focus:outline-offset-1 focus:outline-sky-600"
              />
              <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-slate-500" aria-hidden="true">{{ field.unit }}</span>
            </span>
          </label>
        </div>

        <button type="submit" class="min-h-10 w-full rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 sm:w-auto">
          计算价格
        </button>
      </form>

      <div class="min-w-0 rounded-xl border border-sky-100 bg-sky-50 p-4" aria-live="polite">
        <p v-if="!estimate" class="text-sm leading-6 text-slate-600">输入图案尺寸即可计算单张容量和每个图案的估算单价。</p>
        <p v-else-if="'error' in estimate" class="text-sm font-medium text-red-700">{{ estimate.error }}</p>
        <template v-else>
          <dl class="grid grid-cols-2 gap-3">
            <div>
              <dt class="text-sm text-slate-600">单张容量</dt>
              <dd class="mt-1 text-2xl font-bold text-slate-900">{{ estimate.count }} <span class="text-sm font-medium">个</span></dd>
            </div>
            <div>
              <dt class="text-sm text-slate-600">估算单价</dt>
              <dd class="mt-1 text-2xl font-bold text-sky-800">
                {{ estimate.unitPrice === null ? '—' : estimate.unitPrice.toFixed(4) }}
                <span v-if="estimate.unitPrice !== null" class="text-sm font-medium">元/个</span>
              </dd>
            </div>
          </dl>
          <p class="mt-3 border-t border-sky-100 pt-3 text-sm text-slate-700">
            {{ estimate.columns }} 列 × {{ estimate.rows }} 行 · 可用尺寸 {{ estimate.usableWidthMm }} × {{ estimate.usableHeightMm }} mm
          </p>
          <p class="mt-1 text-xs leading-5 text-slate-600">
            {{ estimate.count ? `${form.sheetPrice} 元 ÷ ${estimate.count} 个` : '当前设置下放不下单个图案。' }}
          </p>
        </template>
      </div>
    </div>
  </section>
</template>
