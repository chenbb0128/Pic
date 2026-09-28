import { computed, markRaw, ref } from 'vue'
import { defineStore } from 'pinia'
import { summarizeQuality } from '../domain/assets/quality'
import type { AssetRecord } from '../domain/assets/types'
import { DEFAULT_LAYOUT, DPI_OPTIONS } from '../domain/layout/constants'
import { calculateSlots } from '../domain/layout/slotCalculator'
import type { LayoutMode } from '../domain/layout/types'
import { releaseImage } from '../services/assetLoader'
import type { ExportResult } from '../services/pngExporter'

function rawAsset(asset: AssetRecord): AssetRecord {
  return markRaw({ ...asset, image: markRaw(asset.image) })
}

export const useEditorStore = defineStore('editor', () => {
  const mode = ref<LayoutMode>(DEFAULT_LAYOUT.mode)
  const rows2 = ref<number>(DEFAULT_LAYOUT.rows2)
  const rows3 = ref<number>(DEFAULT_LAYOUT.rows3)
  const dpi = ref<(typeof DPI_OPTIONS)[number]>(300)
  const fileName = ref('')
  const assets2 = ref<AssetRecord[]>([])
  const assets3 = ref<AssetRecord[]>([])
  const exportStatus = ref('PNG 无损透明底；高质量渐进缩放；写入真实 DPI。')
  const exporting = ref(false)
  const generated = ref<(ExportResult & { url: string; name: string }) | null>(null)

  const config = computed(() => ({ mode: mode.value, rows2: rows2.value, rows3: rows3.value }))
  const layout = computed(() => calculateSlots(config.value))
  const quality = computed(() => summarizeQuality(
    [...assets2.value, ...assets3.value].map((asset) => ({ width: asset.width, height: asset.height, type: asset.type })),
    dpi.value,
  ))

  function setMode(value: LayoutMode) { mode.value = value }
  function setRows2(value: number) { rows2.value = value }
  function setRows3(value: number) { rows3.value = value }
  function setDpi(value: number) { dpi.value = value === 600 ? 600 : 300 }
  function setFileName(value: string) { fileName.value = value }
  function addAssets(type: '2cm' | '3cm', incoming: AssetRecord[]) {
    const target = type === '2cm' ? assets2 : assets3
    target.value.push(...incoming.map(rawAsset))
  }
  function clearAssets(type: '2cm' | '3cm') {
    const target = type === '2cm' ? assets2 : assets3
    target.value.forEach(releaseImage)
    target.value = []
  }
  function clearGenerated() {
    if (generated.value) URL.revokeObjectURL(generated.value.url)
    generated.value = null
  }
  function setGenerated(value: ExportResult & { url: string; name: string }) {
    clearGenerated()
    generated.value = markRaw(value)
  }
  function dispose() {
    clearAssets('2cm')
    clearAssets('3cm')
    clearGenerated()
  }

  return {
    mode, rows2, rows3, dpi, fileName, assets2, assets3, exportStatus, exporting, generated,
    config, layout, quality, setMode, setRows2, setRows3, setDpi, setFileName,
    addAssets, clearAssets, clearGenerated, setGenerated, dispose,
  }
})
