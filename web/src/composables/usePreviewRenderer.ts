import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PREVIEW_SIZE } from '../domain/layout/constants'
import { renderLayout } from '../services/canvasRenderer'
import { useEditorStore } from '../stores/editor'

export function usePreviewRenderer() {
  const store = useEditorStore()
  const canvas = ref<HTMLCanvasElement | null>(null)

  function render(): void {
    const element = canvas.value
    if (!element) return
    const context = element.getContext('2d')
    if (!context) return
    renderLayout(context, PREVIEW_SIZE.width, PREVIEW_SIZE.height, store.layout, store.assets2, store.assets3, { guides: true })
  }

  onMounted(() => nextTick(render))
  const stop = watch(
    () => [store.mode, store.rows2, store.rows3, store.assets2.length, store.assets3.length],
    () => nextTick(render),
  )
  onBeforeUnmount(stop)

  return { canvas, render }
}
