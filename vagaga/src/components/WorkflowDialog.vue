<script setup lang="ts">
import { computed, ref } from 'vue'
import { workflowFinish, workflowResolveConflict, workflowSync, workflowUpload } from '../lib/tauri'
import { loadOrders, refreshWorkflowOrders, toast, useOrdersStore } from '../stores/orders'
import type { WorkflowPreview } from '../types'

const props = defineProps<{
  activeOrder: string | null
  saveLayout: () => Promise<void>
}>()
const store = useOrdersStore()
const dialog = ref<HTMLDialogElement | null>(null)
const operation = ref<'upload' | 'sync' | 'finish' | 'resolve' | null>(null)
const preview = ref<WorkflowPreview | null>(null)
const conflicts = ref<WorkflowPreview[]>([])
const activePreview = computed(() => preview.value?.orderNumber === props.activeOrder)

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
    toast('error', String(error))
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
    preview.value = null
    if (conflicts.value.length === 1) preview.value = conflicts.value[0]
    if (conflicts.value.length && !dialog.value?.open) dialog.value?.showModal()
  })
}

function dismiss(target: WorkflowPreview) {
  conflicts.value = conflicts.value.filter(row => row.reference !== target.reference)
  preview.value = null
  if (!conflicts.value.length) dialog.value?.close()
}

async function replace() {
  const target = preview.value
  if (!target || activePreview.value) return
  await run('resolve', async () => {
    await workflowResolveConflict(target.reference, target.localVersion, props.activeOrder)
    await refresh()
    dismiss(target)
    toast('ok', '订单已同步。')
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
      toast('ok', '制作已完成，等待交付。')
    } else if (order?.sharedState === 'completed') {
      toast('ok', '共享交付已完成。')
    } else if (order?.localCompleted) {
      toast('ok', '制作已完成。')
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
        <button v-for="row in conflicts" :key="row.reference" class="previewRow" type="button" @click="preview = row">
          <span>{{ row.orderNumber }}</span><span>查看差异 →</span>
        </button>
      </div>
      <section v-else class="previewDetails" aria-label="订单差异">
        <h3>{{ preview.orderNumber }}</h3>
        <ul><li v-for="change in preview.changes" :key="change">{{ change }}</li></ul>
        <p v-if="activePreview" class="hint">正在编辑此订单。切换编辑订单后可使用共享版本。</p>
      </section>
    </div>
    <footer v-if="preview" class="dialogFoot">
      <button v-if="conflicts.length > 1" type="button" :disabled="!!operation" @click="preview = null">返回列表</button>
      <div class="actions">
        <button type="button" :disabled="!!operation" @click="dismiss(preview)">保留本机</button>
        <button type="button" class="primary" :disabled="!!operation || activePreview" @click="replace">{{ operation === 'resolve' ? '正在同步…' : '使用共享版本' }}</button>
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
.dialogBody > * + * { margin-top: 12px; }
.rowList { display: grid; max-height: 230px; overflow: auto; }
.previewRow { padding: 8px 4px; border-bottom: 1px solid var(--stroke); }
.previewRow { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; }
.previewDetails { display: grid; gap: 8px; }
.previewDetails ul { margin-bottom: 0; padding-left: 20px; }
</style>
