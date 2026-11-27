export interface TemplateQty {
  templateId: string
  quantity: number
}

export type SourceQuality = 'original' | 'scaled' | 'unknown'
export type SyncStatus = 'pending' | 'uploading' | 'synced' | 'failed' | 'localOnly' | 'downloading'

export interface OrderImage {
  id: string
  filePath: string
  thumbnailPath: string | null
  originalName: string
  byteLength: number
  width: number
  height: number
  source: string
  createdAt: string
  remark: string
  templates: TemplateQty[]
  remoteOnly?: boolean
  sourceQuality?: SourceQuality
  syncStatus?: SyncStatus
  syncError?: string
}

export interface OrderSummary {
  id: string
  orderNumber: string
  imageCount: number
  createdAt: string
  updatedAt: string
  metadata: string | null
}

export interface OrderEntry {
  summary: OrderSummary
  images: OrderImage[]
}

export interface OrderDetail {
  id: string
  orderNumber: string
  createdAt: string
  updatedAt: string
  images: OrderImage[]
}

export type OrderSortMode = 'time-desc' | 'time-asc' | 'amount-desc' | 'amount-asc' | 'manual'

export interface OrderSort {
  mode: OrderSortMode
  manual: string[]
}

export interface TemplateInfo {
  code: string
  name: string
  webId: string
  legacyWebId?: string
  custom?: boolean
  enabled?: boolean
  width?: number
  height?: number
  dpi?: number
  previewPath?: string
}

export interface TemplateDraft {
  width: number
  height: number
  dpi: number
  layout: unknown
  backgroundB64: string
  previewB64: string
}

export interface SavedTemplate {
  template: TemplateInfo
  layout: unknown
  backgroundPath: string
}

export interface AppInfo {
  dataRoot: string
  cdpPort: number
  templates: TemplateInfo[]
}

export type CloudProvider = 'minio' | 'webdav' | 'smb'
export type StorageProvider = CloudProvider | 'qiniu'

export interface WebDavConfig {
  endpoint: string
  root: string
  username: string
  password: string
}

export interface SmbConfig {
  host: string
  share: string
  root: string
  username: string
  password: string
}

export interface CloudConfig {
  provider?: CloudProvider
  enabled: boolean
  endpoint: string
  bucket: string
  accessKey: string
  secretKey: string
  region: string
  pollSeconds: number
  webdav?: WebDavConfig
  smb?: SmbConfig
}

export interface CutoutConfig {
  apiKey: string
  kind: string
  timeoutSecs: number
}

export interface CloudNotice {
  orderNumber: string
  newImages: number
  newProductions: number
}

export interface MysqlConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  password: string
  dbname: string
  pollSeconds: number
}

export interface QiniuSettingsInput {
  enabled: boolean
  apiUrl: string
  pollSeconds: number
  token?: string
}

export interface QiniuDevice {
  role: 'customer' | 'production' | 'both'
  workspaceId: string
  deviceId: string
}

export interface QiniuSettings extends Omit<QiniuSettingsInput, 'token'>, Partial<QiniuDevice> {
  hasToken: boolean
}

export interface QiniuStatus extends Partial<QiniuDevice> {
  enabled: boolean
  legacyEnabled: boolean
  active: boolean
  pending: number
  failed: number
  downloading: number
  lastError?: string
}

export interface Production {
  id: string
  orderNumber: string
  imageId: string | null
  filePath: string
  createdAt: string
  originalName?: string
  byteLength?: number
  remoteOnly?: boolean
  syncStatus?: SyncStatus
  syncError?: string
}

export interface PaidanEvent {
  kind: 'ingested' | 'failed'
  orderNumber: string
  imageId?: string
  scaled?: boolean
  detail?: string
}
export type WorkflowRole = 'customer' | 'production' | 'both'

export interface WorkflowSettings {
  role: WorkflowRole
  target: string | null
  storageProvider?: StorageProvider | null
  deviceId?: string
  deviceName?: string
  autoSync?: boolean
  pollSeconds?: number
  quickStartSeen?: boolean
}

export interface WorkflowOrder {
  orderNumber: string
  localCompleted: boolean
  sharedState: 'pending' | 'completed' | null
  pendingOperation: 'finish' | 'publish' | null
  error: string | null
  claimedBy?: string
  claimedName?: string
  claimedAt?: number
  claimedByMe?: boolean
  remoteOperationId?: string | null
  localArchived?: boolean
}

export interface ClaimResponse {
  ok: boolean
  claimedBy?: string
  claimedName?: string
  claimedAt?: number
  message?: string
}

export interface WorkflowPreview {
  reference: string
  orderNumber: string
  updatedAt: string
  localVersion: string | null
  changes: string[]
}

export interface WorkflowResult {
  updated: number
  uploadedOrderNumbers: string[]
  completed: number
  claimsChanged?: number
  templatesUpdated?: number
  shopsChanged?: boolean
  conflicts: WorkflowPreview[]
  errors: string[]
}

export interface Shop {
  id: string
  name: string
  active: boolean
}

export interface ShopCatalog {
  shops: Shop[]
  legacyAssignments: Record<string, string>
  sharedArchives: Record<string, string>
}
