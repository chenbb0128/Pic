import { computed, nextTick, ref } from 'vue'
import { buildExportFileName } from '../domain/export/fileName'
import { XIAOHONGSHU_ORDER_TEXT, XIAOHONGSHU_ORDER_URL } from '../domain/order'
import { copyText, runCopyDownloadStep } from '../services/clipboard'
import { exportLayoutPng, formatBytes } from '../services/pngExporter'
import { useEditorStore } from '../stores/editor'

export function usePngExport() {
  const store = useEditorStore()
  const copyResult = ref<'idle' | 'copied' | 'manual'>('idle')
  const buttonConfirmed = ref(false)
  const canExport = computed(() => {
    if (store.mode === 'full2') return store.assets2.length > 0
    if (store.mode === 'full3') return store.assets3.length > 0
    return store.assets2.length > 0 || store.assets3.length > 0
  })

  async function generate(): Promise<void> {
    if (!canExport.value) {
      store.exportStatus = '请先上传当前排版模式需要的素材。'
      return
    }
    store.exporting = true
    store.clearGenerated()
    copyResult.value = 'idle'
    buttonConfirmed.value = false
    store.exportStatus = '正在准备高清 PNG…'
    try {
      await nextTick()
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      const result = await exportLayoutPng({
        config: store.config,
        dpi: store.dpi,
        assets2: store.assets2,
        assets3: store.assets3,
      })
      const url = URL.createObjectURL(result.blob)
      const name = buildExportFileName(store.fileName, store.mode, store.dpi, result.width, result.height)
      store.setGenerated({ ...result, url, name })
      store.exportStatus = `✓ 高清 PNG 已生成：${result.width} × ${result.height}px｜${store.dpi} DPI｜${formatBytes(result.blob.size)}`
    } catch (error) {
      const message = error instanceof Error ? error.message : '浏览器无法完成高清导出。'
      store.exportStatus = `${message} 如果设备内存不足，请尝试切换到 300 DPI。`
    } finally {
      store.exporting = false
    }
  }

  function download(): void {
    if (!store.generated) return
    const link = document.createElement('a')
    link.href = store.generated.url
    link.download = store.generated.name
    link.click()
  }

  async function copyOrderText(): Promise<boolean> {
    const copied = await copyText(XIAOHONGSHU_ORDER_TEXT)
    copyResult.value = copied ? 'copied' : 'manual'
    buttonConfirmed.value = copied
    return copied
  }

  async function copyOrDownload(): Promise<void> {
    if (!store.generated) return
    buttonConfirmed.value = await runCopyDownloadStep(
      buttonConfirmed.value,
      copyOrderText,
      download,
    )
  }

  function openPreview(): void {
    if (!store.generated) return
    const popup = window.open('', '_blank')
    if (!popup) {
      window.location.href = store.generated.url
      return
    }
    popup.document.title = store.generated.name
    const image = popup.document.createElement('img')
    image.src = store.generated.url
    image.alt = store.generated.name
    image.style.cssText = 'display:block;max-width:100%;margin:auto;background:#888'
    popup.document.body.style.cssText = 'margin:0;background:#888;min-height:100vh'
    popup.document.body.append(image)
  }

  return {
    canExport,
    copyResult,
    buttonConfirmed,
    orderText: XIAOHONGSHU_ORDER_TEXT,
    orderUrl: XIAOHONGSHU_ORDER_URL,
    generate,
    download,
    copyOrDownload,
    copyOrderText,
    openPreview,
  }
}
