import { reactive } from 'vue'
import { toast as notify } from 'vue-sonner'
import * as api from '../lib/tauri'
import type { AppInfo, OrderDetail, OrderSummary, PaidanEvent, QiniuStatus, WorkflowOrder, WorkflowSettings } from '../types'

interface State {
  orders: OrderSummary[]
  selectedId: string | null
  detail: OrderDetail | null
  info: AppInfo | null
  loading: boolean
  qiniu: QiniuStatus | null
  workflow: WorkflowSettings
  workflowOrders: Record<string, WorkflowOrder>
  latestCapture: { orderId: string } | null
}

const state = reactive<State>({
  orders: [],
  selectedId: null,
  detail: null,
  info: null,
  loading: false,
  qiniu: null,
  workflow: { role: 'both', target: null },
  workflowOrders: {},
  latestCapture: null,
})

export function toast(kind: 'ok' | 'error', text: string) {
  if (kind === 'ok') notify.success(text)
  else notify.error(text)
}

export async function loadInfo() {
  state.info = await api.getAppInfo()
}

export async function refreshQiniuStatus() {
  state.qiniu = await api.getQiniuStatus()
}

export async function refreshWorkflowSettings() {
  state.workflow = await api.workflowSettings()
}

let workflowRequest = 0
export async function refreshWorkflowOrders() {
  const request = ++workflowRequest
  const orders = await api.workflowOrders()
  if (request === workflowRequest) {
    state.workflowOrders = Object.fromEntries(orders.map(order => [order.orderNumber, order]))
  }
}

export async function loadOrders(selectId?: string) {
  state.loading = true
  try {
    state.orders = await api.listOrders()
    const target = selectId ?? state.selectedId
    if (target && state.orders.some(o => o.id === target)) {
      await selectOrder(target)
    } else if (state.orders.length) {
      await selectOrder(state.orders[0].id)
    } else {
      state.selectedId = null
      state.detail = null
    }
  } finally {
    state.loading = false
  }
}

export async function selectOrder(id: string) {
  state.selectedId = id
  state.detail = await api.getOrder(id)
}

export async function refreshCurrent() {
  if (state.selectedId) await selectOrder(state.selectedId)
}

export async function handlePaidanEvent(event: PaidanEvent) {
  if (event.kind === 'ingested') {
    const note = state.qiniu?.enabled
      ? event.scaled ? '（缩图，仅保存在本机）' : '（已保存本地，同步状态见订单）'
      : event.scaled ? '（缩图）' : ''
    toast('ok', `排单已入库：订单 ${event.orderNumber}${note}`)
    await Promise.all([loadOrders(), refreshWorkflowOrders().catch(() => {})])
    const target = state.orders.find(o => o.orderNumber === event.orderNumber)
    if (target) {
      if (target.id !== state.selectedId) await selectOrder(target.id)
      state.latestCapture = { orderId: target.id }
    }
  } else {
    toast('error', `排单入库失败（${event.orderNumber}）：${event.detail ?? '未知原因'}`)
  }
}

let eventBinding: Promise<() => void> | null = null

export function bindEvents(): Promise<() => void> {
  if (eventBinding) return eventBinding
  eventBinding = registerEvents().catch(error => {
    eventBinding = null
    throw error
  })
  return eventBinding
}

async function registerEvents(): Promise<() => void> {
  const unlisteners: (() => void)[] = []
  try {
    unlisteners.push(await api.onIngested(event => {
      return handlePaidanEvent(event).catch(error => toast('error', `刷新排单失败：${error}`))
    }))
    unlisteners.push(await api.onFailed(handlePaidanEvent))
    // 云同步：另一台机器（客服机/制作机）推送的订单/成品更新
    unlisteners.push(await api.onCloudImported(async event => {
      const { orderNumber, newImages, newProductions } = event.payload
      const parts: string[] = []
      if (newImages > 0) parts.push(`${newImages} 张新素材待制作`)
      if (newProductions > 0) parts.push(`${newProductions} 个新成品`)
      toast(
        'ok',
        parts.length
          ? `同步：订单 ${orderNumber} — ${parts.join('、')}`
          : `同步：订单 ${orderNumber} 信息已更新`,
      )
      await loadOrders().catch(error => toast('error', `刷新同步订单失败：${error}`))
    }))
  } catch (error) {
    unlisteners.forEach(stop => stop())
    throw error
  }
  // 事件兜底：定时轮询订单列表（事件丢失也能刷出来）
  const pollTimer = setInterval(() => {
    void loadOrders().catch(() => {})
    void refreshQiniuStatus().catch(() => {})
    void refreshWorkflowOrders().catch(() => {})
  }, 5000)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(pollTimer)
    unlisteners.forEach(stop => stop())
    eventBinding = null
  }
}

export function useOrdersStore() {
  // 返回 reactive 代理本身（不可展开：展开会丢失响应性）
  return state
}
