<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { fitSizeMm, originalSizeMm, resizeAssetSize, rotatedBounds } from '../domain/studio/assetGeometry'
import { DIRECT_CANVAS_MAX_PIXELS, exportSize } from '../domain/studio/exportSize'
import { flattenGroups, lockGroup, mergeGroups, type LockedGroup } from '../domain/studio/groups'
import { imageSizePresets } from '../domain/studio/imageSizeConversion'
import { arrangeItems, customItemGap, orientedPaperSize, paperSize, type LayoutMode, type Orientation, type PaperPreset, type PaperSize, type Placement, type SmartGrouping } from '../domain/studio/layout'
import { distributePlacements, resizePlacement, selectPlacementsInBox } from '../domain/studio/placementAdjustments'
import { clampPaperPosition, PAPER_MARGIN_MM } from '../domain/studio/paperBounds'
import { findSpacingConflict, MIN_PATTERN_GAP_MM, normalizePatternGap, type PlacementContour } from '../domain/studio/patternSpacing'
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
  ratioLocked: boolean
  rotationDeg: number
  lockedGroupId?: string
  gapXmm?: number
  gapYmm?: number
  startNewRow?: boolean
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

interface AssetDragState {
  id: string
  pointerId: number
  startX: number
  startY: number
  clientX: number
  clientY: number
  active: boolean
  targetIndex: number | null
}

interface BoxSelection {
  pointerId: number
  startXmm: number
  startYmm: number
  xMm: number
  yMm: number
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
  placedAssets: StudioAsset[]
  layoutPending: boolean
  layoutOverflow: number
}

interface BoardScene {
  paper: PaperSize
  assets: StudioAsset[]
  placements: Placement[]
}

const preset = ref<PaperPreset>('A4')
const orientation = ref<Orientation>('landscape')
const customWidth = ref(293)
const customHeight = ref(210)
const dpi = ref(300)
const mode = ref<LayoutMode>('custom')
const grouping = ref<SmartGrouping>('free')
const groupingOptions = [{ value: 'free', label: '尽量填满' }, { value: 'rows', label: '同类按行' }, { value: 'columns', label: '同类按列' }] as const
const gapXmm = ref(5)
const gapYmm = ref(MIN_PATTERN_GAP_MM)
const autoGap = ref(false)
const useContours = ref(true)
const assets = shallowRef<StudioAsset[]>([])
const groups = shallowRef<LockedGroup[]>([])
// Draft settings never drive the canvas directly. Only an explicit layout commits them.
const manualPlacements = shallowRef<Placement[]>([])
const placedAssets = shallowRef<StudioAsset[]>([])
const layoutPending = ref(false)
const layoutOverflow = ref(0)
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
const batchExportLabel = ref('')
const adjusting = ref(false)
const adjustTool = ref<'move' | 'select'>('move')
const boxSelection = shallowRef<BoxSelection | null>(null)
const selectedPlacementIndices = ref<number[]>([])
const background = ref<'checker' | 'white' | 'dark'>('checker')
const drag = ref<DragState | null>(null)
const assetDrag = ref<AssetDragState | null>(null)
const assetRows = new Map<string, HTMLElement>()
const sidebar = ref<HTMLElement | null>(null)
let assetDragHandle: HTMLElement | null = null
let assetScrollFrame: number | null = null
const selectedPlacementIndex = ref<number | null>(null)
const status = ref('添加图片并设置尺寸后，点击「排版」生成排版；后续修改不会自动重排。')
const generated = ref<{ url: string; name: string; size: number } | null>(null)
const orderCopied = ref(false)
const manualCopy = ref(false)
// The active board lives in the editor refs; inactive boards hold independent snapshots.
const boards = shallowRef<(StudioBoard | null)[]>([null])
const activeBoardIndex = ref(0)
const overviewOpen = ref(false)
const overviewCanvases = new Map<number, HTMLCanvasElement>()
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
    gapXmm: normalizePatternGap(gapXmm.value),
    gapYmm: normalizePatternGap(gapYmm.value),
    autoGap: autoGap.value,
    mode: mode.value,
    grouping: grouping.value,
    reserved,
    items: source.map((asset, index) => ({
      id: asset.id,
      ...rotatedBounds(asset.widthMm, asset.heightMm, asset.rotationDeg),
      quantity: asset.quantity,
      selected: asset.selected && !asset.lockedGroupId,
      priority: source.length - index,
      gapXmm: asset.gapXmm === undefined ? undefined : normalizePatternGap(asset.gapXmm),
      gapYmm: asset.gapYmm === undefined ? undefined : normalizePatternGap(asset.gapYmm),
      startNewRow: asset.startNewRow,
      contour: mode.value === 'smart' && grouping.value === 'free' && useContours.value && asset.selected && !asset.lockedGroupId
        ? imageContour(asset.image, asset.widthMm, asset.heightMm, asset.rotationDeg, asset.ratioLocked) : undefined,
    })),
  })
}
function overlaps(a: Placement, b: Placement): boolean {
  const first = assets.value.find(asset => asset.id === a.itemId)
  const second = assets.value.find(asset => asset.id === b.itemId)
  const gapX = mode.value === 'custom'
    ? Math.max(MIN_PATTERN_GAP_MM, customItemGap(first, 'x', autoGap.value ? 5 : gapXmm.value), customItemGap(second, 'x', autoGap.value ? 5 : gapXmm.value)) : normalizePatternGap(autoGap.value ? 5 : gapXmm.value)
  const gapY = mode.value === 'custom'
    ? Math.max(MIN_PATTERN_GAP_MM, customItemGap(first, 'y', autoGap.value ? 5 : gapYmm.value), customItemGap(second, 'y', autoGap.value ? 5 : gapYmm.value)) : normalizePatternGap(autoGap.value ? 5 : gapYmm.value)
  return a.xMm < b.xMm + b.widthMm + gapX && a.xMm + a.widthMm + gapX > b.xMm &&
    a.yMm < b.yMm + b.heightMm + gapY && a.yMm + a.heightMm + gapY > b.yMm
}
function calculateLayout(source: StudioAsset[], reserved: Placement[]) {
  const result = arrangeAssets(source, reserved)
  const normal = mode.value === 'smart' || mode.value === 'neat' ? result.placements : result.placements.filter(slot =>
    reserved.every(locked => !overlaps(slot, locked)))
  return { placements: normal, overflow: result.overflow + result.placements.length - normal.length }
}
const placements = computed(() => [...lockedPlacements.value, ...manualPlacements.value])
function spacingContours(source: StudioAsset[]): PlacementContour {
  const byId = new Map(source.map(asset => [asset.id, asset]))
  return slot => {
    const asset = byId.get(slot.itemId)
    if (!asset) return undefined
    const bounds = rotatedBounds(asset.widthMm, asset.heightMm, asset.rotationDeg)
    const scale = slot.widthMm / bounds.widthMm
    return imageContour(asset.image, asset.widthMm * scale, asset.heightMm * scale, asset.rotationDeg, asset.ratioLocked)
  }
}
const placedContours = computed(() => spacingContours(placedAssets.value))
const patternSpacingError = computed(() => findSpacingConflict(placements.value, placedContours.value)
  ? '部分图案间距不足 4mm，请调整位置、缩小图片或点击「排版」后再导出。' : '')

function allowPlacementChange(candidate: Placement[], changed?: ReadonlySet<number>): boolean {
  if (!findSpacingConflict(candidate, placedContours.value, changed)) return true
  status.value = '图案之间至少需要 4mm 间距，本次调整未应用；请留出更多空间。'
  return false
}
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
const countMode = computed(() => mode.value === 'custom' || mode.value === 'smart' || mode.value === 'neat')
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
  : layoutOverflow.value)
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
    manualPlacements: manualPlacements.value.map((slot) => ({ ...slot })),
    placedAssets: placedAssets.value.map(asset => ({ ...asset })),
    layoutPending: layoutPending.value, layoutOverflow: layoutOverflow.value,
  }
}

const overviewBoards = computed(() => boards.value.flatMap((saved, index) => {
  const board = index === activeBoardIndex.value ? snapshotBoard() : saved
  if (!board) return []
  return [{
    index,
    preset: board.preset,
    dpi: board.dpi,
    paper: orientedPaperSize(board.preset, board.orientation, board.customWidth, board.customHeight),
    assets: board.placedAssets,
    placements: [...flattenGroups(board.groups), ...board.manualPlacements],
  }]
}))

function renderOverviewBoard(index: number): void {
  const canvas = overviewCanvases.get(index)
  const scene = overviewBoards.value.find((board) => board.index === index)
  if (!canvas || !scene) return
  const scale = 400 / Math.max(scene.paper.widthMm, scene.paper.heightMm)
  canvas.width = Math.max(1, Math.round(scene.paper.widthMm * scale))
  canvas.height = Math.max(1, Math.round(scene.paper.heightMm * scale))
  const context = canvas.getContext('2d')
  if (context) render(context, canvas.width, canvas.height, false, scene)
}

function setOverviewCanvas(index: number, canvas: HTMLCanvasElement | null): void {
  if (!canvas) { overviewCanvases.delete(index); return }
  overviewCanvases.set(index, canvas)
  renderOverviewBoard(index)
}

function editOverviewBoard(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= boards.value.length || exporting.value || uploading.value) return
  selectBoard(index)
  overviewOpen.value = false
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
    gapXmm.value = normalizePatternGap(saved.gapXmm)
    gapYmm.value = normalizePatternGap(saved.gapYmm)
    autoGap.value = saved.autoGap
    useContours.value = saved.useContours
    assets.value = saved.assets.map((asset) => ({ ...asset,
      gapXmm: asset.gapXmm === undefined ? undefined : normalizePatternGap(asset.gapXmm),
      gapYmm: asset.gapYmm === undefined ? undefined : normalizePatternGap(asset.gapYmm) }))
    groups.value = saved.groups
    manualPlacements.value = saved.manualPlacements.map((slot) => ({ ...slot }))
    placedAssets.value = saved.placedAssets.map(asset => ({ ...asset }))
    layoutPending.value = saved.layoutPending
    layoutOverflow.value = saved.layoutOverflow
  } finally { switchingBoard = false }
  adjusting.value = false
  overviewOpen.value = false
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
  const nextLayout = calculateLayout(remaining, [])
  if (!nextLayout.placements.length) {
    status.value = '剩余图片的尺寸超出当前纸张可用范围（四周留边 4mm），请减小尺寸或更换纸张；未创建空画板。'
    return
  }
  const pending = layoutPending.value
  const moved = new Map(remaining.map((asset) => [asset.id, asset.quantity]))
  assets.value = assets.value.map((asset) => moved.has(asset.id)
    ? { ...asset, quantity: Math.max(0, asset.quantity - moved.get(asset.id)!) } : asset)
  layoutPending.value = pending
  const nextBoard: StudioBoard = { ...snapshotBoard(), assets: remaining, groups: [], manualPlacements: nextLayout.placements,
    placedAssets: remaining.map(asset => ({ ...asset })), layoutPending: false, layoutOverflow: nextLayout.overflow }
  boards.value = [...boards.value, nextBoard]
  selectBoard(boards.value.length - 1)
  controlsOpen.value = false
  status.value = `已新建画板 ${activeBoardIndex.value + 1}，转入 ${remaining.reduce((sum, asset) => sum + asset.quantity, 0)} 个剩余图案；原画板排版已保留。`
}

function removeBoard(index: number): void {
  if (!Number.isInteger(index) || index <= 0 || index >= boards.value.length || exporting.value || uploading.value) return
  if (!window.confirm(`确定删除画板 ${index + 1} 及其中的图片和排版吗？删除后无法恢复，图案数量不会转回其他画板。`)) return
  const removedAssets = index === activeBoardIndex.value ? assets.value : boards.value[index]?.assets ?? []
  const wasOverviewOpen = overviewOpen.value
  // Switch before removing an active board so its neighbor is restored through
  // the existing snapshot path, without rearranging any surviving placements.
  if (index === activeBoardIndex.value) selectBoard(index - 1)
  if (activeBoardIndex.value > index) activeBoardIndex.value -= 1
  boards.value = boards.value.filter((_, boardIndex) => boardIndex !== index)
  overviewCanvases.delete(boards.value.length)
  overviewOpen.value = wasOverviewOpen
  clearGenerated()
  new Set(removedAssets.map(asset => asset.url)).forEach(releaseUnusedImage)
  status.value = `已删除画板 ${index + 1}，总览已同步移除；其他画板的图片、数量和排版保持不变。`
  void nextTick(renderPreview)
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

function onGapChange(axis: 'x' | 'y', event: Event): void {
  const input = event.target as HTMLInputElement
  const gap = axis === 'x' ? gapXmm : gapYmm
  const value = input.valueAsNumber
  gap.value = normalizePatternGap(Number.isFinite(value) ? value : gap.value)
  // Restore the displayed input too when normalization leaves the ref unchanged.
  input.value = String(gap.value)
  status.value = !Number.isFinite(value) || value !== gap.value
    ? `间距仅支持 4～30 的整数毫米，当前为 ${gap.value}mm。`
    : '已保存间距，点击「排版」后应用。'
}

function updateAsset(id: string, change: Partial<StudioAsset>): void {
  assets.value = assets.value.map((asset) => asset.id === id ? { ...asset, ...change } : asset)
}

function setAssetGap(id: string, axis: 'x' | 'y', event: Event): void {
  const asset = assets.value.find(item => item.id === id)
  if (!asset || asset.lockedGroupId || mode.value !== 'custom' || exporting.value || uploading.value) return
  const input = event.target as HTMLInputElement
  const key = axis === 'x' ? 'gapXmm' : 'gapYmm'
  const value = input.value.trim() === '' ? undefined : input.valueAsNumber
  const normalized = value === undefined ? undefined : normalizePatternGap(Number.isFinite(value) ? value : asset[key] ?? MIN_PATTERN_GAP_MM)
  input.value = normalized === undefined ? '' : String(normalized)
  updateAsset(id, { [key]: normalized })
  status.value = '已保存定制间距，点击「排版」后应用；留空跟随全局，相邻图案取较大值。'
}

function setAssetNewRow(id: string, value: boolean): void {
  const asset = assets.value.find(item => item.id === id)
  if (!asset || asset.lockedGroupId || mode.value !== 'custom' || exporting.value || uploading.value) return
  updateAsset(id, { startNewRow: value })
  status.value = value ? '已设置另起一行，点击「排版」后应用。' : '已取消另起一行，点击「排版」后应用。'
}

function setAssetSize(id: string, edge: 'widthMm' | 'heightMm', valueCm: number): void {
  const asset = assets.value.find((item) => item.id === id)
  if (!asset || asset.lockedGroupId) return
  try {
    updateAsset(id, resizeAssetSize(asset, asset.width, asset.height, edge, valueCm * 10, asset.ratioLocked))
    status.value = '已保存图片尺寸，点击「排版」后应用；当前画板保持不变。'
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
  status.value = countMode.value
    ? '已保存数量，点击「排版」后应用。'
    : '已保存数量，保持当前排版模式；切换到定制、智能填充或整齐排版时按数量生效。'
}

function reorderAsset(id: string, target: number): void {
  if (exporting.value || uploading.value) return
  const index = assets.value.findIndex((asset) => asset.id === id)
  if (index < 0 || !Number.isInteger(target) || target < 0 || target >= assets.value.length || index === target) return
  const reordered = [...assets.value]
  const [moved] = reordered.splice(index, 1)
  reordered.splice(target, 0, moved!)
  assets.value = reordered
  status.value = '已保存图片顺序，点击「排版」后按新顺序排版；当前画板保持不变。'
}

const assetDropIndicator = computed(() => {
  const current = assetDrag.value
  if (!current?.active || current.targetIndex === null) return null
  const others = assets.value.filter(asset => asset.id !== current.id)
  const target = others[current.targetIndex]
  const last = others[others.length - 1]
  return target ? { id: target.id, side: 'before' } : last ? { id: last.id, side: 'after' } : null
})

function setAssetRow(id: string, element: HTMLElement | null): void {
  if (element) assetRows.set(id, element)
  else assetRows.delete(id)
}

function cancelAssetDrag(): void {
  const current = assetDrag.value
  const handle = assetDragHandle
  assetDrag.value = null
  assetDragHandle = null
  if (assetScrollFrame !== null) { cancelAnimationFrame(assetScrollFrame); assetScrollFrame = null }
  if (current && handle?.hasPointerCapture(current.pointerId)) handle.releasePointerCapture(current.pointerId)
}

function startAssetDrag(id: string, event: PointerEvent): void {
  if (exporting.value || uploading.value || assets.value.length < 2 || assetDrag.value || event.button !== 0 || event.isPrimary === false || !assets.value.some(asset => asset.id === id)) return
  event.preventDefault()
  assetDragHandle = event.currentTarget as HTMLElement
  assetDragHandle.focus({ preventScroll: true })
  assetDragHandle.setPointerCapture(event.pointerId)
  assetDrag.value = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    clientX: event.clientX, clientY: event.clientY, active: false, targetIndex: null }
}

function updateAssetDropIndex(): void {
  const current = assetDrag.value
  if (!current?.active) return
  const rows = assets.value.flatMap(asset => {
    const element = assetRows.get(asset.id)
    return element ? [{ id: asset.id, rect: element.getBoundingClientRect() }] : []
  })
  const top = rows[0]?.rect.top
  const bottom = rows[rows.length - 1]?.rect.bottom
  const left = rows[0]?.rect.left
  const right = rows[0]?.rect.right
  if (top === undefined || bottom === undefined || left === undefined || right === undefined ||
    current.clientY < top - 48 || current.clientY > bottom + 48 || current.clientX < left - 32 || current.clientX > right + 32) {
    current.targetIndex = null
    return
  }
  const others = rows.filter(row => row.id !== current.id)
  const before = others.findIndex(row => current.clientY < row.rect.top + row.rect.height / 2)
  current.targetIndex = before < 0 ? others.length : before
}

function scrollAssetDrag(): void {
  assetScrollFrame = null
  const current = assetDrag.value
  const panel = sidebar.value
  if (!current?.active || !panel) return
  const bounds = panel.getBoundingClientRect()
  if (current.clientX < bounds.left || current.clientX > bounds.right) return
  const step = current.clientY < bounds.top + 48 ? -12 : current.clientY > bounds.bottom - 48 ? 12 : 0
  if (!step) return
  const previous = panel.scrollTop
  panel.scrollTop += step
  updateAssetDropIndex()
  if (panel.scrollTop !== previous) assetScrollFrame = requestAnimationFrame(scrollAssetDrag)
}

function moveAssetDrag(event: PointerEvent): void {
  const current = assetDrag.value
  if (!current || current.pointerId !== event.pointerId) return
  current.clientX = event.clientX
  current.clientY = event.clientY
  if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return
  current.active = true
  event.preventDefault()
  updateAssetDropIndex()
  if (sidebar.value && assetScrollFrame === null) assetScrollFrame = requestAnimationFrame(scrollAssetDrag)
}

function finishAssetDrag(event: PointerEvent): void {
  if (assetDrag.value?.pointerId !== event.pointerId) return
  moveAssetDrag(event)
  const current = assetDrag.value!
  const target = current.active ? current.targetIndex : null
  cancelAssetDrag()
  if (target !== null) reorderAsset(current.id, target)
}

function onAssetOrderKey(id: string, event: KeyboardEvent): void {
  if (event.key === 'Escape') { cancelAssetDrag(); return }
  const index = assets.value.findIndex(asset => asset.id === id)
  const target = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1
    : event.key === 'Home' ? 0 : event.key === 'End' ? assets.value.length - 1 : null
  if (target === null || assetDrag.value) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement | null
  reorderAsset(id, target)
  void nextTick(() => { if (handle?.isConnected) handle.focus({ preventScroll: true }) })
}

function setRotation(id: string, value: number): void {
  if (Number.isFinite(value)) updateAsset(id, { rotationDeg: ((Math.round(value) % 360) + 360) % 360 })
}

function setSelectedWidth(valueCm: number): void {
  if (!selectedPlacement.value || selectedPlacementIndex.value === null || selectedLocked.value) return
  try {
    const normalIndex = selectedPlacementIndex.value - lockedPlacements.value.length
    const updated = resizePlacement(manualPlacements.value, normalIndex, valueCm * 10, paper.value)
    if (!allowPlacementChange([...lockedPlacements.value, ...updated], new Set([selectedPlacementIndex.value]))) return
    manualPlacements.value = updated
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
  if (exporting.value || uploading.value) return
  const asset = assets.value.find((item) => item.id === id)
  if (!asset) return
  groups.value = groups.value.flatMap((group) => {
    if (!group.itemIds.includes(id)) return [group]
    const remainingIds = group.itemIds.filter((itemId) => itemId !== id)
    const remaining = flattenGroups([group]).filter((placement) => placement.itemId !== id)
    const updated = lockGroup(group.id, group.name, remainingIds, remaining)
    return updated ? [updated] : []
  })
  assets.value = assets.value.filter((item) => item.id !== id)
  manualPlacements.value = manualPlacements.value.filter(slot => slot.itemId !== id)
  placedAssets.value = placedAssets.value.filter(item => item.id !== id)
  if (asset) releaseUnusedImage(asset.url)
  status.value = `已从当前画板删除 ${asset.name}，其他画板不受影响。`
}

async function addFiles(files: FileList | null): Promise<void> {
  if (!files?.length) return
  uploading.value = true
  const errors: string[] = []
  const added: StudioAsset[] = []
  const importDpi = Number.isFinite(dpi.value) && dpi.value > 0 ? dpi.value : 300
  let skipped = 0
  for (const file of Array.from(files)) {
    if (!['image/png', 'image/webp', 'image/jpeg'].includes(file.type)) { skipped += 1; continue }
    try {
      const image = await loadLocalImage(file)
      added.push({ ...image, ...originalSizeMm(image.width, image.height, image.sourceDpi ?? importDpi), quantity: 1, selected: true, ratioLocked: true, rotationDeg: 0 })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${file.name} 读取失败。`)
    }
  }
  assets.value = [...assets.value, ...added]
  const oversized = added.filter((asset) => asset.widthMm > paper.value.widthMm - PAPER_MARGIN_MM * 2 || asset.heightMm > paper.value.heightMm - PAPER_MARGIN_MM * 2).length
  status.value = `已添加 ${added.length} 张素材${skipped ? `，跳过 ${skipped} 个非图片文件` : ''}，点击「排版」后排入，原排版保持不变。按原像素和图片 DPI 换算尺寸（无 DPI 时使用 ${importDpi} DPI）。${oversized ? `${oversized} 张原尺寸超过纸张可用范围，请调整尺寸或纸张，未自动缩小。` : ''}${errors.join('；')}`
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
  status.value = `已保存 ${count} 张素材的统一设置，点击「排版」后应用。${mode.value === 'balanced' || mode.value === 'compact' ? '数量设置在定制、智能填充或整齐排版时生效。' : ''}`
}

function lockSelected(): void {
  const placedIds = new Set(manualPlacements.value.map(slot => slot.itemId))
  const ids = assets.value.filter((asset) => asset.selected && !asset.lockedGroupId && placedIds.has(asset.id)).map((asset) => asset.id)
  const group = lockGroup(`group-${Date.now()}`, `第 ${groups.value.length + 1} 组`, ids, placements.value)
  if (!group) { status.value = '请先勾选并排入至少一张图片。'; return }
  const pending = layoutPending.value
  manualPlacements.value = manualPlacements.value.filter(slot => !ids.includes(slot.itemId))
  groups.value = [...groups.value, group]
  assets.value = assets.value.map((asset) => ids.includes(asset.id) ? { ...asset, selected: false, lockedGroupId: group.id } : asset)
  layoutPending.value = pending
  clearCanvasSelection()
  status.value = `已锁定 ${group.name}，保留组内位置。`
}

function unlockGroup(id: string): void {
  const group = groups.value.find(group => group.id === id)
  if (!group) return
  const pending = layoutPending.value
  manualPlacements.value = [...manualPlacements.value, ...flattenGroups([group])]
  groups.value = groups.value.filter((group) => group.id !== id)
  assets.value = assets.value.map((asset) => asset.lockedGroupId === id ? { ...asset, lockedGroupId: undefined, selected: true } : asset)
  layoutPending.value = pending
  clearCanvasSelection()
  status.value = '已解除锁组并保留当前位置，可单独调整；点击「排版」后重新参与排列。'
}

function mergeAllGroups(): void {
  const merged = mergeGroups(groups.value, paper.value, normalizePatternGap(gapXmm.value), normalizePatternGap(gapYmm.value))
  if (!merged) { status.value = '当前纸张放不下所有锁组，请换更大的纸张或减少组数。'; return }
  if (!allowPlacementChange([...flattenGroups(merged), ...manualPlacements.value])) return
  groups.value = merged
  status.value = `已将 ${merged.length} 个锁组作为整体合并排版。`
}

function render(context: CanvasRenderingContext2D, width: number, height: number, guides: boolean,
  scene: BoardScene = { paper: paper.value, assets: placedAssets.value, placements: placements.value }): void {
  context.clearRect(0, 0, width, height)
  const scaleX = width / scene.paper.widthMm
  const scaleY = height / scene.paper.heightMm
  const imageById = new Map(scene.assets.map((asset) => [asset.id, asset]))
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  for (const [index, slot] of scene.placements.entries()) {
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
      const selected = adjusting.value && (selectedPlacementIndex.value === index || selectedPlacementIndices.value.includes(index))
      context.save()
      context.strokeStyle = selected ? '#fbbf24' : adjusting.value ? 'rgba(124,58,237,.8)' : 'rgba(99,102,241,.28)'
      context.lineWidth = selected ? 3 : adjusting.value ? 2 : 1
      if (selected) context.setLineDash([8, 5])
      context.strokeRect(x, y, w, h)
      context.restore()
    }
  }
  const box = boxSelection.value
  if (guides && box) {
    context.save()
    context.fillStyle = 'rgba(167,139,250,.18)'
    context.strokeStyle = '#a78bfa'
    context.lineWidth = 2
    context.setLineDash([6, 4])
    const x = Math.min(box.startXmm, box.xMm) * scaleX
    const y = Math.min(box.startYmm, box.yMm) * scaleY
    const w = Math.abs(box.xMm - box.startXmm) * scaleX
    const h = Math.abs(box.yMm - box.startYmm) * scaleY
    context.fillRect(x, y, w, h)
    context.strokeRect(x, y, w, h)
    context.restore()
  }
}

function renderPreview(): void {
  const canvas = preview.value
  if (!canvas) return
  const context = canvas.getContext('2d')
  if (context) render(context, canvas.width, canvas.height, true)
}

watch([paper, gapXmm, gapYmm, autoGap, mode, grouping, useContours, assets], () => {
  if (!switchingBoard) {
    layoutPending.value = true
    clearCanvasSelection()
  }
}, { flush: 'sync' })
watch([assets, exporting, uploading, controlsOpen], cancelAssetDrag, { flush: 'sync' })
watch([paper, placements, placedAssets, adjusting], () => { void nextTick(renderPreview); clearGenerated() })
watch(dpi, clearGenerated)
watch([selectedPlacementIndex, selectedPlacementIndices, boxSelection], () => { void nextTick(renderPreview) })
watch(adjusting, (active) => { if (!active) { clearCanvasSelection(); adjustTool.value = 'move' } }, { flush: 'sync' })
watch(adjustTool, clearCanvasSelection, { flush: 'sync' })
watch(() => overviewOpen.value ? overviewBoards.value : null, () => {
  void nextTick(() => {
    if (overviewOpen.value) overviewCanvases.forEach((_, index) => renderOverviewBoard(index))
  })
})
onMounted(() => { void nextTick(renderPreview) })
onBeforeUnmount(() => {
  cancelAssetDrag()
  assetRows.clear()
  overviewCanvases.clear()
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

function clearCanvasSelection(): void {
  const pointerId = boxSelection.value?.pointerId ?? drag.value?.pointerId
  boxSelection.value = null
  drag.value = null
  selectedPlacementIndex.value = null
  selectedPlacementIndices.value = []
  if (pointerId !== undefined && preview.value?.hasPointerCapture(pointerId)) preview.value.releasePointerCapture(pointerId)
}

function distributeSelected(axis: 'x' | 'y'): void {
  if (exporting.value || uploading.value) return
  try {
    const result = distributePlacements(placements.value, selectedPlacementIndices.value, axis, paper.value, lockedPlacements.value.length, placedContours.value)
    manualPlacements.value = result.slice(lockedPlacements.value.length)
    status.value = `已将 ${selectedPlacementIndices.value.length} 张图片${axis === 'x' ? '横向' : '纵向'}等间距排列，图片尺寸和其他图案保持不变。`
  } catch (error) {
    status.value = error instanceof Error ? error.message : '等间距排列失败，请重新框选。'
  }
}

function onPointerDown(event: PointerEvent): void {
  const canvas = preview.value
  if (!adjusting.value || !canvas || exporting.value || uploading.value || event.button !== 0 || event.isPrimary === false || drag.value || boxSelection.value) return
  const point = pointMm(event, canvas)
  if (adjustTool.value === 'select') {
    selectedPlacementIndex.value = null
    selectedPlacementIndices.value = []
    boxSelection.value = { pointerId: event.pointerId, startXmm: point.xMm, startYmm: point.yMm, ...point }
    canvas.setPointerCapture(event.pointerId)
    event.preventDefault()
    return
  }
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
  const canvas = preview.value
  const box = boxSelection.value
  if (box && box.pointerId === event.pointerId && canvas) {
    boxSelection.value = { ...box, ...pointMm(event, canvas) }
    event.preventDefault()
    return
  }
  const current = drag.value
  if (!current || current.pointerId !== event.pointerId || !canvas) return
  const point = pointMm(event, canvas)
  const deltaX = point.xMm - current.startXmm
  const deltaY = point.yMm - current.startYmm
  if (current.groupId) {
    const updated = groups.value.map((group) => group.id === current.groupId ? {
      ...group,
      xMm: clampPaperPosition(current.originXmm + deltaX, group.widthMm, paper.value.widthMm),
      yMm: clampPaperPosition(current.originYmm + deltaY, group.heightMm, paper.value.heightMm),
    } : group)
    const changed = new Set<number>()
    let offset = 0
    for (const group of groups.value) {
      if (group.id === current.groupId) group.placements.forEach((_, index) => changed.add(offset + index))
      offset += group.placements.length
    }
    if (!allowPlacementChange([...flattenGroups(updated), ...manualPlacements.value], changed)) return
    groups.value = updated
  } else if (current.normalIndex !== undefined) {
    const updated = [...manualPlacements.value]
    const slot = updated[current.normalIndex]
    if (!slot) return
    updated[current.normalIndex] = {
      ...slot,
      xMm: clampPaperPosition(current.originXmm + deltaX, slot.widthMm, paper.value.widthMm),
      yMm: clampPaperPosition(current.originYmm + deltaY, slot.heightMm, paper.value.heightMm),
    }
    if (!allowPlacementChange([...lockedPlacements.value, ...updated], new Set([lockedPlacements.value.length + current.normalIndex]))) return
    manualPlacements.value = updated
  }
}

function onPointerEnd(event: PointerEvent): void {
  const box = boxSelection.value
  if (box?.pointerId === event.pointerId) {
    if (event.type === 'pointerup' && preview.value) {
      const end = pointMm(event, preview.value)
      selectedPlacementIndices.value = selectPlacementsInBox(placements.value, { xMm: box.startXmm, yMm: box.startYmm }, end, lockedPlacements.value.length)
      status.value = `已框选 ${selectedPlacementIndices.value.length} 张图片；至少选中 3 张可等间距排列，锁定组不参与。`
    }
    boxSelection.value = null
  } else if (drag.value?.pointerId !== event.pointerId) return
  drag.value = null
  if (preview.value?.hasPointerCapture(event.pointerId)) preview.value.releasePointerCapture(event.pointerId)
}

function resetLayout(): void {
  if (exporting.value || uploading.value) return
  const result = calculateLayout(assets.value, lockedPlacements.value)
  manualPlacements.value = result.placements
  // Locked groups retain the geometry with which they were placed, even if draft settings changed before locking.
  const prior = new Map(placedAssets.value.map(asset => [asset.id, asset]))
  placedAssets.value = assets.value.map(asset => ({ ...(asset.lockedGroupId ? prior.get(asset.id) ?? asset : asset) }))
  layoutOverflow.value = result.overflow
  layoutPending.value = false
  clearCanvasSelection()
  adjusting.value = false
  status.value = mode.value === 'smart' ? '已按当前排列方式重新智能排版；列表靠前的图片优先，锁组保留原有位置。' : '已重新自动排版；锁组保留原有位置。'
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
  manualPlacements.value = []
  placedAssets.value = []
  layoutPending.value = false
  layoutOverflow.value = 0
  clearCanvasSelection()
  clearGenerated()
  status.value = '已清空当前画板，可以重新添加图片。'
}

async function generate(): Promise<void> {
  if (exporting.value || uploading.value) return
  if (!placements.value.length) {
    status.value = '请先添加图片，再点击「排版」后导出。'
    return
  }
  if (paperMarginError.value) { status.value = paperMarginError.value; return }
  if (patternSpacingError.value) { status.value = patternSpacingError.value; return }
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
    const name = boardPngName(preset.value, paper.value, activeBoardIndex.value)
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

function boardPngName(preset: PaperPreset, paper: PaperSize, index: number, date = new Date()): string {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replace(/-/g, '')
  return `${day}_${preset === 'custom' ? '自定义' : preset}_${paper.widthMm}x${paper.heightMm}mm_画板${index + 1}.png`
}

async function exportAllBoards(): Promise<void> {
  if (exporting.value || uploading.value) return
  const scenes = overviewBoards.value.filter((board) => board.placements.length > 0)
  if (!scenes.length) { status.value = '没有可导出的图案，请先添加图片并排版。'; return }
  for (const scene of scenes) {
    if (!Number.isInteger(scene.dpi) || scene.dpi <= 0 || !exportSize(scene.paper, scene.dpi).allowed) {
      status.value = `画板 ${scene.index + 1} 的 DPI 无效或超过 1 亿像素上限，请调整后再导出。`
      return
    }
    if (scene.placements.some((slot) => slot.xMm < PAPER_MARGIN_MM - 1e-6 || slot.yMm < PAPER_MARGIN_MM - 1e-6 ||
      slot.xMm + slot.widthMm > scene.paper.widthMm - PAPER_MARGIN_MM + 1e-6 ||
      slot.yMm + slot.heightMm > scene.paper.heightMm - PAPER_MARGIN_MM + 1e-6)) {
      status.value = `画板 ${scene.index + 1} 的图案超出 4mm 留边，请调整后再导出。`
      return
    }
    if (findSpacingConflict(scene.placements, spacingContours(scene.assets))) {
      status.value = `画板 ${scene.index + 1} 的图案间距不足 4mm，请调整或重新排版后导出。`
      return
    }
  }
  const date = new Date()
  exporting.value = true
  let completed = 0
  try {
    for (const scene of scenes) {
      batchExportLabel.value = `正在导出画板 ${scene.index + 1}（${completed + 1}/${scenes.length}）· ${scene.dpi} DPI`
      status.value = batchExportLabel.value
      exportProgress.value = null
      await nextTick()
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const size = exportSize(scene.paper, scene.dpi)
      let canvas: HTMLCanvasElement | null = null
      let blob: Blob
      try {
        if (size.width * size.height > DIRECT_CANVAS_MAX_PIXELS) {
          exportProgress.value = 0
          blob = await tiledCanvasPng(size.width, size.height, scene.dpi,
            (context, width, height) => render(context, width, height, false, scene),
            (done, total) => { exportProgress.value = Math.round(done / total * 100) })
        } else {
          canvas = document.createElement('canvas')
          canvas.width = size.width
          canvas.height = size.height
          const context = canvas.getContext('2d', { alpha: true })
          if (!context) throw new Error('浏览器无法创建画布。')
          render(context, size.width, size.height, false, scene)
          blob = await canvasPng(canvas, scene.dpi)
        }
      } finally {
        if (canvas) { canvas.width = 0; canvas.height = 0 }
      }
      const url = URL.createObjectURL(blob)
      try {
        downloadBlob(url, boardPngName(scene.preset, scene.paper, scene.index, date))
      } finally {
        // Leave enough time for the browser to consume each download, then release its memory.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      completed += 1
    }
    status.value = `已发起 ${completed} 张 PNG 下载（空画板已跳过）。如未收到全部图片，请允许浏览器下载多个文件。`
  } catch (error) {
    status.value = `已发起 ${completed}/${scenes.length} 张下载，导出中断：${error instanceof Error ? error.message : '请降低 DPI 后重试。'}`
  } finally {
    exportProgress.value = null
    batchExportLabel.value = ''
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
    <aside ref="sidebar" :class="controlsOpen ? 'fixed inset-x-0 bottom-0 top-0 z-40 block' : 'hidden lg:block'" class="w-full shrink-0 overflow-y-auto border-r border-[#31415f] bg-[#17233d] pb-[env(safe-area-inset-bottom)] text-white lg:static lg:max-h-full lg:w-[466px] lg:pb-0">
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
        <div class="grid grid-cols-2 gap-1 sm:grid-cols-5">
          <button v-for="option in ([{ value: 'balanced', label: '均衡', hint: '各图等量' }, { value: 'compact', label: '省料', hint: '大图优先' }, { value: 'custom', label: '定制', hint: '列表顺序逐行' }, { value: 'smart', label: '智能填充', hint: '列表靠前先排' }, { value: 'neat', label: '整齐排版', hint: '分块对齐' }] as const)" :key="option.value" type="button" class="studio-choice min-w-0 py-1" :class="{ 'is-active': mode === option.value }" :aria-pressed="mode === option.value" @click="mode = option.value"><span class="text-sm font-semibold">{{ option.label }}</span><small class="mt-0.5 text-[10px]">{{ option.hint }}</small></button>
        </div>
        <p v-if="mode === 'custom'" class="mt-2 text-[11px] leading-5 text-[#a9bbe1]">按图片列表从上到下优先满足数量并逐行排版；大图旁的小图可按列纵向叠放。尺寸、数量和留边不变，行内整体居中。</p>
        <p v-if="mode === 'smart'" class="mt-2 text-[11px] leading-5 text-[#a9bbe1]">按图片列表从上到下优先满足数量，再按所选方式填充剩余空间；保持尺寸和角度。{{ autoGap ? '自动间距为 5mm。' : '使用当前横纵间距。' }}</p>
        <p v-if="mode === 'neat'" class="mt-2 text-[11px] leading-5 text-[#a9bbe1]">整齐优先：按尺寸分块对齐，相近宽度的小图可在大图旁纵向叠放。不缩图、不自动旋转，不穿插透明空隙；列表靠前的数量优先，放不下可新建画板排剩余。{{ autoGap ? '自动使用固定 5mm 间距，不拉伸填满。' : '保持当前横纵间距。' }}无锁组时整体居中；有锁组时保留原位并避让。可能比智能填充少排。</p>
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
        <p class="mb-2 text-[11px] text-[#a9bbe1]">纸张四周至少留边 {{ PAPER_MARGIN_MM }}mm；图案之间至少 {{ MIN_PATTERN_GAP_MM }}mm，支持 4～30 整数毫米，输入更小值会自动改为 4。</p>
        <div class="studio-gap-grid">
          <label class="studio-gap-row"><span>↔</span><input :value="gapXmm" type="range" :min="MIN_PATTERN_GAP_MM" max="30" step="1" class="min-w-0 flex-1 accent-[#a78bfa]" aria-label="横向间距" :disabled="autoGap" @input="onGapChange('x', $event)" /><input :value="gapXmm" type="number" :min="MIN_PATTERN_GAP_MM" max="30" step="1" inputmode="numeric" class="studio-input studio-gap-value" aria-label="横向间距毫米" :disabled="autoGap" @change="onGapChange('x', $event)" /><span>mm</span></label>
          <label class="studio-gap-row"><span>↕</span><input :value="gapYmm" type="range" :min="MIN_PATTERN_GAP_MM" max="30" step="1" class="min-w-0 flex-1 accent-[#a78bfa]" aria-label="纵向间距" :disabled="autoGap" @input="onGapChange('y', $event)" /><input :value="gapYmm" type="number" :min="MIN_PATTERN_GAP_MM" max="30" step="1" inputmode="numeric" class="studio-input studio-gap-value" aria-label="纵向间距毫米" :disabled="autoGap" @change="onGapChange('y', $event)" /><span>mm</span></label>
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
        <p v-if="assets.length" class="mt-1 text-[11px] text-[#8098c5]">定制、智能填充按列表从上到下优先排版；拖动右侧手柄调整顺序，松手后更新排版。数量 0 表示不排入，最多 500 份。导入按图片 DPI 换算原尺寸，无 DPI 时用导入时的画板 DPI；修改导出 DPI 不改变厘米尺寸，修改明细保持当前模式。</p>
        <div v-if="bulkOpen" class="mt-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-lg border border-[#40537a] p-2 text-[11px] text-[#a9bbe1]">
          <label>长边 cm<input v-model.number="bulkLongEdgeCm" type="number" min="0.1" max="42" step="0.1" class="studio-input mt-1 w-full" /></label>
          <label>数量<input v-model.number="bulkQuantity" type="number" min="0" max="500" class="studio-input mt-1 w-full" /></label>
          <button type="button" class="studio-action h-8" :disabled="!selectedCount" @click="applyBulk">应用</button>
        </div>
        <div v-for="asset in assets" :key="asset.id" :ref="element => setAssetRow(asset.id, element as HTMLElement | null)" class="studio-asset-row" :class="{ 'is-dragging': assetDrag?.active && assetDrag.id === asset.id, 'is-drop-before': assetDropIndicator?.id === asset.id && assetDropIndicator.side === 'before', 'is-drop-after': assetDropIndicator?.id === asset.id && assetDropIndicator.side === 'after' }">
          <div class="studio-asset-content">
          <input type="checkbox" :checked="asset.selected" :disabled="!!asset.lockedGroupId" :aria-label="`选择 ${asset.name}`" @change="updateAsset(asset.id, { selected: ($event.target as HTMLInputElement).checked })" />
          <img :src="asset.url" :alt="asset.name" :title="`${asset.name} · ${asset.width}×${asset.height}px`" :draggable="false" class="studio-asset-thumb" />
          <input type="number" min="0.01" step="0.01" :value="(asset.widthMm / 10).toFixed(2)" :disabled="!!asset.lockedGroupId" class="studio-input studio-size-input" :aria-label="`${asset.name} 宽度厘米`" @change="setAssetSize(asset.id, 'widthMm', Number(($event.target as HTMLInputElement).value))" />
          <button type="button" class="studio-asset-lock" :disabled="!!asset.lockedGroupId" :aria-label="asset.ratioLocked ? '解锁尺寸比例' : '锁定尺寸比例'" @click="updateAsset(asset.id, { ratioLocked: !asset.ratioLocked })">{{ asset.ratioLocked ? '🔒' : '🔓' }}</button>
          <input type="number" min="0.01" step="0.01" :value="(asset.heightMm / 10).toFixed(2)" :disabled="!!asset.lockedGroupId" class="studio-input studio-size-input studio-size-accent" :aria-label="`${asset.name} 高度厘米`" @change="setAssetSize(asset.id, 'heightMm', Number(($event.target as HTMLInputElement).value))" />
          <small v-if="asset.lockedGroupId" class="text-[9px] text-[#8fa5cf]">已锁组</small>
          <label class="flex shrink-0 items-center gap-1" title="定制、智能填充的排版数量上限；修改后保留当前模式">
            <span>数量</span>
            <input type="number" min="0" max="500" step="1" inputmode="numeric" :value="asset.quantity" :disabled="!!asset.lockedGroupId" class="studio-input studio-quantity-input" :aria-label="`${asset.name} 数量`" @change="setQuantity(asset.id, ($event.target as HTMLInputElement).valueAsNumber)" />
          </label>
          <label class="studio-rotation-field" :class="{ 'is-disabled': !!asset.lockedGroupId }">
            <input type="number" min="0" max="359" step="1" inputmode="numeric" :value="asset.rotationDeg" :disabled="!!asset.lockedGroupId" class="studio-rotation-input" :aria-label="`${asset.name} 旋转角度`" @change="setRotation(asset.id, Number(($event.target as HTMLInputElement).value))" />
            <span aria-hidden="true">°</span>
          </label>
          <div class="flex basis-full flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#31415f] pt-1" :class="{ 'opacity-50': mode !== 'custom' }">
            <label class="flex items-center gap-1">横距<input type="number" :min="MIN_PATTERN_GAP_MM" max="30" step="1" inputmode="numeric" placeholder="全局" :value="asset.gapXmm ?? ''" :disabled="mode !== 'custom' || !!asset.lockedGroupId || exporting || uploading" class="studio-input studio-size-input" :aria-label="`${asset.name} 横向间距毫米`" @change="setAssetGap(asset.id, 'x', $event)" /><span>mm</span></label>
            <label class="flex items-center gap-1">纵距<input type="number" :min="MIN_PATTERN_GAP_MM" max="30" step="1" inputmode="numeric" placeholder="全局" :value="asset.gapYmm ?? ''" :disabled="mode !== 'custom' || !!asset.lockedGroupId || exporting || uploading" class="studio-input studio-size-input" :aria-label="`${asset.name} 纵向间距毫米`" @change="setAssetGap(asset.id, 'y', $event)" /><span>mm</span></label>
            <label class="flex items-center gap-1"><input type="checkbox" :checked="!!asset.startNewRow" :disabled="mode !== 'custom' || !!asset.lockedGroupId || exporting || uploading" :aria-label="`${asset.name} 另起一行`" @change="setAssetNewRow(asset.id, ($event.target as HTMLInputElement).checked)" />另起一行</label>
            <span class="text-[10px] text-[#8098c5]">仅定制模式 · 留空跟随全局<template v-if="mode === 'custom' && autoGap && (asset.gapXmm !== undefined || asset.gapYmm !== undefined)"> · 独立间距的方向不自动拉伸</template></span>
          </div>
          <div class="flex basis-full items-center justify-between gap-2 text-[11px] leading-5" aria-live="polite">
            <span v-if="asset.lockedGroupId" class="text-[#c8bbff]">已锁组 · 已排 {{ placementCounts.get(asset.id) ?? 0 }} 个</span>
            <template v-else-if="asset.selected">
              <span class="text-[#a9bbe1]">已排 {{ placementCounts.get(asset.id) ?? 0 }}<template v-if="countMode"> / {{ asset.quantity }}</template> 个</span>
              <span v-if="countMode && asset.quantity > (placementCounts.get(asset.id) ?? 0)" class="text-amber-300">{{ asset.quantity - (placementCounts.get(asset.id) ?? 0) }} 个未排入</span>
            </template>
            <span v-else class="text-[#8098c5]">未参与排版</span>
          </div>
          </div>
          <div class="studio-asset-actions">
            <button type="button" class="studio-drag-handle" :aria-label="`拖拽排序 ${asset.name}`" title="按住拖动排序；键盘上下键调整顺序" aria-keyshortcuts="ArrowUp ArrowDown Home End" :disabled="assets.length < 2 || exporting || uploading" @pointerdown="startAssetDrag(asset.id, $event)" @pointermove="moveAssetDrag" @pointerup="finishAssetDrag" @pointercancel="cancelAssetDrag" @lostpointercapture="cancelAssetDrag" @keydown="onAssetOrderKey(asset.id, $event)" @contextmenu.prevent>
              <svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="4" r="1.5" /><circle cx="5" cy="10" r="1.5" /><circle cx="11" cy="10" r="1.5" /><circle cx="5" cy="16" r="1.5" /><circle cx="11" cy="16" r="1.5" /></svg>
            </button>
            <button type="button" class="studio-remove-button" :aria-label="`删除 ${asset.name}`" :disabled="exporting || uploading" title="从当前画板删除图片" @click="removeAsset(asset.id)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" /></svg></button>
          </div>
        </div>
        <p v-if="!assets.length" class="flex min-h-[100px] items-center justify-center text-center text-xs text-[#8fa5cf]">还没有添加图片</p>
      </section>
      <RouterLink class="mx-4 my-3 block rounded-lg border border-[#5e579d] bg-[#232952] p-3 text-xs leading-5 text-[#c8bbff]" to="/pricing">查看纸张价格与下单说明 →</RouterLink>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:p-5">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <div class="flex min-w-0 max-w-full gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="画板切换">
          <div v-for="(_, index) in boards" :key="index" class="flex shrink-0 items-center rounded-lg border" :class="activeBoardIndex === index ? 'border-violet-500 bg-violet-500 text-white' : 'border-slate-200 bg-white text-slate-600'">
            <button type="button" role="tab" :aria-selected="activeBoardIndex === index" :disabled="exporting || uploading" class="rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-40" @click="editOverviewBoard(index)">画板 {{ index + 1 }}</button>
            <button v-if="index > 0" type="button" class="mr-1 flex h-7 w-7 items-center justify-center rounded text-lg hover:bg-black/10 disabled:opacity-40" :aria-label="`删除画板 ${index + 1}`" title="删除画板" :disabled="exporting || uploading" @click.stop="removeBoard(index)">×</button>
          </div>
        </div>
        <button v-if="countMode" type="button" class="rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 disabled:opacity-40" :disabled="!overflow || exporting || uploading" @click="createRemainingBoard">＋ 新建画板排剩余<span v-if="overflow">（{{ overflow }}）</span></button>
        <button type="button" class="rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-40" :class="overviewOpen ? 'border-violet-500 bg-violet-500 text-white' : 'border-slate-200 bg-white text-slate-700'" :aria-pressed="overviewOpen" :disabled="exporting || uploading" @click="overviewOpen = !overviewOpen">{{ overviewOpen ? '返回当前画板' : '▦ 画板总览' }}</button>
      </div>
      <section v-if="overviewOpen" aria-label="画板总览" class="min-h-0 flex-1 overflow-y-auto rounded-2xl bg-slate-100 p-3 sm:p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-sm font-semibold text-slate-800">全部画板 · {{ boards.length }} 张</h2>
          <button type="button" class="min-h-10 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40" :disabled="exporting || uploading || !overviewBoards.some(board => board.placements.length)" @click="exportAllBoards">{{ exporting ? '正在导出…' : '一键导出全部 PNG' }}</button>
        </div>
        <p class="mb-4 mt-1 text-xs text-slate-500">点击任一画板返回编辑；总览保留当前排版，不会重新排列图片。</p>
        <p class="mb-3 text-xs text-slate-600" role="status">{{ status }}</p>
        <p class="mb-4 text-xs text-slate-500">按各画板 DPI 导出透明 PNG，空画板自动跳过；若浏览器提示，请允许下载多个文件。</p>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <button v-for="board in overviewBoards" :key="board.index" type="button" class="min-w-0 rounded-xl border-2 bg-white p-3 text-left transition-colors hover:border-violet-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500" :class="board.index === activeBoardIndex ? 'border-violet-500' : 'border-transparent'" :aria-label="`编辑画板 ${board.index + 1}`" @click="editOverviewBoard(board.index)">
            <div class="flex h-56 items-center justify-center rounded-lg bg-slate-800 p-3">
              <canvas :ref="(element) => setOverviewCanvas(board.index, element as HTMLCanvasElement | null)" class="studio-canvas bg-checker block h-auto max-h-full max-w-full shadow" :aria-label="`画板 ${board.index + 1} 排版预览`" />
            </div>
            <div class="mt-3 flex items-center justify-between gap-2 text-sm"><strong>画板 {{ board.index + 1 }}</strong><span v-if="board.index === activeBoardIndex" class="text-xs text-violet-600">当前画板</span></div>
            <p class="mt-1 text-xs text-slate-500">{{ board.preset }} · {{ board.paper.widthMm }} × {{ board.paper.heightMm }} mm · 已排 {{ board.placements.length }} 个</p>
          </button>
        </div>
      </section>
      <div :style="{ display: overviewOpen ? 'none' : 'flex' }" class="flex min-h-0 flex-1 flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span class="rounded-full bg-white px-3 py-1.5">{{ preset }} · {{ paper.widthMm }} × {{ paper.heightMm }} mm</span>
        <span class="rounded-full bg-white px-3 py-1.5">已排 {{ placements.length }} 个</span>
        <span v-if="layoutPending" class="rounded-full bg-violet-100 px-3 py-1.5 text-violet-800" role="status">设置有更新，点击「排版」后应用</span>
        <span v-if="overflow" class="rounded-full bg-amber-100 px-3 py-1.5 text-amber-800">{{ overflow }} 个未排入</span>
        <span class="rounded-full bg-white px-3 py-1.5">{{ Number.isFinite(dpi) ? `${dpi} DPI` : '请填写 DPI' }}</span>
      </div>
      <div class="relative flex min-h-[45dvh] min-w-0 flex-1 items-center justify-center overflow-auto rounded-2xl bg-slate-800 p-3 sm:min-h-[480px] sm:p-6 lg:min-h-0">
        <canvas ref="preview" :width="previewWidth" :height="previewHeight" class="studio-canvas block h-auto max-h-[calc(100dvh-260px)] max-w-full shadow-2xl lg:max-h-full" :class="[`bg-${background}`, { 'is-adjusting': adjusting, 'is-selecting': adjusting && adjustTool === 'select' }]" aria-label="排版实时预览" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerEnd" @pointercancel="onPointerEnd" @lostpointercapture="onPointerEnd" />
      </div>
      <section v-if="adjusting && selectedPlacement" aria-label="选中图片调整" class="shrink-0 rounded-xl border border-amber-400 bg-slate-900 p-3 text-white">
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
      </section>
      <div class="sticky bottom-2 z-10 space-y-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-lg lg:static">
        <p class="text-xs text-slate-600" aria-live="polite">{{ status }}</p>
        <div v-if="adjusting" class="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2 text-xs" aria-label="框选与等间距排列">
          <button type="button" class="studio-toolbar" :class="{ 'is-primary': adjustTool === 'move' }" :aria-pressed="adjustTool === 'move'" @click="adjustTool = 'move'">单张调整</button>
          <button type="button" class="studio-toolbar" :class="{ 'is-primary': adjustTool === 'select' }" :aria-pressed="adjustTool === 'select'" @click="adjustTool = 'select'">框选图片</button>
          <template v-if="adjustTool === 'select'">
            <span class="text-slate-500">已选 {{ selectedPlacementIndices.length }} 张</span>
            <button type="button" class="studio-toolbar" :disabled="selectedPlacementIndices.length < 3 || exporting || uploading" @click="distributeSelected('x')">横向等间距</button>
            <button type="button" class="studio-toolbar" :disabled="selectedPlacementIndices.length < 3 || exporting || uploading" @click="distributeSelected('y')">纵向等间距</button>
            <button type="button" class="px-2 py-2 text-slate-500" :disabled="!selectedPlacementIndices.length" @click="clearCanvasSelection">取消选择</button>
          </template>
        </div>
        <div class="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          <button type="button" class="studio-toolbar is-primary" :disabled="!assets.length || exporting || uploading" @click="resetLayout">✦ 排版</button>
          <button type="button" class="studio-toolbar" :class="{ 'is-primary': adjusting }" :disabled="!placements.length" @click="adjusting = !adjusting">✋ {{ adjusting ? '完成' : '调整' }}</button>
          <button type="button" class="studio-toolbar" :disabled="exporting || !placements.length || !!dpiError || !!paperMarginError || !!patternSpacingError" @click="generate">{{ exporting ? '生成中…' : boards.length > 1 ? '♧ 导出当前画板' : '♧ 导出 PNG' }}</button>
          <RouterLink class="studio-toolbar" to="/pricing">⭐ 升级</RouterLink>
          <button type="button" class="studio-toolbar" :disabled="!assets.length" @click="clearAll">▤ 清空</button>
          <button type="button" class="studio-toolbar" @click="cycleBackground">背景</button>
        </div>
        <p v-if="adjusting" class="text-xs text-indigo-700">{{ adjustTool === 'select' ? '鼠标或手指拖框，完整框住需要排列的图片；至少 3 张。固定首尾范围，按图片边缘均分间距，锁定组需先解锁。' : '点击画布上的一张图片，可拖动位置并调整单张大小；锁组整体移动。' }}</p>
        <p v-if="layoutPending" class="text-xs text-violet-700">当前画板保持原样；点击「排版」将应用新设置并替换手动调整。导出仅包含当前已排入的图案。</p>
        <p v-if="dpiError" class="text-xs text-amber-700">{{ dpiError }}</p>
        <p v-if="paperMarginError" class="text-xs text-amber-700">{{ paperMarginError }}</p>
        <p v-if="patternSpacingError" class="text-xs text-amber-700" role="alert">{{ patternSpacingError }}</p>
        <div v-if="generated" class="space-y-2 border-t border-slate-100 pt-2">
          <div class="flex flex-wrap items-center gap-2 text-xs"><span class="text-emerald-700">{{ generated.name }} · {{ formatBytes(generated.size) }}</span><a :href="XIAOHONGSHU_ORDER_URL" target="_blank" rel="noopener noreferrer" class="font-bold text-rose-600">去小红书下单 ↗</a></div>
          <div class="grid grid-cols-2 gap-2"><button type="button" class="min-h-10 rounded-lg bg-slate-900 px-3 text-xs font-bold text-white" @click="copyOrDownload">{{ orderCopied ? '点击下载图片' : '复制下单文案 → 下载' }}</button><button type="button" class="min-h-10 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700" @click="downloadOnly">仅下载图片</button></div>
        </div>
        <div v-if="manualCopy" class="space-y-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">浏览器未允许复制，请长按文案手动复制。<textarea :value="XIAOHONGSHU_ORDER_TEXT" readonly class="h-16 w-full rounded border border-amber-200 bg-white p-2 text-slate-700" /></div>
      </div>
      </div>
    </main>
    <div v-if="exporting" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-5" role="status"><div class="rounded-2xl bg-white p-6 text-center shadow-xl"><span class="mx-auto block h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-indigo-600"></span><p class="mt-4 font-bold">{{ batchExportLabel || `正在生成 ${dpi} DPI 图片` }}</p><p v-if="exportProgress !== null" class="mt-1 text-sm text-slate-500">已处理 {{ exportProgress }}%</p><p class="mt-1 text-sm text-slate-500">请勿关闭页面</p></div></div>
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
.studio-asset-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 30px; min-height: 38px; gap: 6px; border: 1px solid #31415f; border-radius: 6px; background: #1b2a49; padding: 5px 6px; color: #a9bbe1; font-size: 11px; }
.studio-asset-row + .studio-asset-row { margin-top: 5px; }
.studio-asset-content { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 4px; }
.studio-asset-content > input[type='checkbox'] { flex: 0 0 16px; }
.studio-asset-actions { display: flex; flex-direction: column; align-items: center; align-self: start; gap: 4px; }
.studio-asset-row.is-dragging { opacity: .5; }
.studio-asset-row.is-drop-before::before, .studio-asset-row.is-drop-after::after { position: absolute; z-index: 1; right: 0; left: 0; height: 3px; border-radius: 2px; background: #c4b5fd; content: ''; pointer-events: none; }
.studio-asset-row.is-drop-before::before { top: -4px; }
.studio-asset-row.is-drop-after::after { bottom: -4px; }
.studio-asset-thumb { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 4px; background: rgb(255 255 255 / 10%); object-fit: contain; }
.studio-size-input { width: 56px; height: 30px; flex: 0 0 56px; padding: 0 3px; text-align: center; }
.studio-size-accent { border-color: #40537a; color: #f7c931; }
.studio-asset-lock, .studio-remove-button, .studio-drag-handle { display: inline-flex; height: 30px; flex: 0 0 auto; align-items: center; justify-content: center; border: 1px solid #40537a; border-radius: 5px; color: #d6c8ff; }
.studio-asset-lock { width: 26px; font-size: 13px; }
.studio-quantity-input { width: 42px; height: 30px; flex: 0 0 42px; padding: 0 2px; text-align: center; }
.studio-rotation-field { display: flex; height: 30px; width: 56px; flex: 0 0 56px; align-items: center; border: 1px solid #a78bfa; border-radius: 5px; background: #a78bfa; color: #fff; }
.studio-rotation-field:focus-within { outline: 2px solid #d6c8ff; outline-offset: 1px; }
.studio-rotation-input { width: 100%; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; padding: 0 1px 0 4px; color: inherit; font-size: 11px; font-weight: 700; text-align: right; -moz-appearance: textfield; }
.studio-rotation-input::-webkit-inner-spin-button, .studio-rotation-input::-webkit-outer-spin-button { margin: 0; -webkit-appearance: none; }
.studio-rotation-field span { padding-right: 5px; font-size: 11px; font-weight: 700; }
.studio-rotation-field.is-disabled { opacity: .45; }
.studio-remove-button { width: 30px; padding: 0; border-color: transparent; color: #fda4af; }
.studio-remove-button:hover { background: rgb(244 63 94 / 12%); }
.studio-drag-handle { width: 30px; touch-action: none; user-select: none; -webkit-touch-callout: none; cursor: grab; }
.studio-drag-handle:active { cursor: grabbing; }
.studio-drag-handle:focus-visible, .studio-remove-button:focus-visible { outline: 2px solid #c4b5fd; outline-offset: 1px; }
.studio-drag-handle:disabled, .studio-remove-button:disabled { opacity: .4; }
.studio-asset-lock:disabled { opacity: .45; }
.studio-toolbar { display: flex; min-height: 38px; align-items: center; justify-content: center; border: 1px solid #d7dcf0; border-radius: 8px; padding: 4px; color: #334155; font-size: 12px; font-weight: 600; text-align: center; }
.studio-toolbar.is-primary { border-color: #a78bfa; background: #a78bfa; color: #fff; }
.studio-toolbar:disabled { opacity: .4; }
.studio-canvas.bg-checker { background-color: white; background-image: linear-gradient(45deg,#ddd 25%,transparent 25%),linear-gradient(-45deg,#ddd 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ddd 75%),linear-gradient(-45deg,transparent 75%,#ddd 75%); background-size: 20px 20px; background-position: 0 0,0 10px,10px -10px,-10px 0; }
.studio-canvas.bg-white { background: #fff; }
.studio-canvas.bg-dark { background: #1e293b; }
.studio-canvas.is-adjusting { cursor: grab; touch-action: none; }
.studio-canvas.is-adjusting:active { cursor: grabbing; }
.studio-canvas.is-selecting, .studio-canvas.is-selecting:active { cursor: crosshair; }
@media (max-width: 520px) {
  .studio-gap-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 5px; }
  .studio-gap-row { gap: 3px; font-size: 11px; }
  .studio-gap-value { width: 42px; flex-basis: 42px; }
  .studio-asset-row { gap: 3px; padding-inline: 4px; }
  .studio-asset-content { gap: 3px; }
  .studio-size-input { width: 48px; flex-basis: 48px; }
  .studio-asset-lock { width: 23px; }
  .studio-rotation-field { width: 52px; flex-basis: 52px; }
}
</style>
