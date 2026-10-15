<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { fitSizeMm, originalSizeMm, resizeAssetSize, rotatedBounds } from '../domain/studio/assetGeometry'
import { DIRECT_CANVAS_MAX_PIXELS, exportSize } from '../domain/studio/exportSize'
import { flattenGroups, lockGroup, mergeGroups, type LockedGroup } from '../domain/studio/groups'
import { imageSizePresets } from '../domain/studio/imageSizeConversion'
import { arrangeItems, orientedPaperSize, paperSize, type LayoutMode, type Orientation, type PaperPreset, type Placement, type SmartGrouping } from '../domain/studio/layout'
import { resizePlacement } from '../domain/studio/placementAdjustments'
import { clampPaperPosition, PAPER_MARGIN_MM } from '../domain/studio/paperBounds'
import { XIAOHONGSHU_ORDER_TEXT, XIAOHONGSHU_ORDER_URL } from '../domain/order'
import { copyText } from '../services/clipboard'
import { canvasPng, downloadBlob, drawImageContained, loadLocalImage, tiledCanvasPng, type LocalImage } from '../services/studioImage'
import { formatBytes } from '../services/pngExporter'
import { imageContour } from '../services/imageContour'

interface StudioAsset extends LocalImage {
  widthMm: number
  heightMm: number
  quantity: number
  selected: boolean
  important: boolean
  ratioLocked: boolean
  rotationDeg: number
  lockedGroupId?: string
}

interface DragState {
  pointerId: number
  startXmm: number
  startYmm: number
  originXmm: number
  originYmm: number
  normalIndex?: number
  groupId?: string
}

interface StudioBoard {
  preset: PaperPreset
  orientation: Orientation
  customWidth: number
  customHeight: number
  dpi: number
  mode: LayoutMode
  grouping: SmartGrouping
  gapXmm: number
  gapYmm: number
  autoGap: boolean
  useContours: boolean
  assets: StudioAsset[]
  groups: LockedGroup[]
  manualPlacements: Placement[]
}

const preset = ref<PaperPreset>('A4')
const orientation = ref<Orientation>('landscape')
const customWidth = ref(293)
const customHeight = ref(210)
const dpi = ref(500)
const mode = ref<LayoutMode>('custom')
const grouping = ref<SmartGrouping>('free')
const groupingOptions = [{ value: 'free', label: '尽量填满' }, { value: 'rows', label: '同类按行' }, { value: 'columns', label: '同类按列' }] as const
const gapXmm = ref(5)
const gapYmm = ref(2)
const autoGap = ref(false)
const useContours = ref(true)
const assets = shallowRef<StudioAsset[]>([])
const groups = shallowRef<LockedGroup[]>([])
const manualPlacements = shallowRef<Placement[] | null>(null)
const preview = ref<HTMLCanvasElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)
const controlsOpen = ref(false)
const bulkOpen = ref(false)
const bulkLongEdgeCm = ref(5)
const bulkQuantity = ref(1)
const uploading = ref(false)
const exporting = ref(false)
const exportProgress = ref<number | null>(null)
const adjusting = ref(false)
const background = ref<'checker' | 'white' | 'dark'>('checker')
const drag = ref<DragState | null>(null)
const selectedPlacementIndex = ref<number | null>(null)
const status = ref('选择图片并设置尺寸后，画布会实时显示排版。')
const generated = ref<{ url: string; name: string; size: number } | null>(null)
const orderCopied = ref(false)
const manualCopy = ref(false)
// The active board lives in the editor refs; inactive boards hold independent snapshots.
const boards = shallowRef<(StudioBoard | null)[]>([null])
const activeBoardIndex = ref(0)
let switchingBoard = false
const dpiChoices = [300, 500, 800, 1000]
const paperOptions = [
  ...imageSizePresets.map((option) => {
    const size = paperSize(option.value, 'landscape')
    return { value: option.value, label: option.label, size: `${size.widthMm}×${size.heightMm}mm`, portraitSize: `${size.heightMm}×${size.widthMm}mm` }
  }),
  { value: 'custom' as const, label: '自由', size: '自定尺寸', portraitSize: '自定尺寸' },
]

const paper = computed(() => orientedPaperSize(preset.value, orientation.value, customWidth.value, customHeight.value))
const dpiInfo = computed(() => exportSize(paper.value, dpi.value))
const dpiError = computed(() => {
  if (!Number.isInteger(dpi.value) || dpi.value <= 0) return '请输入大于 0 的整数 DPI。'
  if (!dpiInfo.value.allowed) return '当前纸张和 DPI 超过 1 亿像素导出上限，请降低 DPI。'
  return ''
})
const lockedPlacements = computed(() => flattenGroups(groups.value))
function arrangeAssets(source: StudioAsset[], reserved: Placement[]) {
  return arrangeItems({
    paper: paper.value,
    gapXmm: gapXmm.value,
    gapYmm: gapYmm.value,
    autoGap: autoGap.value,
    mode: mode.value,
    grouping: grouping.value,
    reserved,
    items: source.map((asset) => ({
      id: asset.id,
      ...rotatedBounds(asset.widthMm, asset.heightMm, asset.rotationDeg),
      quantity: asset.quantity,
      selected: asset.selected && !asset.lockedGroupId,
      important: asset.important,
      contour: mode.value === 'smart' && grouping.value === 'free' && useContours.value && asset.selected && !asset.lockedGroupId
        ? imageContour(asset.image, asset.widthMm, asset.heightMm, asset.rotationDeg, asset.ratioLocked) : undefined,
    })),
  })
}
const layout = computed(() => arrangeAssets(assets.value, lockedPlacements.value))
function overlaps(a: Placement, b: Placement): boolean {
  return a.xMm < b.xMm + b.widthMm + gapXmm.value && a.xMm + a.widthMm + gapXmm.value > b.xMm &&
    a.yMm < b.yMm + b.heightMm + gapYmm.value && a.yMm + a.heightMm + gapYmm.value > b.yMm
}
const normalAuto = computed(() => mode.value === 'smart' ? layout.value.placements : layout.value.placements.filter((placement) =>
  lockedPlacements.value.every((locked) => !overlaps(placement, locked))))
const placements = computed(() => [...lockedPlacements.value, ...(manualPlacements.value ?? normalAuto.value)])
const paperMarginError = computed(() => placements.value.some((slot) =>
  slot.xMm < PAPER_MARGIN_MM - 1e-6 || slot.yMm < PAPER_MARGIN_MM - 1e-6 ||
  slot.xMm + slot.widthMm > paper.value.widthMm - PAPER_MARGIN_MM + 1e-6 ||
  slot.yMm + slot.heightMm > paper.value.heightMm - PAPER_MARGIN_MM + 1e-6)
  ? '部分图案或锁组超出 4mm 留边，请调整位置、尺寸或更换纸张后导出。' : '')
const placementCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const slot of placements.value) counts.set(slot.itemId, (counts.get(slot.itemId) ?? 0) + 1)
  return counts
})
const selectedPlacement = computed(() => selectedPlacementIndex.value === null ? null : placements.value[selectedPlacementIndex.value] ?? null)
const selectedAsset = computed(() => assets.value.find((asset) => asset.id === selectedPlacement.value?.itemId))
const selectedLocked = computed(() => selectedPlacementIndex.value !== null && selectedPlacementIndex.value < lockedPlacements.value.length)
const countMode = computed(() => mode.value === 'custom' || mode.value === 'smart')
const remainingAssets = computed(() => countMode.value ? assets.value
  .filter((asset) => asset.selected || asset.lockedGroupId)
  .map((asset) => ({
    ...asset,
    quantity: Math.max(0, (Number.isFinite(asset.quantity) ? Math.min(500, Math.max(0, Math.floor(asset.quantity))) : 0) - (placementCounts.value.get(asset.id) ?? 0)),
    selected: true,
    lockedGroupId: undefined,
  })).filter((asset) => asset.quantity > 0) : [])
const overflow = computed(() => countMode.value
  ? remainingAssets.value.reduce((sum, asset) => sum + asset.quantity, 0)
  : layout.value.overflow + layout.value.placements.length - normalAuto.value.length)
const previewWidth = 1200
const previewHeight = computed(() => Math.round(previewWidth * paper.value.heightMm / paper.value.widthMm))
const selectedCount = computed(() => assets.value.filter((asset) => asset.selected && !asset.lockedGroupId).length)

function snapshotBoard(): StudioBoard {
  return {
    preset: preset.value, orientation: orientation.value,
    customWidth: customWidth.value, customHeight: customHeight.value, dpi: dpi.value,
    mode: mode.value, grouping: grouping.value, gapXmm: gapXmm.value, gapYmm: gapYmm.value,
    autoGap: autoGap.value, useContours: useContours.value,
    assets: assets.value.map((asset) => ({ ...asset })),
    groups: groups.value.map((group) => ({ ...group, itemIds: [...group.itemIds], placements: group.placements.map((slot) => ({ ...slot })) })),
    manualPlacements: (manualPlacements.value ?? normalAuto.value).map((slot) => ({ ...slot })),
  }
}

function selectBoard(index: number): void {
  if (index === activeBoardIndex.value || !boards.value[index] || exporting.value || uploading.value) return
  const saved = boards.value[index]!
  boards.value = boards.value.map((board, i) => i === activeBoardIndex.value ? snapshotBoard() : board)
  switchingBoard = true
  try {
    activeBoardIndex.value = index
    preset.value = saved.preset
    orientation.value = saved.orientation
    customWidth.value = saved.customWidth
    customHeight.value = saved.customHeight
    dpi.value = saved.dpi
    mode.value = saved.mode
    grouping.value = saved.grouping
    gapXmm.value = saved.gapXmm
    gapYmm.value = saved.gapYmm
    autoGap.value = saved.autoGap
    useContours.value = saved.useContours
    assets.value = saved.assets.map((asset) => ({ ...asset }))
    groups.value = saved.groups
    manualPlacements.value = saved.manualPlacements.map((slot) => ({ ...slot }))
  } finally { switchingBoard = false }
  adjusting.value = false
  selectedPlacementIndex.value = null
  drag.value = null
  clearGenerated()
  status.value = `已切换到画板 ${index + 1}，导出 PNG 仅导出当前画板。`
  void nextTick(renderPreview)
}

function createRemainingBoard(): void {
  if (!countMode.value || exporting.value || uploading.value) return
  const remaining = remainingAssets.value
  if (!remaining.length) { status.value = '当前画板的目标数量已全部排入，没有剩余图片。'; return }
  const nextLayout = arrangeAssets(remaining, [])
  if (!nextLayout.placements.length) {
    status.value = '剩余图片的尺寸超出当前纸张可用范围（四周留边 4mm），请减小尺寸或更换纸张；未创建空画板。'
    return
  }
  const currentPlacements = (manualPlacements.value ?? normalAuto.value).map((slot) => ({ ...slot }))
  const moved = new Map(remaining.map((asset) => [asset.id, asset.quantity]))
  assets.value = assets.value.map((asset) => moved.has(asset.id)
    ? { ...asset, quantity: Math.max(0, asset.quantity - moved.get(asset.id)!) } : asset)
  manualPlacements.value = currentPlacements
  const nextBoard: StudioBoard = { ...snapshotBoard(), assets: remaining, groups: [], manualPlacements: nextLayout.placements }
  boards.value = [...boards.value, nextBoard]
  selectBoard(boards.value.length - 1)
  controlsOpen.value = false
  status.value = `已新建画板 ${activeBoardIndex.value + 1}，转入 ${remaining.reduce((sum, asset) => sum + asset.quantity, 0)} 个剩余图案；原画板排版已保留。`
}

function releaseUnusedImage(url: string): void {
  if (!url || assets.value.some((asset) => asset.url === url) || boards.value.some((board, index) =>
    index !== activeBoardIndex.value && board?.assets.some((asset) => asset.url === url))) return
  URL.revokeObjectURL(url)
}

function setOrientation(value: Orientation): void {
  if (orientation.value === value) return
  orientation.value = value
  const width = customWidth.value
  customWidth.value = customHeight.value
  customHeight.value = width
}

function updateAsset(id: string, change: Partial<StudioAsset>): void {
  assets.value = assets.value.map((asset) => asset.id === id ? { ...asset, ...change } : asset)
}

function setAssetSize(id: string, edge: 'widthMm' | 'heightMm', valueCm: number): void {
  const asset = assets.value.find((item) => item.id === id)
  if (!asset || asset.lockedGroupId) return
  try {
    updateAsset(id, resizeAssetSize(asset, asset.width, asset.height, edge, valueCm * 10, asset.ratioLocked))
  } catch (error) {
    status.value = error instanceof Error ? error.message : '请输入有效尺寸。'
  }
}

function setQuantity(id: string, value: number): void {
  const asset = assets.value.find((item) => item.id === id)
  if (!asset || asset.lockedGroupId) return
  if (!Number.isFinite(value)) {
    status.value = '请输入 0～500 之间的数量。'
    return
  }
  updateAsset(id, { quantity: Math.min(500, Math.max(0, Math.floor(value))) })
  status.value = mode.value === 'custom' || mode.value === 'smart'
    ? '已更新数量，并按当前模式重新排版。'
    : '已保存数量，保持当前排版模式；切换到定制或智能填充时按数量生效。'
}

function toggleImportant(id: string): void {
  const asset = assets.value.find((item) => item.id === id)
  if (!asset || asset.lockedGroupId) return
  updateAsset(id, { important: !asset.important })
  status.value = countMode.value
    ? asset.important ? '已取消优先，按当前模式重新排版。' : '已设为优先：先排该图案的目标数量，再排列其他图案。'
    : `已${asset.important ? '取消' : '设置'}优先，保持当前排版模式；优先设置在定制或智能填充时生效。`
}

function setRotation(id: string, value: number): void {
  if (Number.isFinite(value)) updateAsset(id, { rotationDeg: ((Math.round(value) % 360) + 360) % 360 })
}

function setSelectedWidth(valueCm: number): void {
  if (!selectedPlacement.value || selectedPlacementIndex.value === null || selectedLocked.value) return
  try {
    const normalIndex = selectedPlacementIndex.value - lockedPlacements.value.length
    manualPlacements.value = resizePlacement(manualPlacements.value ?? normalAuto.value, normalIndex, valueCm * 10, paper.value)
    status.value = '已调整选中图片大小；其他副本保持不变。'
  } catch (error) {
    status.value = error instanceof Error ? error.message : '请输入有效尺寸。'
  }
}

function clearGenerated(): void {
  if (generated.value) URL.revokeObjectURL(generated.value.url)
  generated.value = null
  orderCopied.value = false
  manualCopy.value = false
}

function removeAsset(id: string): void {
  const asset = assets.value.find((item) => item.id === id)
  groups.value = groups.value.flatMap((group) => {
    if (!group.itemIds.includes(id)) return [group]
    const remainingIds = group.itemIds.filter((itemId) => itemId !== id)
    const remaining = flattenGroups([group]).filter((placement) => placement.itemId !== id)
    const updated = lockGroup(group.id, group.name, remainingIds, remaining)
    return updated ? [updated] : []
  })
  assets.value = assets.value.filter((item) => item.id !== id)
  if (asset) releaseUnusedImage(asset.url)
}

async function addFiles(files: FileList | null): Promise<void> {
  if (!files?.length) return
  uploading.value = true
  const errors: string[] = []
  const added: StudioAsset[] = []
  const importDpi = Number.isFinite(dpi.value) && dpi.value > 0 ? dpi.value : 500
  let skipped = 0
  for (const file of Array.from(files)) {
    if (!['image/png', 'image/webp', 'image/jpeg'].includes(file.type)) { skipped += 1; continue }
    try {
      const image = await loadLocalImage(file)
      added.push({ ...image, ...originalSizeMm(image.width, image.height, image.sourceDpi ?? importDpi), quantity: 1, selected: true, important: false, ratioLocked: true, rotationDeg: 0 })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${file.name} 读取失败。`)
    }
  }
  assets.value = [...assets.value, ...added]
  const oversized = added.filter((asset) => asset.widthMm > paper.value.widthMm - PAPER_MARGIN_MM * 2 || asset.heightMm > paper.value.heightMm - PAPER_MARGIN_MM * 2).length
  status.value = `已添加 ${added.length} 张素材${skipped ? `，跳过 ${skipped} 个非图片文件` : ''}，按原像素和图片 DPI 换算尺寸（无 DPI 时使用 ${importDpi} DPI）。${oversized ? `${oversized} 张原尺寸超过纸张可用范围，请调整尺寸或纸张，未自动缩小。` : ''}${errors.join('；')}`
  uploading.value = false
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  void addFiles(input.files)
  input.value = ''
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  void addFiles(event.dataTransfer?.files ?? null)
}

function applyBulk(): void {
  const longEdgeMm = Number(bulkLongEdgeCm.value) * 10
  const quantity = Number(bulkQuantity.value)
  if (!Number.isFinite(longEdgeMm) || longEdgeMm <= 0 || !Number.isFinite(quantity) || quantity < 0) {
    status.value = '统一设置需要有效的长边尺寸和数量。'
    return
  }
  const count = selectedCount.value
  assets.value = assets.value.map((asset) => asset.selected && !asset.lockedGroupId
    ? { ...asset, ...fitSizeMm(asset.width, asset.height, longEdgeMm), quantity: Math.min(500, Math.floor(quantity)) }
    : asset)
  status.value = `已统一设置 ${count} 张素材，并按当前模式重新排版。${mode.value === 'balanced' || mode.value === 'compact' ? '数量设置在定制或智能填充时生效。' : ''}`
}

function lockSelected(): void {
  const ids = assets.value.filter((asset) => asset.selected && !asset.lockedGroupId).map((asset) => asset.id)
  const group = lockGroup(`group-${Date.now()}`, `第 ${groups.value.length + 1} 组`, ids, placements.value)
  if (!group) { status.value = '请先勾选并排入至少一张图片。'; return }
  groups.value = [...groups.value, group]
  assets.value = assets.value.map((asset) => ids.includes(asset.id) ? { ...asset, selected: false, lockedGroupId: group.id } : asset)
  status.value = `已锁定 ${group.name}，保留组内位置。`
}

function unlockGroup(id: string): void {
  groups.value = groups.value.filter((group) => group.id !== id)
  assets.value = assets.value.map((asset) => asset.lockedGroupId === id ? { ...asset, lockedGroupId: undefined, selected: true } : asset)
  status.value = '已解除锁组，图片重新参与排版。'
}

function mergeAllGroups(): void {
  const merged = mergeGroups(groups.value, paper.value, gapXmm.value, gapYmm.value)
  if (!merged) { status.value = '当前纸张放不下所有锁组，请换更大的纸张或减少组数。'; return }
  groups.value = merged
  status.value = `已将 ${merged.length} 个锁组作为整体合并排版。`
}

function render(context: CanvasRenderingContext2D, width: number, height: number, guides: boolean): void {
  context.clearRect(0, 0, width, height)
  const scaleX = width / paper.value.widthMm
  const scaleY = height / paper.value.heightMm
  const imageById = new Map(assets.value.map((asset) => [asset.id, asset]))
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  for (const [index, slot] of placements.value.entries()) {
    const asset = imageById.get(slot.itemId)
    if (!asset) continue
    const x = slot.xMm * scaleX
    const y = slot.yMm * scaleY
    const w = slot.widthMm * scaleX
    const h = slot.heightMm * scaleY
    context.save()
    context.translate(x + w / 2, y + h / 2)
    context.rotate(asset.rotationDeg * Math.PI / 180)
    const originalBounds = rotatedBounds(asset.widthMm, asset.heightMm, asset.rotationDeg)
    const slotScale = slot.widthMm / originalBounds.widthMm
    const drawWidth = asset.widthMm * slotScale * scaleX
    const drawHeight = asset.heightMm * slotScale * scaleY
    if (asset.ratioLocked) drawImageContained(context, asset.image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
    else context.drawImage(asset.image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
    context.restore()
    if (guides) {
      const selected = adjusting.value && selectedPlacementIndex.value === index
      context.save()
      context.strokeStyle = selected ? '#fbbf24' : adjusting.value ? 'rgba(124,58,237,.8)' : 'rgba(99,102,241,.28)'
      context.lineWidth = selected ? 3 : adjusting.value ? 2 : 1
      if (selected) context.setLineDash([8, 5])
      context.strokeRect(x, y, w, h)
      context.restore()
    }
  }
}

function renderPreview(): void {
  const canvas = preview.value
  if (!canvas) return
  const context = canvas.getContext('2d')
  if (context) render(context, canvas.width, canvas.height, true)
}

watch([paper, gapXmm, gapYmm, autoGap, mode, grouping, useContours, assets], () => {
  if (!switchingBoard) { manualPlacements.value = null; selectedPlacementIndex.value = null }
}, { flush: 'sync' })
watch([paper, placements, assets, adjusting], () => { void nextTick(renderPreview); clearGenerated() })
watch(dpi, clearGenerated)
watch(selectedPlacementIndex, () => { void nextTick(renderPreview) })
watch(adjusting, (active) => { if (!active) selectedPlacementIndex.value = null })
onMounted(() => { void nextTick(renderPreview) })
onBeforeUnmount(() => {
  const urls = new Set([...assets.value, ...boards.value.flatMap((board, index) => index !== activeBoardIndex.value ? board?.assets ?? [] : [])].map((asset) => asset.url))
  urls.forEach((url) => { if (url) URL.revokeObjectURL(url) })
  clearGenerated()
})

function pointMm(event: PointerEvent, canvas: HTMLCanvasElement): { xMm: number; yMm: number } {
  const rect = canvas.getBoundingClientRect()
  return {
    xMm: (event.clientX - rect.left) / rect.width * paper.value.widthMm,
    yMm: (event.clientY - rect.top) / rect.height * paper.value.heightMm,
  }
}

function onPointerDown(event: PointerEvent): void {
  const canvas = preview.value
  if (!adjusting.value || !canvas) return
  const point = pointMm(event, canvas)
  let index = placements.value.length - 1
  while (index >= 0) {
    const slot = placements.value[index]
    if (point.xMm >= slot.xMm && point.xMm <= slot.xMm + slot.widthMm && point.yMm >= slot.yMm && point.yMm <= slot.yMm + slot.heightMm) break
    index -= 1
  }
  if (index < 0) { selectedPlacementIndex.value = null; return }
  selectedPlacementIndex.value = index
  const slot = placements.value[index]
  const asset = assets.value.find((item) => item.id === slot.itemId)
  const group = asset?.lockedGroupId ? groups.value.find((item) => item.id === asset.lockedGroupId) : undefined
  drag.value = {
    pointerId: event.pointerId, startXmm: point.xMm, startYmm: point.yMm,
    originXmm: group?.xMm ?? slot.xMm, originYmm: group?.yMm ?? slot.yMm,
    ...(group ? { groupId: group.id } : { normalIndex: index - lockedPlacements.value.length }),
  }
  canvas.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  const current = drag.value
  const canvas = preview.value
  if (!current || current.pointerId !== event.pointerId || !canvas) return
  const point = pointMm(event, canvas)
  const deltaX = point.xMm - current.startXmm
  const deltaY = point.yMm - current.startYmm
  if (current.groupId) {
    groups.value = groups.value.map((group) => group.id === current.groupId ? {
      ...group,
      xMm: clampPaperPosition(current.originXmm + deltaX, group.widthMm, paper.value.widthMm),
      yMm: clampPaperPosition(current.originYmm + deltaY, group.heightMm, paper.value.heightMm),
    } : group)
  } else if (current.normalIndex !== undefined) {
    const updated = [...(manualPlacements.value ?? normalAuto.value)]
    const slot = updated[current.normalIndex]
    if (!slot) return
    updated[current.normalIndex] = {
      ...slot,
      xMm: clampPaperPosition(current.originXmm + deltaX, slot.widthMm, paper.value.widthMm),
      yMm: clampPaperPosition(current.originYmm + deltaY, slot.heightMm, paper.value.heightMm),
    }
    manualPlacements.value = updated
  }
}

function onPointerEnd(event: PointerEvent): void {
  if (drag.value?.pointerId !== event.pointerId) return
  drag.value = null
  if (preview.value?.hasPointerCapture(event.pointerId)) preview.value.releasePointerCapture(event.pointerId)
}

function resetLayout(): void {
  manualPlacements.value = null
  selectedPlacementIndex.value = null
  adjusting.value = false
  status.value = mode.value === 'smart' ? '已按当前排列方式重新智能排版；优先图案先排，锁组保留原有位置。' : '已重新自动排版；锁组保留原有位置。'
}

function cycleBackground(): void {
  background.value = background.value === 'checker' ? 'white' : background.value === 'white' ? 'dark' : 'checker'
  status.value = '已切换预览背景；导出的 PNG 始终保持透明。'
}

function clearAll(): void {
  if (!window.confirm(`确定清空${boards.value.length > 1 ? '当前画板的' : '全部'}图片和锁组吗？其他画板不受影响。`)) return
  const removed = assets.value
  assets.value = []
  removed.forEach((asset) => releaseUnusedImage(asset.url))
  groups.value = []
  manualPlacements.value = null
  selectedPlacementIndex.value = null
  clearGenerated()
  status.value = '已清空当前画板，可以重新添加图片。'
}

async function generate(): Promise<void> {
  if (!placements.value.length) {
    status.value = '请先上传并选择至少一张素材。'
    return
  }
  if (paperMarginError.value) { status.value = paperMarginError.value; return }
  const size = dpiInfo.value
  if (dpiError.value) { status.value = dpiError.value; return }
  exporting.value = true
  status.value = '正在生成高清透明 PNG…'
  clearGenerated()
  let canvas: HTMLCanvasElement | null = null
  try {
    await nextTick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    let blob: Blob
    if (size.width * size.height > DIRECT_CANVAS_MAX_PIXELS) {
      exportProgress.value = 0
      blob = await tiledCanvasPng(size.width, size.height, dpi.value,
        (context, width, height) => render(context, width, height, false),
        (completed, total) => { exportProgress.value = Math.round(completed / total * 100) })
    } else {
      canvas = document.createElement('canvas')
      canvas.width = size.width
      canvas.height = size.height
      const context = canvas.getContext('2d', { alpha: true })
      if (!context) throw new Error('浏览器无法创建画布。')
      render(context, size.width, size.height, false)
      blob = await canvasPng(canvas, dpi.value)
    }
    const url = URL.createObjectURL(blob)
    const name = `转印贴-${preset.value}-画板${activeBoardIndex.value + 1}-${dpi.value}DPI-${Date.now()}.png`
    generated.value = { url, name, size: blob.size }
    status.value = `已生成 ${size.width} × ${size.height}px · ${formatBytes(blob.size)}${overflow.value ? ` · ${overflow.value} 个未排入` : ''}`
  } catch (error) {
    status.value = error instanceof Error ? error.message : '生成失败，请降低 DPI 后重试。'
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0 }
    exportProgress.value = null
    exporting.value = false
  }
}

async function copyOrDownload(): Promise<void> {
  if (!generated.value) return
  if (!orderCopied.value) {
    orderCopied.value = await copyText(XIAOHONGSHU_ORDER_TEXT)
    manualCopy.value = !orderCopied.value
    status.value = orderCopied.value ? '下单文案已复制，再点一次即可下载图片。' : '浏览器未允许复制，请长按下方文案手动复制。'
    return
  }
  downloadBlob(generated.value.url, generated.value.name)
}

function downloadOnly(): void {
  if (generated.value) downloadBlob(generated.value.url, generated.value.name)
}
</script>

<template>
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3 overflow-x-hidden p-3 lg:flex-row lg:gap-0 lg:p-0">
    <button type="button" class="min-h-11 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white lg:hidden" @click="controlsOpen = !controlsOpen">
      {{ controlsOpen ? '收起设置与素材' : '打开设置与素材' }} · {{ assets.length }} 张
    </button>
    <div v-if="controlsOpen" class="fixed inset-0 z-30 bg-slate-950/60 lg:hidden" @click="controlsOpen = false"></div>
    <aside :class="controlsOpen ? 'fixed inset-x-0 bottom-0 top-0 z-40 block' : 'hidden lg:block'" class="w-full shrink-0 overflow-y-auto border-r border-[#31415f] bg-[#17233d] pb-[env(safe-area-inset-bottom)] text-white lg:static lg:max-h-full lg:w-[466px] lg:pb-0">
      <button type="button" class="sticky top-0 z-10 flex min-h-11 w-full items-center justify-between bg-[#a78bfa] px-5 text-sm font-bold text-white lg:hidden" @click="controlsOpen = false"><span>排版设置</span><span>完成 ✓</span></button>
      <h1 class="border-b border-[#31415f] px-4 py-3 text-sm font-bold text-[#c796ff]">✦ 小星贴自动排版</h1>
      <section class="border-b border-[#31415f] px-4 py-3">
        <h2 class="mb-2 text-xs font-medium text-[#a9bbe1]">◩&nbsp; 纸张</h2>
        <div class="grid grid-cols-3 gap-1">
          <button v-for="option in paperOptions" :key="option.value" type="button" class="studio-choice min-w-0 py-1" :class="{ 'is-active': preset === option.value }" @click="preset = option.value"><span class="text-sm font-semibold">{{ option.label }}</span><small class="mt-0.5 text-[10px]">{{ orientation === 'landscape' ? option.size : option.portraitSize }}</small></button>
        </div>
        <div class="mt-1 grid grid-cols-2 gap-1">
          <button type="button" class="studio-choice studio-choice-compact" :class="{ 'is-active': orientation === 'landscape' }" :aria-pressed="orientation === 'landscape'" @click="setOrientation('landscape')">横排</button>
          <button type="button" class="studio-choice studio-choice-compact" :class="{ 'is-active': orientation === 'portrait' }" :aria-pressed="orientation === 'portrait'" @click="setOrientation('portrait')">竖排</button>
        </div>
        <div v-if="preset === 'custom'" class="mt-2 grid grid-cols-2 gap-2 text-xs text-[#a9bbe1]">
          <label>宽度 mm<input v-model.number="customWidth" type="number" min="50" max="420" class="studio-input mt-1 w-full" /></label>
          <label>高度 mm<input v-model.number="customHeight" type="number" min="50" max="420" class="studio-input mt-1 w-full" /></label>
        </div>
        <p v-if="preset === 'custom' && (customWidth !== paper.widthMm || customHeight !== paper.heightMm)" class="mt-1 text-[11px] text-[#a9bbe1]">已按{{ orientation === 'landscape' ? '横排' : '竖排' }}调整为 {{ paper.widthMm }} × {{ paper.heightMm }} mm</p>
      </section>
      <section class="border-b border-[#31415f] px-4 py-3">
        <h2 class="mb-2 text-xs font-medium text-[#a9bbe1]">DPI</h2>
        <div class="grid grid-cols-4 gap-1">
          <button v-for="value in dpiChoices" :key="value" type="button" class="studio-choice studio-choice-compact" :class="{ 'is-active': dpi === value }" :disabled="!exportSize(paper, value).allowed" :title="exportSize(paper, value).allowed ? `${value} DPI` : '超出 1 亿像素导出上限'" @click="dpi = value">{{ value }}</button>
        </div>
        <label class="mt-2 flex items-center gap-2 text-xs text-[#a9bbe1]">
          <span class="shrink-0">自定义</span>
          <input :value="Number.isFinite(dpi) ? dpi : ''" type="number" min="1" step="1" required inputmode="numeric" placeholder="输入 DPI" aria-label="自定义 DPI" :aria-invalid="!!dpiError" aria-describedby="dpi-feedback" class="studio-input w-full" @input="dpi = ($event.target as HTMLInputElement).valueAsNumber" />
          <span>DPI</span>
        </label>
        <p id="dpi-feedback" class="mt-1 text-[11px]" :class="dpiError ? 'text-amber-300' : 'text-[#a9bbe1]'" aria-live="polite">{{ dpiError || `输出：${dpiInfo.width} × ${dpiInfo.height} px` }}</p>
      </section>
      <section class="border-b border-[#31415f] px-4 py-3">
        <h2 class="mb-2 text-xs font-medium text-[#a9bbe1]">管理模式</h2>
        <div class="grid grid-cols-4 gap-1">
          <button v-for="option in ([{ value: 'balanced', label: '均衡', hint: '各图等量' }, { value: 'compact', label: '省料', hint: '大图优先' }, { value: 'custom', label: '定制', hint: '优先图按数量逐行' }, { value: 'smart', label: '智能填充', hint: '优先图案先排' }] as const)" :key="option.value" type="button" class="studio-choice min-w-0 py-1" :class="{ 'is-active': mode === option.value }" @click="mode = option.value"><span class="text-sm font-semibold">{{ option.label }}</span><small class="mt-0.5 text-[10px]">{{ option.hint }}</small></button>
        </div>
        <p v-if="mode === 'smart'" class="mt-2 text-[11px] leading-5 text-[#a9bbe1]">先尽量满足 ★ 优先图案的数量，再按所选方式排列其他图案；同级大图先排，保持尺寸和角度。{{ autoGap ? '自动间距为 5mm。' : '使用当前横纵间距。' }}</p>
        <template v-if="mode === 'smart'">
          <h3 class="mb-1 mt-2 text-xs font-medium text-[#a9bbe1]">排列方式</h3>
          <div class="grid grid-cols-3 gap-1" role="group" aria-label="排列方式">
            <button v-for="option in groupingOptions" :key="option.value" type="button" class="studio-choice min-w-0 px-1 py-2 text-xs" :class="{ 'is-active': grouping === option.value }" :aria-pressed="grouping === option.value" @click="grouping = option.value">{{ option.label }}</button>
          </div>
          <template v-if="grouping === 'free'">
            <label class="mt-2 flex items-center gap-2 text-xs text-[#c8bbff]"><input v-model="useContours" type="checkbox" />利用透明空隙（尽量多排）</label>
            <p class="mt-1 text-[11px] leading-5 text-[#a9bbe1]">{{ useContours ? '按图案轮廓保持间距，透明外框可以交错；不缩小、不自动旋转。无透明区域时按矩形排版。' : '按整张图片矩形边框保持间距。' }}数量仍为上限，放不下的会提示未排入。</p>
          </template>
          <p v-else class="mt-2 text-[11px] leading-5 text-[#a9bbe1]">每张素材视为一类，同类连续{{ grouping === 'rows' ? '横排，换素材另起一行' : '竖排，换素材另起一列' }}；按图片外框整齐对齐，不穿插透明空隙，可能比尽量填满少排。锁组保留原位，自动排版会避让。</p>
        </template>
      </section>
      <section class="border-b border-[#31415f] px-4 py-3">
        <h2 class="mb-2 text-xs font-medium text-[#a9bbe1]">间距</h2>
        <p class="mb-2 text-[11px] text-[#a9bbe1]">纸张四周至少留边 {{ PAPER_MARGIN_MM }}mm；下方设置图案之间的间距。</p>
        <div class="studio-gap-grid">
          <label class="studio-gap-row"><span>↔</span><input v-model.number="gapXmm" type="range" min="0" max="30" step="0.5" class="min-w-0 flex-1 accent-[#a78bfa]" aria-label="横向间距" :disabled="autoGap" /><input v-model.number="gapXmm" type="number" min="0" max="30" step="0.5" class="studio-input studio-gap-value" aria-label="横向间距毫米" :disabled="autoGap" /><span>mm</span></label>
          <label class="studio-gap-row"><span>↕</span><input v-model.number="gapYmm" type="range" min="0" max="30" step="0.5" class="min-w-0 flex-1 accent-[#a78bfa]" aria-label="纵向间距" :disabled="autoGap" /><input v-model.number="gapYmm" type="number" min="0" max="30" step="0.5" class="studio-input studio-gap-value" aria-label="纵向间距毫米" :disabled="autoGap" /><span>mm</span></label>
          <label class="studio-auto-gap"><input v-model="autoGap" type="checkbox" />自动</label>
        </div>
      </section>
      <section class="border-b border-[#31415f] px-4 py-3">
        <h2 class="mb-2 text-xs font-medium text-[#a9bbe1]">添加图片</h2>
        <input ref="fileInput" class="hidden" type="file" accept="image/png,image/webp,image/jpeg" multiple @change="onFileChange" />
        <input ref="folderInput" class="hidden" type="file" webkitdirectory multiple @change="onFileChange" />
        <div class="grid grid-cols-[1fr_64px] gap-2">
          <button type="button" class="flex min-h-[76px] flex-col items-center justify-center rounded-lg border-2 border-dashed border-[#3b517b] bg-[#1b2a49] text-xs text-[#a9bbe1] hover:border-[#a78bfa]" @click="fileInput?.click()" @dragover.prevent @drop="onDrop"><span class="text-xl" aria-hidden="true">▧</span><span>{{ uploading ? '正在读取…' : '点击选择或拖拽' }}</span></button>
          <button type="button" class="flex min-h-[76px] flex-col items-center justify-center rounded-lg border border-[#3b517b] bg-[#1b2a49] text-xs text-[#a9bbe1]" @click="folderInput?.click()"><span class="text-xl" aria-hidden="true">📁</span><span>文件夹</span></button>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <button type="button" class="rounded bg-[#a78bfa] px-2.5 py-1.5 font-semibold text-white disabled:opacity-40" :disabled="!selectedCount" @click="lockSelected">🔒 锁定勾选为组</button>
          <button type="button" class="rounded border border-emerald-500 px-2.5 py-1.5 text-emerald-300 disabled:opacity-40" :disabled="groups.length < 2" @click="mergeAllGroups">✦ 合并全部组</button>
          <span class="ml-auto text-[#9db1dc]">已选 {{ selectedCount }}</span>
        </div>
        <div v-if="groups.length" class="mt-2 flex flex-wrap gap-1 text-[11px]"><span v-for="group in groups" :key="group.id" class="rounded border border-[#52658c] px-2 py-1 text-[#c8bbff]">{{ group.name }} · {{ group.itemIds.length }} 图 <button type="button" class="ml-1 text-rose-300" @click="unlockGroup(group.id)">解锁</button></span></div>
      </section>
      <section class="min-h-[190px] border-b border-[#31415f] px-4 py-3">
        <h2 class="text-xs font-medium text-[#a9bbe1]">图片明细 <span class="text-[11px] text-[#8098c5]">（勾选后排版；尺寸单位 cm）</span></h2>
        <label class="mt-2 flex items-center gap-2 text-xs text-[#c8bbff]"><input v-model="bulkOpen" type="checkbox" />统一设置</label>
        <p v-if="assets.length" class="mt-1 text-[11px] text-[#8098c5]">导入按图片 DPI 换算原尺寸，无 DPI 时用导入时的画板 DPI；修改导出 DPI 不改变厘米尺寸。数量与 ☆ 优先在定制、智能填充中生效（0 表示不排入，最多 500 份），修改明细保持当前模式。</p>
        <div v-if="bulkOpen" class="mt-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-lg border border-[#40537a] p-2 text-[11px] text-[#a9bbe1]">
          <label>长边 cm<input v-model.number="bulkLongEdgeCm" type="number" min="0.1" max="42" step="0.1" class="studio-input mt-1 w-full" /></label>
          <label>数量<input v-model.number="bulkQuantity" type="number" min="0" max="500" class="studio-input mt-1 w-full" /></label>
          <button type="button" class="studio-action h-8" :disabled="!selectedCount" @click="applyBulk">应用</button>
        </div>
        <div v-for="asset in assets" :key="asset.id" class="studio-asset-row">
          <input type="checkbox" :checked="asset.selected" :disabled="!!asset.lockedGroupId" :aria-label="`选择 ${asset.name}`" @change="updateAsset(asset.id, { selected: ($event.target as HTMLInputElement).checked })" />
          <img :src="asset.url" :alt="asset.name" :title="`${asset.name} · ${asset.width}×${asset.height}px`" class="studio-asset-thumb" />
          <div class="studio-asset-meta" :title="asset.name"><span>{{ asset.width }}×{{ asset.height }}</span><small v-if="asset.lockedGroupId">已锁组</small></div>
          <button type="button" class="h-[30px] shrink-0 rounded border px-1.5 text-[11px] disabled:opacity-40" :class="asset.important ? 'border-amber-300 bg-amber-300 text-slate-950' : 'border-[#40537a] text-[#a9bbe1]'" :aria-label="`${asset.name} 优先排版`" :aria-pressed="asset.important" :disabled="!!asset.lockedGroupId" :title="asset.important ? '已设为优先，点击取消' : '先尽量满足该图案的目标数量'" @click="toggleImportant(asset.id)">{{ asset.important ? '★ 优先' : '☆ 优先' }}</button>
          <input type="number" min="0.01" step="0.01" :value="(asset.widthMm / 10).toFixed(2)" :disabled="!!asset.lockedGroupId" class="studio-input studio-size-input" :aria-label="`${asset.name} 宽度厘米`" @change="setAssetSize(asset.id, 'widthMm', Number(($event.target as HTMLInputElement).value))" />
          <button type="button" class="studio-asset-lock" :disabled="!!asset.lockedGroupId" :aria-label="asset.ratioLocked ? '解锁尺寸比例' : '锁定尺寸比例'" @click="updateAsset(asset.id, { ratioLocked: !asset.ratioLocked })">{{ asset.ratioLocked ? '🔒' : '🔓' }}</button>
          <input type="number" min="0.01" step="0.01" :value="(asset.heightMm / 10).toFixed(2)" :disabled="!!asset.lockedGroupId" class="studio-input studio-size-input studio-size-accent" :aria-label="`${asset.name} 高度厘米`" @change="setAssetSize(asset.id, 'heightMm', Number(($event.target as HTMLInputElement).value))" />
          <label class="flex shrink-0 items-center gap-1" title="定制、智能填充的排版数量上限；修改后保留当前模式">
            <span>数量</span>
            <input type="number" min="0" max="500" step="1" inputmode="numeric" :value="asset.quantity" :disabled="!!asset.lockedGroupId" class="studio-input studio-quantity-input" :aria-label="`${asset.name} 数量`" @change="setQuantity(asset.id, ($event.target as HTMLInputElement).valueAsNumber)" />
          </label>
          <label class="studio-rotation-field" :class="{ 'is-disabled': !!asset.lockedGroupId }">
            <input type="number" min="0" max="359" step="1" inputmode="numeric" :value="asset.rotationDeg" :disabled="!!asset.lockedGroupId" class="studio-rotation-input" :aria-label="`${asset.name} 旋转角度`" @change="setRotation(asset.id, Number(($event.target as HTMLInputElement).value))" />
            <span aria-hidden="true">°</span>
          </label>
          <button type="button" class="studio-remove-button" :aria-label="`移除 ${asset.name}`" @click="removeAsset(asset.id)">X</button>
          <div class="flex basis-full items-center justify-between gap-2 text-[11px] leading-5" aria-live="polite">
            <span v-if="asset.lockedGroupId" class="text-[#c8bbff]">已锁组 · 已排 {{ placementCounts.get(asset.id) ?? 0 }} 个</span>
            <template v-else-if="asset.selected">
              <span class="text-[#a9bbe1]">已排 {{ placementCounts.get(asset.id) ?? 0 }}<template v-if="mode === 'smart' || mode === 'custom'"> / {{ asset.quantity }}</template> 个</span>
              <span v-if="(mode === 'smart' || mode === 'custom') && asset.quantity > (placementCounts.get(asset.id) ?? 0)" class="text-amber-300">{{ asset.quantity - (placementCounts.get(asset.id) ?? 0) }} 个未排入</span>
            </template>
            <span v-else class="text-[#8098c5]">未参与排版</span>
          </div>
        </div>
        <p v-if="!assets.length" class="flex min-h-[100px] items-center justify-center text-center text-xs text-[#8fa5cf]">还没有添加图片</p>
      </section>
      <RouterLink class="mx-4 my-3 block rounded-lg border border-[#5e579d] bg-[#232952] p-3 text-xs leading-5 text-[#c8bbff]" to="/pricing">查看纸张价格与下单说明 →</RouterLink>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:p-5">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <div class="flex min-w-0 max-w-full gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="画板切换">
          <button v-for="(_, index) in boards" :key="index" type="button" role="tab" :aria-selected="activeBoardIndex === index" :disabled="exporting || uploading" class="shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-40" :class="activeBoardIndex === index ? 'border-violet-500 bg-violet-500 text-white' : 'border-slate-200 bg-white text-slate-600'" @click="selectBoard(index)">画板 {{ index + 1 }}</button>
        </div>
        <button v-if="countMode" type="button" class="rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 disabled:opacity-40" :disabled="!overflow || exporting || uploading" @click="createRemainingBoard">＋ 新建画板排剩余<span v-if="overflow">（{{ overflow }}）</span></button>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span class="rounded-full bg-white px-3 py-1.5">{{ preset }} · {{ paper.widthMm }} × {{ paper.heightMm }} mm</span>
        <span class="rounded-full bg-white px-3 py-1.5">已排 {{ placements.length }} 个</span>
        <span v-if="overflow" class="rounded-full bg-amber-100 px-3 py-1.5 text-amber-800">{{ overflow }} 个未排入</span>
        <span class="rounded-full bg-white px-3 py-1.5">{{ Number.isFinite(dpi) ? `${dpi} DPI` : '请填写 DPI' }}</span>
      </div>
      <div class="relative flex min-h-[45dvh] min-w-0 flex-1 items-center justify-center overflow-auto rounded-2xl bg-slate-800 p-3 sm:min-h-[480px] sm:p-6 lg:min-h-0">
        <canvas ref="preview" :width="previewWidth" :height="previewHeight" class="studio-canvas block h-auto max-h-[calc(100dvh-260px)] max-w-full shadow-2xl lg:max-h-full" :class="[`bg-${background}`, { 'is-adjusting': adjusting }]" aria-label="排版实时预览" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerEnd" @pointercancel="onPointerEnd" />
        <div v-if="adjusting && selectedPlacement" class="absolute bottom-4 left-1/2 z-10 w-[min(92%,22rem)] -translate-x-1/2 rounded-xl border border-amber-400 bg-slate-900 p-3 text-white shadow-2xl">
          <div class="flex items-center justify-between gap-2 text-xs"><strong class="truncate text-amber-300" :title="selectedAsset?.name">{{ selectedAsset?.name || '选中图片' }}</strong><button type="button" class="shrink-0 px-2 text-lg leading-none text-slate-300" aria-label="取消选中图片" @click="selectedPlacementIndex = null">×</button></div>
          <p v-if="selectedLocked" class="mt-2 text-xs text-slate-300">锁定组可整体拖动；解锁后可单独调整大小。</p>
          <div v-else class="mt-2 flex items-center justify-center gap-2 text-xs">
            <span class="shrink-0">宽度</span>
            <button type="button" class="h-9 w-9 shrink-0 rounded-md border border-slate-600 text-base" aria-label="缩小选中图片" @click="setSelectedWidth(selectedPlacement.widthMm / 10 - 0.1)">−</button>
            <input type="number" min="0.1" max="42" step="0.1" inputmode="decimal" class="h-9 min-w-0 w-20 rounded-md bg-white px-2 text-center text-sm text-slate-900" :value="(selectedPlacement.widthMm / 10).toFixed(1)" aria-label="选中图片宽度厘米" @change="setSelectedWidth(Number(($event.target as HTMLInputElement).value))" />
            <span class="shrink-0">cm</span>
            <button type="button" class="h-9 w-9 shrink-0 rounded-md border border-slate-600 text-base" aria-label="放大选中图片" @click="setSelectedWidth(selectedPlacement.widthMm / 10 + 0.1)">+</button>
          </div>
          <p class="mt-2 text-center text-[11px] text-slate-400">拖动画布上的图片调整位置</p>
        </div>
      </div>
      <div class="sticky bottom-2 z-10 space-y-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-lg lg:static">
        <p class="text-xs text-slate-600" aria-live="polite">{{ status }}</p>
        <div class="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          <button type="button" class="studio-toolbar is-primary" @click="resetLayout">✦ 排版</button>
          <button type="button" class="studio-toolbar" :class="{ 'is-primary': adjusting }" :disabled="!placements.length" @click="adjusting = !adjusting">✋ {{ adjusting ? '完成' : '调整' }}</button>
          <button type="button" class="studio-toolbar" :disabled="exporting || !placements.length || !!dpiError || !!paperMarginError" @click="generate">{{ exporting ? '生成中…' : boards.length > 1 ? '♧ 导出当前画板' : '♧ 导出 PNG' }}</button>
          <RouterLink class="studio-toolbar" to="/pricing">⭐ 升级</RouterLink>
          <button type="button" class="studio-toolbar" :disabled="!assets.length" @click="clearAll">▤ 清空</button>
          <button type="button" class="studio-toolbar" @click="cycleBackground">背景</button>
        </div>
        <p v-if="adjusting" class="text-xs text-indigo-700">点击画布上的一张图片，可拖动位置并调整单张大小；锁组整体移动。</p>
        <p v-if="dpiError" class="text-xs text-amber-700">{{ dpiError }}</p>
        <p v-if="paperMarginError" class="text-xs text-amber-700">{{ paperMarginError }}</p>
        <div v-if="generated" class="space-y-2 border-t border-slate-100 pt-2">
          <div class="flex flex-wrap items-center gap-2 text-xs"><span class="text-emerald-700">{{ generated.name }} · {{ formatBytes(generated.size) }}</span><a :href="XIAOHONGSHU_ORDER_URL" target="_blank" rel="noopener noreferrer" class="font-bold text-rose-600">去小红书下单 ↗</a></div>
          <div class="grid grid-cols-2 gap-2"><button type="button" class="min-h-10 rounded-lg bg-slate-900 px-3 text-xs font-bold text-white" @click="copyOrDownload">{{ orderCopied ? '点击下载图片' : '复制下单文案 → 下载' }}</button><button type="button" class="min-h-10 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700" @click="downloadOnly">仅下载图片</button></div>
        </div>
        <div v-if="manualCopy" class="space-y-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">浏览器未允许复制，请长按文案手动复制。<textarea :value="XIAOHONGSHU_ORDER_TEXT" readonly class="h-16 w-full rounded border border-amber-200 bg-white p-2 text-slate-700" /></div>
      </div>
    </main>
    <div v-if="exporting" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-5" role="status"><div class="rounded-2xl bg-white p-6 text-center shadow-xl"><span class="mx-auto block h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-indigo-600"></span><p class="mt-4 font-bold">正在生成 {{ dpi }} DPI 图片</p><p v-if="exportProgress !== null" class="mt-1 text-sm text-slate-500">已处理 {{ exportProgress }}%</p><p class="mt-1 text-sm text-slate-500">请勿关闭页面</p></div></div>
  </div>
</template>

<style scoped>
.studio-choice {
  display: flex;
  min-height: 50px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid #35496e;
  border-radius: 6px;
  background: #192640;
  color: #a9bbe1;
  font-size: 12px;
  line-height: 1.2;
}
.studio-choice:hover { border-color: #a78bfa; }
.studio-choice.is-active { border-color: #a78bfa; background: #a78bfa; color: #fff; }
.studio-choice:disabled { cursor: not-allowed; opacity: .38; }
.studio-choice-compact { min-height: 32px; }
.studio-input {
  height: 32px;
  min-width: 0;
  border: 1px solid #40537a;
  border-radius: 6px;
  background: #111d35;
  padding: 0 6px;
  color: #fff;
  font-size: 12px;
}
.studio-input:disabled { opacity: .4; }
.studio-gap-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.studio-gap-row { display: flex; min-width: 0; align-items: center; gap: 6px; color: #b79aff; font-size: 12px; white-space: nowrap; }
.studio-gap-row input[type='range'] { min-width: 36px; }
.studio-gap-value { width: 48px; flex: 0 0 48px; text-align: center; }
.studio-auto-gap { display: flex; align-items: center; gap: 5px; color: #d4def3; font-size: 12px; white-space: nowrap; }
.studio-action { border: 1px solid #52658c; border-radius: 5px; padding: 0 6px; color: #d6c8ff; white-space: nowrap; }
.studio-action:disabled { opacity: .4; }
.studio-asset-row { display: flex; flex-wrap: wrap; min-height: 38px; align-items: center; gap: 4px; border: 1px solid #31415f; border-radius: 6px; background: #1b2a49; padding: 3px 6px; color: #a9bbe1; font-size: 11px; }
.studio-asset-row + .studio-asset-row { margin-top: 5px; }
.studio-asset-row > input[type='checkbox'] { flex: 0 0 16px; }
.studio-asset-thumb { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 4px; background: rgb(255 255 255 / 10%); object-fit: contain; }
.studio-asset-meta { display: flex; min-width: 48px; flex: 0 1 56px; flex-direction: column; overflow: hidden; font-size: 10px; line-height: 1.15; white-space: nowrap; }
.studio-asset-meta span { color: #a9bbe1; }
.studio-asset-meta small { margin-top: 2px; color: #8fa5cf; font-size: 9px; }
.studio-size-input { width: 56px; height: 30px; flex: 0 0 56px; padding: 0 3px; text-align: center; }
.studio-size-accent { border-color: #40537a; color: #f7c931; }
.studio-asset-lock, .studio-remove-button { display: inline-flex; height: 30px; flex: 0 0 auto; align-items: center; justify-content: center; border: 1px solid #40537a; border-radius: 5px; color: #d6c8ff; }
.studio-asset-lock { width: 26px; font-size: 13px; }
.studio-quantity-input { width: 42px; height: 30px; flex: 0 0 42px; padding: 0 2px; text-align: center; }
.studio-rotation-field { display: flex; height: 30px; width: 56px; flex: 0 0 56px; align-items: center; border: 1px solid #a78bfa; border-radius: 5px; background: #a78bfa; color: #fff; }
.studio-rotation-field:focus-within { outline: 2px solid #d6c8ff; outline-offset: 1px; }
.studio-rotation-input { width: 100%; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; padding: 0 1px 0 4px; color: inherit; font-size: 11px; font-weight: 700; text-align: right; -moz-appearance: textfield; }
.studio-rotation-input::-webkit-inner-spin-button, .studio-rotation-input::-webkit-outer-spin-button { margin: 0; -webkit-appearance: none; }
.studio-rotation-field span { padding-right: 5px; font-size: 11px; font-weight: 700; }
.studio-rotation-field.is-disabled { opacity: .45; }
.studio-remove-button { width: 20px; border-color: transparent; color: #7f91b7; font-size: 11px; }
.studio-asset-lock:disabled { opacity: .45; }
.studio-toolbar { display: flex; min-height: 38px; align-items: center; justify-content: center; border: 1px solid #d7dcf0; border-radius: 8px; padding: 4px; color: #334155; font-size: 12px; font-weight: 600; text-align: center; }
.studio-toolbar.is-primary { border-color: #a78bfa; background: #a78bfa; color: #fff; }
.studio-toolbar:disabled { opacity: .4; }
.studio-canvas.bg-checker { background-color: white; background-image: linear-gradient(45deg,#ddd 25%,transparent 25%),linear-gradient(-45deg,#ddd 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ddd 75%),linear-gradient(-45deg,transparent 75%,#ddd 75%); background-size: 20px 20px; background-position: 0 0,0 10px,10px -10px,-10px 0; }
.studio-canvas.bg-white { background: #fff; }
.studio-canvas.bg-dark { background: #1e293b; }
.studio-canvas.is-adjusting { cursor: grab; touch-action: none; }
.studio-canvas.is-adjusting:active { cursor: grabbing; }
@media (max-width: 520px) {
  .studio-gap-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 5px; }
  .studio-gap-row { gap: 3px; font-size: 11px; }
  .studio-gap-value { width: 42px; flex-basis: 42px; }
  .studio-asset-row { gap: 3px; padding-inline: 4px; }
  .studio-asset-meta { display: none; }
  .studio-size-input { width: 48px; flex-basis: 48px; }
  .studio-asset-lock { width: 23px; }
  .studio-rotation-field { width: 52px; flex-basis: 52px; }
}
</style>
