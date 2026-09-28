import { ref } from 'vue'
import type { StickerType } from '../domain/layout/types'
import { loadImageFile } from '../services/assetLoader'
import { useEditorStore } from '../stores/editor'

export function useAssetUpload(type: StickerType) {
  const store = useEditorStore()
  const loading = ref(false)
  const status = ref('未上传')
  const errors = ref<string[]>([])

  async function handleFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files)
    if (!list.length) return
    loading.value = true
    errors.value = []
    status.value = `正在读取 ${list.length} 张…`
    const loaded = []
    for (const file of list) {
      try {
        loaded.push(await loadImageFile(file, type))
      } catch (error) {
        errors.value.push(error instanceof Error ? error.message : `${file.name} 读取失败。`)
      }
    }
    store.addAssets(type, loaded)
    const count = type === '2cm' ? store.layout.slots2.length : store.layout.slots3.length
    status.value = `已读取 ${loaded.length} 张；当前模式将循环填满 ${count} 个位置`
    loading.value = false
  }

  function clear(): void {
    store.clearAssets(type)
    status.value = '未上传'
    errors.value = []
  }

  return { loading, status, errors, handleFiles, clear }
}
