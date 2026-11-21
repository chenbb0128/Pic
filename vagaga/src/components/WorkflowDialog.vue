<script setup lang="ts">
import { computed, ref } from 'vue'
import { workflowFinish, workflowSync, workflowUpload } from '../lib/tauri'
import { loadOrders, refreshWorkflowOrders, toast, useOrdersStore } from '../stores/orders'
import type { WorkflowPreview } from '../types'

const props = defineProps<{
  activeOrder: string | null
  saveLayout: () => Promise<void>
  applySharedVersion: (target: WorkflowPreview) => Promise<void>
}>()
const store = useOrdersStore()
const dialog = ref<HTMLDialogElement | null>(null)
const operation = ref<'upload' | 'sync' | 'finish' | 'resolve' | null>(null)
const preview = ref<WorkflowPreview | null>(null)
const conflicts = ref<WorkflowPreview[]>([])
const activePreview = computed(() => preview.value?.orderNumber === props.activeOrder)
const resolveError = ref('')

function close() {
  if (!operation.value) dialog.value?.close()
}

async function run<T>(kind: NonNullable<typeof operation.value>, task: () => Promise<T>) {
  if (operation.value) return
  operation.value = kind
  try {
    await props.saveLayout()
    return await task()
  } catch (error) {
    if (kind === 'resolve') resolveError.value = error instanceof Error ? error.message : String(error)
    else toast('error', String(error))
  } finally {
    operation.value = null
  }
}

async function refresh() {
  await Promise.all([loadOrders(), refreshWorkflowOrders()])
}

function reportErrors(errors: string[]) {
  if (errors.length) toast('error', errors.join('；'))
}

async function upload(orderNumbers: string[]) {
  if (!orderNumbers.length) return []
  const result = await run('upload', async () => {
    const result = await workflowUpload(orderNumbers)
    await refresh()
    if (result.updated) toast('ok', `已上传 ${result.updated} 个订单。`)
    reportErrors(result.errors)
    return result
  })
  return result?.uploadedOrderNumbers ?? []
}

async function sync() {
  await run('sync', async () => {
    const result = await workflowSync(props.activeOrder)
    await refresh()
    reportErrors(result.errors)
    if (!result.errors.length || result.updated || result.completed) {
      toast('ok', result.updated || result.completed
        ? `已同步 ${result.updated} 个订单，更新 ${result.completed} 条完成状态。`
        : result.conflicts.length ? '有订单需要确认。' : '没有新数据。')
    }
    conflicts.value = result.conflicts
    showPreview(conflicts.value.length === 1 ? conflicts.value[0] : null)
    if (conflicts.value.length && !dialog.value?.open) dialog.value?.showModal()
  })
}

function showPreview(target: WorkflowPreview | null) {
  resolveError.value = ''
  preview.value = target
}

function dismiss(target: WorkflowPreview) {
  conflicts.value = conflicts.value.filter(row => row.reference !== target.reference)
  showPreview(null)
  if (!conflicts.value.length) dialog.value?.close()
}

async function replace() {
  const target = preview.value
  if (!target || operation.value) return
  resolveError.value = ''
  await run('resolve', async () => {
    await props.applySharedVersion(target)
    dismiss(target)
    toast('ok', '订单已同步。')
    await refresh().catch(error => toast('error', `刷新订单失败：${error}`))
  })
}

async function finish(orderNumber: string) {
  await run('finish', async () => {
    const result = await workflowFinish(orderNumber)
    await refresh()
    const order = store.workflowOrders[orderNumber]
    if (result.errors.length) {
      reportErrors(result.errors)
    } else if (order?.pendingOperation === 'finish' || (order?.localCompleted && order.sharedState === 'pending')) {
      toast('ok', '已标记完成，等待交付。')
    } else if (order?.sharedState === 'completed') {
      toast('ok', '共享交付已完成。')
    } else if (order?.localCompleted) {
      toast('ok', '已标记完成。')
    }
  })
}

defineExpose({ upload, sync, finish, operation })
</script>

<template>
  <dialog ref="dialog" class="workflowDialog" aria-labelledby="workflow-title" @cancel.prevent="close">
    <header class="dialogHead">
      <h2 id="workflow-title">同步冲突</h2>
      <button type="button" class="closeBtn" aria-label="关闭" :disabled="!!operation" @click="close">×</button>
    </header>
    <div class="dialogBody" :aria-busy="!!operation">
      <p class="hint">以下订单有本机修改或正在编辑，已保留本机内容。</p>
      <div v-if="!preview" class="rowList" aria-label="等待确认的订单">
        <button v-for="row in conflicts" :key="row.reference" class="previewRow" type="button" :disabled="!!operation" @click="showPreview(row)">
          <span>{{ row.orderNumber }}</span><span>查看差异 →</span>
        </button>
      </div>
      <section v-else class="previewDetails" aria-label="订单差异">
        <h3>{{ preview.orderNumber }}</h3>
        <ul><li v-for="change in preview.changes" :key="change">{{ change }}</li></ul>
        <p v-if="preview.localVersion" class="hint">使用共享内容会在本机保留一份原订单及已保存的成品。</p>
        <p v-if="activePreview" class="hint">同步成功后会关闭当前画布。需要保留画布上的调整时，请先导出成品。</p>
        <p v-if="resolveError" class="resolveError" role="alert">{{ resolveError }}</p>
      </section>
    </div>
    <footer v-if="preview" class="dialogFoot">
      <button v-if="conflicts.length > 1" type="button" :disabled="!!operation" @click="showPreview(null)">返回列表</button>
      <div class="actions">
        <button type="button" :disabled="!!operation" @click="dismiss(preview)">保留本机</button>
        <button type="button" class="primary" :disabled="!!operation" @click="replace">{{ operation === 'resolve' ? '正在同步…' : '使用共享内容' }}</button>
      </div>
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
.dialogHead, .dialogFoot, .actions {
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
button {
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
.hint { color: var(--text-dim); font-size: 12px; }
.hint { margin: 0; }
.resolveError { margin: 0; color: #ae2424; font-size: 12px; }
.dialogBody > * + * { margin-top: 12px; }
.rowList { display: grid; max-height: 230px; overflow: auto; }
.previewRow { padding: 8px 4px; border-bottom: 1px solid var(--stroke); }
.previewRow { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; }
.previewDetails { display: grid; gap: 8px; }
.previewDetails ul { margin-bottom: 0; padding-left: 20px; }
</style>
