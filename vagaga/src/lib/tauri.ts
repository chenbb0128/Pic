import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { SavedTemplate, TemplateDraft, TemplateInfo } from '../types'
import type {
  AppInfo,
  CloudConfig,
  CloudNotice,
  OrderDetail,
  OrderSort,
  OrderSummary,
  PaidanEvent,
  MysqlConfig,
  CutoutConfig,
  Production,
  QiniuDevice,
  QiniuSettings,
  QiniuSettingsInput,
  QiniuStatus,
  WorkflowOrder,
  WorkflowResult,
  WorkflowRole,
  WorkflowSettings,
} from '../types'

export function listOrders(): Promise<OrderSummary[]> {
  return invoke('list_orders')
}

export function getOrderSort(): Promise<OrderSort> {
  return invoke('get_order_sort')
}

export function saveOrderSort(sort: OrderSort): Promise<void> {
  return invoke('save_order_sort', { sort })
}

export function getOrder(id: string): Promise<OrderDetail | null> {
  return invoke('get_order', { id })
}

export function setImageTemplates(imageId: string, templates: { templateId: string; quantity: number }[]): Promise<void> {
  return invoke('set_image_templates', { imageId, templates })
}

export function setImageRemark(imageId: string, remark: string): Promise<void> {
  return invoke('set_image_remark', { imageId, remark })
}

export function deleteImage(imageId: string): Promise<void> {
  return invoke('delete_image', { imageId })
}

export function deleteOrder(id: string): Promise<void> {
  return invoke('delete_order', { id })
}

export function getAppInfo(): Promise<AppInfo> {
  return invoke('get_app_info')
}

export function copyImageToClipboard(imageId: string): Promise<void> {
  return invoke('copy_image_to_clipboard', { imageId })
}

export function makePage(imageId: string, templateId: string): Promise<void> {
  return invoke('make_page', { imageId, templateId })
}

export function cutoutImageBytes(dataB64: string): Promise<{ pngB64: string; cached: boolean }> {
  return invoke('cutout_image_bytes', { dataB64 })
}

export function getCloudConfig(): Promise<CloudConfig> {
  return invoke('get_cloud_config')
}

export function saveCloudConfig(config: CloudConfig): Promise<void> {
  return invoke('save_cloud_config', { config })
}

export function cloudTest(config: CloudConfig): Promise<string> {
  return invoke('cloud_test', { config })
}

export function cloudSyncNow(): Promise<CloudNotice[]> {
  return invoke('cloud_sync_now')
}

export function cloudBackfill(): Promise<number> {
  return invoke('cloud_backfill')
}

export function getMysqlConfig(): Promise<MysqlConfig> {
  return invoke('get_mysql_config')
}

export function saveMysqlConfig(config: MysqlConfig): Promise<void> {
  return invoke('save_mysql_config', { config })
}

export function mysqlTest(config: MysqlConfig): Promise<string> {
  return invoke('mysql_test', { config })
}

export function mysqlSyncNow(activeOrder: string | null): Promise<WorkflowResult> {
  return invoke('mysql_sync_now', { activeOrder })
}

export function getQiniuSettings(): Promise<QiniuSettings> {
  return invoke('get_qiniu_settings')
}

export function testQiniuSettings(apiUrl: string, token?: string): Promise<QiniuDevice & { maxFileBytes: number }> {
  return invoke('test_qiniu_settings', { apiUrl, token })
}

export function saveQiniuSettings(settings: QiniuSettingsInput): Promise<QiniuSettings> {
  return invoke('save_qiniu_settings', { settings })
}

export function getQiniuStatus(): Promise<QiniuStatus> {
  return invoke('get_qiniu_status')
}

export function qiniuSyncNow(): Promise<number> {
  return invoke('qiniu_sync_now')
}

export function qiniuRetryFailed(): Promise<void> {
  return invoke('qiniu_retry_failed')
}

export function getCutoutConfig(): Promise<CutoutConfig> {
  return invoke('get_cutout_config')
}

export function saveCutoutConfig(config: CutoutConfig): Promise<void> {
  return invoke('save_cutout_config', { config })
}

export function saveProduction(
  orderNumber: string | null,
  dataB64: string,
  fileName: string,
  imageId: string | null,
): Promise<Production> {
  return invoke('save_production', { orderNumber, dataB64, fileName, imageId })
}

export function listProductions(orderNumber: string): Promise<Production[]> {
  return invoke('list_productions', { orderNumber })
}

export function openPath(path: string): Promise<void> {
  return invoke('open_path', { path })
}

export function saveOrderImage(imageId: string): Promise<string | null> {
  return invoke('save_order_image', { imageId })
}

export function onCloudImported(
  handler: (event: { payload: CloudNotice }) => void,
): Promise<() => void> {
  return listen<CloudNotice>('paidan:cloud-imported', e => handler({ payload: e.payload }))
}

export function assetUrl(filePath: string): string {
  return convertFileSrc(filePath)
}

export function onIngested(handler: (event: PaidanEvent) => void): Promise<() => void> {
  return listen<PaidanEvent>('paidan:ingested', e => handler(e.payload))
}

export function onFailed(handler: (event: PaidanEvent) => void): Promise<() => void> {
  return listen<PaidanEvent>('paidan:failed', e => handler(e.payload))
}

export function workflowSettings(): Promise<WorkflowSettings> {
  return invoke('workflow_settings')
}

export function workflowSetRole(role: WorkflowRole): Promise<WorkflowSettings> {
  return invoke('workflow_set_role', { role })
}

export function workflowOrders(): Promise<WorkflowOrder[]> {
  return invoke('workflow_orders')
}

export function workflowUpload(orderNumbers: string[]): Promise<WorkflowResult> {
  return invoke('workflow_upload', { orderNumbers })
}

export function workflowSync(activeOrder: string | null): Promise<WorkflowResult> {
  return invoke('workflow_sync', { activeOrder })
}

export function workflowFinish(orderNumber: string): Promise<WorkflowResult> {
  return invoke('workflow_finish', { orderNumber })
}

export function workflowResolveConflict(
  reference: string,
  localVersion: string | null,
  activeOrder: string | null,
): Promise<void> {
  return invoke('workflow_resolve_conflict', { reference, localVersion, activeOrder })
}

export function workflowSetLayout(orderNumber: string, number: string): Promise<void> {
  return invoke('workflow_set_layout', { orderNumber, number })
}

export function saveTemplate(input: TemplateDraft & { code: string; name: string }): Promise<TemplateInfo> {
  return invoke('save_template', { input })
}

export function getTemplate(id: string): Promise<SavedTemplate | null> {
  return invoke('get_template', { id })
}

export function updateTemplate(id: string, name: string, enabled: boolean): Promise<TemplateInfo> {
  return invoke('update_template', { id, name, enabled })
}

export function publishTemplate(id: string): Promise<void> {
  return invoke('publish_template', { id })
}

export function syncTemplates(): Promise<{ updated: number; errors: string[] }> {
  return invoke('sync_templates')
}
