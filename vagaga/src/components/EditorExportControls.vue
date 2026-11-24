<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Copy, Download, Image as ImageIcon } from '@lucide/vue'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

const props = defineProps<{ source: HTMLElement; filename: HTMLOutputElement }>()
const editor = props.source.ownerDocument
const inputs = {
  numberingEnabled: props.source.querySelector<HTMLInputElement>('#numberingEnabled')!,
  sheetTotal: editor.querySelector<HTMLInputElement>('#sheetTotal')!,
  sheetIndex: editor.querySelector<HTMLInputElement>('#sheetIndex')!,
  watermarkEnabled: props.source.querySelector<HTMLInputElement>('#watermarkEnabled')!,
  watermarkText: props.source.querySelector<HTMLInputElement>('#watermarkText')!,
  watermarkOpacity: props.source.querySelector<HTMLInputElement>('#watermarkOpacity')!,
}
const copy = props.source.querySelector<HTMLButtonElement>('#copyFooterText')!
const download = props.source.querySelector<HTMLButtonElement>('#downloadWatermarked')!
const product = props.source.querySelector<HTMLButtonElement>('#productPreview')!
const productControl = ref<InstanceType<typeof Button> | null>(null)
const state = reactive({
  numbering: false, total: '', index: '', watermark: false, text: '', opacity: 40,
  downloadDisabled: true, productOpen: false,
})

function sync() {
  state.numbering = inputs.numberingEnabled.checked
  state.total = inputs.sheetTotal.value
  state.index = inputs.sheetIndex.value
  state.watermark = inputs.watermarkEnabled.checked
  state.text = inputs.watermarkText.value
  state.opacity = Number(inputs.watermarkOpacity.value)
  state.downloadDisabled = download.disabled
  const open = product.getAttribute('aria-expanded') === 'true'
  if (state.productOpen && !open) void nextTick(() => productControl.value?.$el.focus())
  state.productOpen = open
}

function toggle(field: 'numberingEnabled' | 'watermarkEnabled', value: boolean) {
  inputs[field].checked = value
  inputs[field].dispatchEvent(new Event('change', { bubbles: true }))
}

function setValue(field: 'sheetTotal' | 'sheetIndex' | 'watermarkText' | 'watermarkOpacity', value: string | number) {
  inputs[field].value = String(value)
  inputs[field].dispatchEvent(new Event('input', { bubbles: true }))
}

function commitCount(field: 'sheetTotal' | 'sheetIndex', event: Event) {
  inputs[field].dispatchEvent(new Event('change', { bubbles: true }))
  const control = event.target as HTMLInputElement
  control.value = inputs[field].value
}

sync()
const observer = new MutationObserver(sync)
const sheetControls = [inputs.sheetTotal, inputs.sheetIndex]
onMounted(() => {
  props.source.addEventListener('input', sync)
  props.source.addEventListener('change', sync)
  editor.addEventListener('pic-order-sheets', sync)
  for (const field of sheetControls) {
    field.addEventListener('input', sync)
    field.addEventListener('change', sync)
  }
  observer.observe(props.source, { subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-expanded'] })
  observer.observe(props.filename, { childList: true, characterData: true, subtree: true })
})
onBeforeUnmount(() => {
  props.source.removeEventListener('input', sync)
  props.source.removeEventListener('change', sync)
  editor.removeEventListener('pic-order-sheets', sync)
  for (const field of sheetControls) {
    field.removeEventListener('input', sync)
    field.removeEventListener('change', sync)
  }
  observer.disconnect()
})
</script>

<template>
  <div class="grid gap-3 text-xs text-foreground" @keydown.stop>
    <div class="grid gap-2 border-t border-input/60 pt-2">
      <div class="flex items-center justify-between gap-2">
        <label for="exportNumbering" class="font-medium">启用编号</label>
        <Switch id="exportNumbering" class="p-0"
          :model-value="state.numbering" @update:model-value="toggle('numberingEnabled', $event)" />
      </div>
      <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
        <label class="grid gap-1 text-muted-foreground">
          总张数
          <Input type="number" min="1" max="999" step="1" inputmode="numeric" class="h-8 px-2 text-xs text-foreground"
            :model-value="state.total" :disabled="!state.numbering"
            @input="setValue('sheetTotal', ($event.target as HTMLInputElement).value)" @change="commitCount('sheetTotal', $event)" />
        </label>
        <label class="grid gap-1 text-muted-foreground">
          当前张数
          <Input type="number" min="1" max="999" step="1" inputmode="numeric" class="h-8 px-2 text-xs text-foreground"
            :model-value="state.index" :disabled="!state.numbering"
            @input="setValue('sheetIndex', ($event.target as HTMLInputElement).value)" @change="commitCount('sheetIndex', $event)" />
        </label>
        <Button type="button" variant="outline" size="icon-sm" class="p-0" title="复制编号" aria-label="复制编号"
          :disabled="!state.numbering" @click="copy.click()">
          <Copy aria-hidden="true" />
        </Button>
      </div>
    </div>
    <div class="grid gap-2 border-t border-input/60 pt-2">
      <div class="flex items-center justify-between gap-2">
        <label for="exportWatermark" class="font-medium">预览水印</label>
        <Switch id="exportWatermark" class="p-0"
          :model-value="state.watermark" @update:model-value="toggle('watermarkEnabled', $event)" />
      </div>
      <Input type="text" maxlength="40" aria-label="水印文字" class="h-8 px-2 text-xs"
        :model-value="state.text" :disabled="!state.watermark"
        @input="setValue('watermarkText', ($event.target as HTMLInputElement).value)" />
      <div class="grid gap-1">
        <div class="flex items-center justify-between text-muted-foreground">
          <span>水印浓度</span><span class="tabular-nums">{{ state.opacity }}%</span>
        </div>
        <SliderRoot class="relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-50"
          :min="8" :max="50" :step="1" :model-value="[state.opacity]" :disabled="!state.watermark"
          @update:model-value="$event?.length && setValue('watermarkOpacity', $event[0])">
          <SliderTrack class="relative h-1 w-full grow overflow-hidden rounded-full bg-muted">
            <SliderRange class="absolute h-full bg-primary" />
          </SliderTrack>
          <SliderThumb aria-label="水印浓度" :aria-disabled="!state.watermark"
            class="block size-3.5 rounded-full border border-primary bg-background shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />
        </SliderRoot>
      </div>
    </div>
    <div class="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" class="text-xs" :disabled="state.downloadDisabled" @click="download.click()">
        <Download aria-hidden="true" />下载带水印预览图
      </Button>
      <Button ref="productControl" type="button" variant="outline" size="sm" class="text-xs" aria-haspopup="dialog"
        :aria-expanded="state.productOpen" @click="product.click()">
        <ImageIcon aria-hidden="true" />商品展示图
      </Button>
    </div>
  </div>
</template>
