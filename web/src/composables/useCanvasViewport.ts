import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import type { PaperSize } from '../domain/studio/layout'

export function useCanvasViewport(paper: Readonly<Ref<PaperSize>>) {
  const workspace = ref<HTMLElement | null>(null)
  const viewport = ref<HTMLElement | null>(null)
  const sheet = ref<HTMLElement | null>(null)
  const available = ref({ width: 0, height: 0 })
  const zoom = ref(1)
  const expanded = ref(false)
  let observer: ResizeObserver | undefined
  const canvasStyle = computed(() => {
    if (!available.value.width || !available.value.height) return {}
    const factor = Math.min(Math.max(1, available.value.width - 24) / paper.value.widthMm,
      Math.max(1, available.value.height - 24) / paper.value.heightMm) * zoom.value
    return { width: `${paper.value.widthMm * factor}px`, height: `${paper.value.heightMm * factor}px` }
  })

  function measure(): void {
    const element = viewport.value
    if (element) available.value = { width: element.clientWidth, height: element.clientHeight }
  }

  function setZoom(value: number): void {
    if (!Number.isFinite(value)) return
    const stage = viewport.value, old = sheet.value?.getBoundingClientRect(), bounds = stage?.getBoundingClientRect?.()
    const center = old && bounds ? {
      x: (bounds.left + stage!.clientWidth / 2 - old.left) / old.width,
      y: (bounds.top + stage!.clientHeight / 2 - old.top) / old.height,
    } : null
    zoom.value = Math.max(.5, Math.min(4, value))
    void nextTick(() => {
      const current = sheet.value?.getBoundingClientRect()
      if (stage && bounds && center && current) {
        stage.scrollLeft += current.left + center.x * current.width - (bounds.left + stage.clientWidth / 2)
        stage.scrollTop += current.top + center.y * current.height - (bounds.top + stage.clientHeight / 2)
      }
    })
  }

  function fit(): void {
    zoom.value = 1
    measure()
    void nextTick(() => { if (viewport.value) { viewport.value.scrollLeft = 0; viewport.value.scrollTop = 0 } })
  }

  async function toggleFullscreen(): Promise<void> {
    if (!workspace.value) return
    if (expanded.value) {
      if (typeof document !== 'undefined' && document.fullscreenElement === workspace.value) await document.exitFullscreen()
      expanded.value = false
    } else {
      // Unsupported or denied native fullscreen still gets a full-window workspace.
      try { await workspace.value.requestFullscreen?.() } catch { /* Use the CSS fallback. */ }
      expanded.value = true
    }
    await nextTick()
    measure()
  }

  function onFullscreenChange(): void {
    expanded.value = typeof document !== 'undefined' && document.fullscreenElement === workspace.value
    void nextTick(measure)
  }

  function onFullscreenKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && expanded.value && (typeof document === 'undefined' || !document.fullscreenElement)) {
      expanded.value = false
      void nextTick(measure)
    }
  }

  onMounted(() => {
    measure()
    if (viewport.value && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(viewport.value)
    }
    if (typeof window !== 'undefined') { window.addEventListener?.('resize', measure); window.addEventListener?.('keydown', onFullscreenKeydown) }
    if (typeof document !== 'undefined') document.addEventListener?.('fullscreenchange', onFullscreenChange)
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    if (typeof window !== 'undefined') { window.removeEventListener?.('resize', measure); window.removeEventListener?.('keydown', onFullscreenKeydown) }
    if (typeof document !== 'undefined') {
      document.removeEventListener?.('fullscreenchange', onFullscreenChange)
      if (workspace.value && document.fullscreenElement === workspace.value) void document.exitFullscreen().catch(() => {})
    }
  })
  return { workspace, viewport, sheet, zoom, expanded, canvasStyle, measure, setZoom, fit, toggleFullscreen, onFullscreenChange, onFullscreenKeydown }
}
