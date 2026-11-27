<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, GitCompareArrows, X } from '@lucide/vue'
import { Button } from './ui/button'
import { workflowFinish, workflowReopen, workflowSync, workflowUpload } from '../lib/tauri'
import { loadInfo, loadOrders, orderDisplay, refreshShops, refreshWorkflowOrders, toast, useOrdersStore } from '../stores/orders'
import type { WorkflowPreview } from '../types'

const props = defineProps<{
  activeOrder: string | null
  saveLayout: () => Promise<void>
  applySharedVersion: (target: WorkflowPreview) => Promise<void>
}>()
const store = useOrdersStore()
const dialog = ref<HTMLDialogElement | null>(null)
const operation = ref<'upload' | 'sync' | 'finish' | 'resolve' | 'reopen' | null>(null)
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

function showConflicts(rows: WorkflowPreview[]) {
  conflicts.value = rows
  showPreview(rows.length === 1 ? rows[0] : null)
  if (rows.length && !dialog.value?.open) dialog.value?.showModal()
}

async function upload(orderNumbers: string[]) {
  if (!orderNumbers.length) return []
  const result = await run('upload', async () => {
    const result = await workflowUpload(orderNumbers)
    showConflicts(result.conflicts)
    await refresh().catch(error => toast('error', `刷新订单失败：${error}`))
    if (result.updated) toast('ok', `已上传 ${result.updated} 个订单。`)
    reportErrors(result.errors)
    return result
  })
  return result?.uploadedOrderNumbers ?? []
}

async function sync() {
  await run('sync', async () => {
    const result = await workflowSync(props.activeOrder)
    showConflicts(result.conflicts)
    await Promise.all([
      refresh(),
      loadInfo().catch(error => toast('error', '刷新模板目录失败：' + error)),
      result.shopsChanged ? refreshShops().catch(error => toast('error', '刷新店铺列表失败：' + error)) : Promise.resolve(),
    ])
    reportErrors(result.errors)
    const claimsChanged = result.claimsChanged ?? 0
    const templatesUpdated = result.templatesUpdated ?? 0
    if (!result.errors.length || result.updated || result.completed || claimsChanged || templatesUpdated || result.shopsChanged) {
      const parts: string[] = []
      if (result.updated) parts.push(`更新 ${result.updated} 个订单`)
      if (result.completed) parts.push(`完成 ${result.completed} 单`)
      if (claimsChanged) parts.push(`同步 ${claimsChanged} 条领单状态`)
      if (templatesUpdated) parts.push(`更新 ${templatesUpdated} 个模板`)
      if (result.shopsChanged) parts.push('更新店铺列表')
      toast('ok', parts.length
        ? `同步成功：${parts.join('，')}。`
        : result.conflicts.length ? '有订单需要确认。' : '没有新数据。')
    }
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
    await Promise.all([refresh(), loadInfo()]).catch(error => toast('error', `刷新订单失败：${error}`))
  })
}

async function finish(orderNumber: string) {
  await run('finish', async () => {
    const result = await workflowFinish(orderNumber)
    showConflicts(result.conflicts)
    reportErrors(result.errors)
    await refresh().catch(error => toast('error', `刷新订单失败：${error}`))
    if (result.errors.length || result.conflicts.length) return
    const order = store.workflowOrders[orderNumber]
    if (order?.pendingOperation === 'finish' || (order?.localCompleted && order.sharedState === 'pending')) {
      toast('ok', '已标记完成，等待交付。')
    } else if (order?.sharedState === 'completed') {
      toast('ok', '共享交付已完成。')
    } else if (order?.localCompleted) {
      toast('ok', '已标记完成。')
    } else if (result.completed > 0) {
      toast('ok', '该订单已完成。')
    }
  })
}

async function reopen(orderNumber: string) {
  await run('reopen', async () => {
    await workflowReopen(orderNumber)
    await refresh().catch(error => toast('error', `刷新订单失败：${error}`))
    toast('ok', `订单 ${orderDisplay(orderNumber)} 已返工重开为待制作。`)
  })
}

defineExpose({ upload, sync, finish, reopen, operation })
</script>

<template>
  <dialog ref="dialog" class="workflowDialog" aria-labelledby="workflow-title" @cancel.prevent="close">
    <header class="dialogHead">
      <h2 id="workflow-title" class="flex items-center gap-2"><GitCompareArrows class="size-5 text-primary" aria-hidden="true" />订单内容有冲突</h2>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭" :disabled="!!operation" @click="close"><X aria-hidden="true" /></Button>
    </header>
    <div class="dialogBody" :aria-busy="!!operation">
      <p class="hint">请查看本机与共享订单的差异，再选择如何处理。</p>
      <div v-if="!preview" class="rowList" aria-label="等待确认的订单">
        <Button v-for="row in conflicts" :key="row.reference" variant="outline" class="justify-between" type="button" :disabled="!!operation" @click="showPreview(row)">
          <span>{{ orderDisplay(row.orderNumber) }}</span><span class="flex items-center gap-1.5 text-primary">查看差异 <ArrowRight class="size-3.5" aria-hidden="true" /></span>
        </Button>
      </div>
      <section v-else class="previewDetails" aria-label="订单差异">
        <h3>{{ orderDisplay(preview.orderNumber) }}</h3>
        <ul><li v-for="change in preview.changes" :key="change">{{ change }}</li></ul>
        <p v-if="preview.localVersion" class="hint">使用共享内容会在本机保留一份原订单及已保存的成品。</p>
        <p v-if="activePreview" class="hint">同步成功后会关闭当前画布。需要保留画布上的调整时，请先导出成品。</p>
        <p v-if="resolveError" class="resolveError" role="alert">{{ resolveError }}</p>
      </section>
    </div>
    <footer v-if="preview" class="dialogFoot">
      <Button v-if="conflicts.length > 1" type="button" variant="ghost" :disabled="!!operation" @click="showPreview(null)">返回列表</Button>
      <div class="actions">
        <Button type="button" variant="outline" :disabled="!!operation" @click="dismiss(preview)">保留本机</Button>
        <Button type="button" :disabled="!!operation" @click="replace">{{ operation === 'resolve' ? '正在同步…' : '使用共享内容' }}</Button>
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
.hint { color: var(--text-dim); font-size: 12px; }
.hint { margin: 0; }
.resolveError { margin: 0; color: #ae2424; font-size: 12px; }
.dialogBody > * + * { margin-top: 12px; }
.rowList { display: grid; gap: 6px; max-height: 230px; overflow: auto; }
.actions { margin-left: auto; }
.previewDetails { display: grid; gap: 8px; }
.previewDetails ul { margin-bottom: 0; padding-left: 20px; }
</style>
