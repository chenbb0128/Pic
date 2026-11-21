<script setup lang="ts">
import { computed, ref } from 'vue'
import { workflowFinish, workflowHistory, workflowRestore, workflowSync, workflowUpload } from '../lib/tauri'
import { loadOrders, refreshWorkflowOrders, refreshWorkflowSettings, toast, useOrdersStore } from '../stores/orders'
import type { WorkflowHistoryKind, WorkflowPreview, WorkflowRestoreAction, WorkflowResult, WorkflowUploadKind } from '../types'

const props = defineProps<{
  activeOrder: string | null
  saveLayout: () => Promise<void>
}>()
const store = useOrdersStore()
const dialog = ref<HTMLDialogElement | null>(null)
const panel = ref<'upload' | 'sync' | WorkflowHistoryKind>('sync')
const title = computed(() => ({
  upload: '数据上传',
  sync: '数据同步',
  backup: '从备份恢复',
  completed: '共享已完成订单',
}[panel.value]))

const busy = ref(false)
const uploadKind = ref<WorkflowUploadKind | ''>('')
const selectedOrders = ref<string[]>([])
const search = ref('')
const rows = ref<WorkflowPreview[]>([])
const preview = ref<WorkflowPreview | null>(null)
const conflicts = ref<WorkflowPreview[]>([])
const errors = ref<string[]>([])
const summary = ref('')
const canPublish = computed(() => store.workflow.role !== 'production')
function alreadyCompleted(number: string) {
  const order = store.workflowOrders[number]
  return order?.localCompleted || order?.sharedState === 'completed'
}

const uploadOrders = computed(() => store.orders.filter(order =>
  order.orderNumber.toLowerCase().includes(search.value.trim().toLowerCase())
  && (uploadKind.value !== 'publish' || !alreadyCompleted(order.orderNumber)),
))
const activePreview = computed(() => preview.value?.orderNumber === props.activeOrder)
const canReplace = computed(() => !activePreview.value)

function present(next: typeof panel.value) {
  if (busy.value) return false
  panel.value = next
  summary.value = ''
  errors.value = []
  preview.value = null
  if (dialog.value && !dialog.value.open) dialog.value.showModal()
  return true
}

function close() {
  if (!busy.value) dialog.value?.close()
}

async function run(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  errors.value = []
  try {
    await task()
  } catch (error) {
    errors.value = [String(error)]
    if (!dialog.value?.open) toast('error', String(error))
  } finally {
    busy.value = false
  }
}

async function refresh() {
  await Promise.all([loadOrders(), refreshWorkflowOrders(), refreshWorkflowSettings()])
}

function record(result: WorkflowResult, message: string) {
  summary.value = message
  errors.value = result.errors
  if (panel.value === 'sync') conflicts.value = result.conflicts
  else if (result.conflicts.length) {
    const changed = new Set(result.conflicts.map(row => row.reference))
    conflicts.value = [...conflicts.value.filter(row => !changed.has(row.reference)), ...result.conflicts]
  }
}

function openUpload() {
  if (!present('upload')) return
  selectedOrders.value = []
  uploadKind.value = ''
  search.value = ''
}

function toggleUploadAll() {
  const visible = uploadOrders.value.map(order => order.orderNumber)
  selectedOrders.value = visible.every(orderNumber => selectedOrders.value.includes(orderNumber))
    ? selectedOrders.value.filter(orderNumber => !visible.includes(orderNumber))
    : [...new Set([...selectedOrders.value, ...visible])]
}

async function upload() {
  const kind = uploadKind.value
  if (!kind || !selectedOrders.value.length || (kind === 'publish' && !canPublish.value)) return
  await run(async () => {
    await props.saveLayout()
    const result = await workflowUpload(selectedOrders.value, kind)
    await refresh()
    record(result, result.updated
      ? (kind === 'publish' ? `已发布 ${result.updated} 个待制作订单。` : `已备份 ${result.updated} 个订单。`)
      : '本次没有上传成功的订单。')
  })
}

async function sync() {
  await run(async () => {
    await props.saveLayout()
    const result = await workflowSync(props.activeOrder)
    await refresh()
    record(result, `已同步 ${result.updated} 个订单，更新 ${result.completed} 条完成状态。`)
  })
}

async function openHistory(kind: WorkflowHistoryKind) {
  if (!present(kind)) return
  rows.value = []
  if (store.workflow.target) await run(async () => { rows.value = await workflowHistory(kind) })
}

async function resolve(action: WorkflowRestoreAction) {
  const target = preview.value
  if (!target || (action === 'replace' && !canReplace.value)) return
  await run(async () => {
    await props.saveLayout()
    const result = await workflowRestore(target.reference, action, target.localVersion, props.activeOrder)
    await refresh()
    if (!result.errors.length && !result.conflicts.length) {
      conflicts.value = conflicts.value.filter(row => row.reference !== target.reference)
      preview.value = null
      summary.value = ({
        replace: '订单已恢复。',
        copy: '已恢复为副本。',
        keep: '已保留本机数据。',
        download: '成品已下载到本机。',
      })[action]
    } else {
      errors.value = result.errors
      if (result.conflicts.length) {
        preview.value = result.conflicts[0]
        conflicts.value = [...conflicts.value.filter(row => row.reference !== target.reference), ...result.conflicts]
      }
    }
  })
}

async function finish(orderNumber: string) {
  await run(async () => {
    await props.saveLayout()
    const result = await workflowFinish(orderNumber)
    await refresh()
    const order = store.workflowOrders[orderNumber]
    if (result.errors.length) {
      toast('error', result.errors[0])
    } else if (order?.pendingOperation === 'finish' || (order?.localCompleted && order.sharedState === 'pending')) {
      toast('ok', '制作已完成，等待交付。')
    } else if (order?.sharedState === 'completed') {
      toast('ok', '共享交付已完成。')
    } else if (order?.localCompleted) {
      toast('ok', '制作已完成。')
    }
  })
}

function openSync() {
  present('sync')
}

function changeIntent() {
  if (uploadKind.value === 'publish') {
    selectedOrders.value = selectedOrders.value.filter(orderNumber => !alreadyCompleted(orderNumber))
  }
  summary.value = ''
  errors.value = []
}

defineExpose({ openUpload, openSync, openHistory, finish })
</script>

<template>
  <dialog ref="dialog" class="workflowDialog" aria-labelledby="workflow-title" @cancel.prevent="close">
    <header class="dialogHead">
      <h2 id="workflow-title">{{ title }}</h2>
      <button type="button" class="closeBtn" aria-label="关闭" :disabled="busy" @click="close">×</button>
    </header>
    <div class="dialogBody" :aria-busy="busy">
      <p v-if="!store.workflow.target" class="hint">还未启用共享存储。请到「设置 → 共享存储」配置。</p>

      <template v-if="panel === 'upload'">
        <fieldset class="intents" :disabled="busy">
          <legend>上传用途</legend>
          <label v-if="canPublish" class="choice">
            <input v-model="uploadKind" type="radio" value="publish" @change="changeIntent" />
            <span><strong>发布待制作订单</strong><small>制作端同步后可接单。</small></span>
          </label>
          <label class="choice">
            <input v-model="uploadKind" type="radio" value="backup" @change="changeIntent" />
            <span><strong>备份订单</strong><small>将订单资料保存到共享存储，供日后恢复。</small></span>
          </label>
        </fieldset>
        <div class="selectionBar">
          <input v-model="search" placeholder="搜索订单号" type="search" aria-label="搜索要上传的订单号" />
          <button type="button" :disabled="busy || !uploadOrders.length" @click="toggleUploadAll">切换全选</button>
        </div>
        <div class="rowList">
          <label v-for="order in uploadOrders" :key="order.id" class="choice">
            <input v-model="selectedOrders" type="checkbox" :value="order.orderNumber" :disabled="busy" />
            <span>{{ order.orderNumber }}</span>
            <small>{{ order.imageCount }} 张素材</small>
          </label>
          <p v-if="!uploadOrders.length" class="hint">没有可选的订单。</p>
        </div>
      </template>

      <template v-else-if="panel === 'sync' && !preview">
        <p class="hint">拉取待制作订单和共享完成状态。</p>
        <div v-if="conflicts.length" class="rowList" aria-label="等待确认的订单">
          <button v-for="row in conflicts" :key="row.reference" class="previewRow" type="button" @click="preview = row">
            <span>{{ row.orderNumber }}</span><span>查看冲突 →</span>
          </button>
        </div>
      </template>

      <template v-else-if="!preview">
        <div v-if="rows.length" class="rowList" aria-label="共享订单">
          <button v-for="row in rows" :key="row.reference" class="previewRow" type="button" @click="preview = row">
            <strong>{{ row.orderNumber }}</strong>
            <span>{{ row.updatedAt.replace('T', ' ').slice(0, 19) }}</span>
            <span>查看详情 →</span>
          </button>
        </div>
        <p v-else-if="store.workflow.target && !busy && !errors.length" class="hint">{{ panel === 'backup' ? '暂无可恢复的备份。' : '共享存储里暂无已完成订单。' }}</p>
      </template>

      <section v-if="preview" class="previewDetails" aria-label="订单预览">
        <h3>{{ preview.orderNumber }}</h3>
        <p class="hint">{{ preview.updatedAt.replace('T', ' ').slice(0, 19) }}<span v-if="preview.conflict"> · 与本机版本有差异</span></p>
        <ul v-if="preview.changes.length">
          <li v-for="change in preview.changes" :key="change">{{ change }}</li>
        </ul>
        <p v-if="activePreview" class="hint">该订单的画布正在编辑。可保存副本，或切换编辑订单后再更新此订单。</p>
      </section>

      <p v-if="busy" class="hint" role="status">正在处理…</p>
      <p v-if="summary" class="result" role="status">{{ summary }}</p>
      <ul v-if="errors.length" class="errors" role="alert">
        <li v-for="(error, index) in errors" :key="index">{{ error }}</li>
      </ul>
    </div>

    <footer class="dialogFoot">
      <template v-if="panel === 'upload'">
        <span class="hint">已选 {{ selectedOrders.length }} 个订单</span>
        <button type="button" class="primary" :disabled="busy || !store.workflow.target || !uploadKind || !selectedOrders.length" @click="upload">{{ uploadKind === 'publish' ? '发布订单' : uploadKind === 'backup' ? '备份订单' : '上传' }}</button>
      </template>
      <template v-else-if="preview">
        <button type="button" :disabled="busy" @click="preview = null">返回列表</button>
        <div class="actions">
          <template v-if="panel === 'completed'">
            <button v-if="activePreview || preview.conflict" type="button" :disabled="busy" @click="resolve('copy')">另存为副本</button>
            <button type="button" class="primary" :disabled="busy || !canReplace" @click="resolve('download')">下载成品</button>
          </template>
          <template v-else>
            <button v-if="preview.conflict" type="button" :disabled="busy" @click="resolve('keep')">保留本机</button>
            <button type="button" :disabled="busy" @click="resolve('copy')">另存为副本</button>
            <button type="button" class="primary" :disabled="busy || !canReplace" @click="resolve('replace')">{{ preview.conflict ? '使用共享版本' : '恢复此订单' }}</button>
          </template>
        </div>
      </template>
      <template v-else-if="panel === 'sync'">
        <button type="button" :disabled="busy || !store.workflow.target" @click="openHistory('backup')">从备份恢复</button>
        <button type="button" class="primary" :disabled="busy || !store.workflow.target" @click="sync">开始同步</button>
      </template>
      <button v-else type="button" :disabled="busy" @click="openSync">返回数据同步</button>
    </footer>
  </dialog>
</template>

<style scoped>
.workflowDialog {
  padding: 0;
  width: min(560px, calc(100vw - 32px));
  max-height: min(720px, calc(100vh - 40px));
  overflow: auto;
  border: 1px solid var(--stroke);
  border-radius: 14px;
  background: #fff;
  color: var(--text);
  box-shadow: 0 12px 44px #17234128;
}
.workflowDialog::backdrop { background: #17234150; }
.dialogHead, .dialogFoot, .selectionBar, .actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dialogHead, .dialogFoot {
  justify-content: space-between;
  padding: 12px 18px;
}
.dialogHead { border-bottom: 1px solid var(--stroke); }
.dialogFoot { border-top: 1px solid var(--stroke); }
.dialogBody { padding: 16px 18px; }
h2, h3 { margin: 0; font-size: 16px; }
button, input[type='search'] {
  border: 1px solid var(--stroke);
  border-radius: 8px;
  background: var(--bg-card);
  color: inherit;
  padding: 6px 12px;
  font: inherit;
}
button { cursor: pointer; }
button:hover:not(:disabled) { background: var(--bg-card-hover); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: white; }
button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(.92); }
.closeBtn { font-size: 17px; line-height: 1; }
.hint, small { color: var(--text-dim); font-size: 12px; }
.hint { margin: 0; }
.dialogBody > * + * { margin-top: 12px; }
.intents { margin-inline: 0; padding: 4px 10px 8px; border: 1px solid var(--stroke); border-radius: 8px; }
.choice { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.choice small { display: block; }
.intents .choice { padding: 6px 0; }
.rowList { display: grid; max-height: 230px; overflow: auto; }
.rowList > .choice, .previewRow { padding: 8px 4px; border-bottom: 1px solid var(--stroke); }
.rowList .choice small { margin-left: auto; }
.previewRow { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; }
.previewDetails { display: grid; gap: 8px; }
.previewDetails ul, .errors { margin-bottom: 0; padding-left: 20px; }
.errors { color: var(--danger); overflow-wrap: anywhere; }
.result { color: var(--accent); margin-bottom: 0; }
.selectionBar input { flex: 1; min-width: 0; }
</style>
