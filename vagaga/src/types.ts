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
  templates: TemplateQty[]
  sourceQuality?: SourceQuality
  syncStatus?: SyncStatus
  syncError?: string
}

export interface OrderSummary {
  id: string
  orderNumber: string
  imageCount: number
  taskCount: number
  createdAt: string
  updatedAt: string
  metadata: string | null
}

export interface OrderDetail {
  id: string
  orderNumber: string
  createdAt: string
  updatedAt: string
  images: OrderImage[]
}

export interface TemplateInfo {
  code: string
  name: string
  webId: string
}

export interface AppInfo {
  dataRoot: string
  cdpPort: number
  templates: TemplateInfo[]
}

export interface CloudConfig {
  enabled: boolean
  endpoint: string
  bucket: string
  accessKey: string
  secretKey: string
  region: string
  pollSeconds: number
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
