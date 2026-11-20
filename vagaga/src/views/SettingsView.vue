<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useOrdersStore, toast, loadOrders, refreshQiniuStatus } from '../stores/orders'
import {
  cloudBackfill,
  cloudSyncNow,
  cloudTest,
  getCloudConfig,
  getCutoutConfig,
  getMysqlConfig,
  getQiniuSettings,
  mysqlSyncNow,
  mysqlTest,
  openPath,
  qiniuRetryFailed,
  qiniuSyncNow,
  saveCloudConfig,
  saveCutoutConfig,
  saveMysqlConfig,
  saveQiniuSettings,
  testQiniuSettings,
} from '../lib/tauri'
import type { CloudConfig, CloudProvider, CutoutConfig, MysqlConfig, QiniuDevice, QiniuSettings, SmbConfig, WebDavConfig } from '../types'

defineEmits<{ back: [] }>()

const store = useOrdersStore()

type StorageProvider = CloudProvider | 'qiniu'
const storageTabs = [
  { id: 'object', label: '对象存储' },
  { id: 'private', label: '私有化存储' },
] as const
type StorageGroup = typeof storageTabs[number]['id']

const storageProviders = {
  object: [{ id: 'qiniu', label: '七牛 Kodo' }, { id: 'minio', label: 'MinIO（S3 兼容）' }],
  private: [{ id: 'webdav', label: 'WebDAV' }, { id: 'smb', label: 'SMB（共享文件夹）' }],
} as const

const storageNames: Record<StorageProvider, string> = {
  minio: 'MinIO',
  webdav: 'WebDAV',
  smb: 'SMB',
  qiniu: '七牛 Kodo',
}
const editedStorageGroup = ref<StorageGroup | null>(null)
const editedStorageProviders = ref<Partial<Record<StorageGroup, StorageProvider>>>({})
const qiniuSaved = ref<QiniuSettings | null>(null)
const qiniuForm = ref({ apiUrl: '', pollSeconds: 15, token: '' })
const qiniuMsg = ref('')
const qiniuBusy = ref(false)
const qiniuIsRunning = computed(() => store.qiniu?.enabled === true)
const legacyIsRunning = computed(() => store.qiniu?.legacyEnabled === true)
const qiniuNeedsRestart = computed(() => Boolean(store.qiniu && qiniuSaved.value && (
  qiniuIsRunning.value !== qiniuSaved.value.enabled ||
  legacyIsRunning.value !== (!qiniuSaved.value.enabled && !qiniuSaved.value.hasToken) ||
  (qiniuSaved.value.enabled && store.qiniuSettingsChanged)
)))
const qiniuRestartNote = computed(() => {
  if (!qiniuSaved.value?.enabled) return '重启后暂停七牛同步'
  return qiniuIsRunning.value ? '重启后应用七牛配置' : '重启后使用七牛'
})
const qiniuRoleName: Record<QiniuDevice['role'], string> = {
  customer: '客服',
  production: '制作',
  both: '客服与制作',
}

const emptyWebDav: WebDavConfig = { endpoint: '', root: '', username: '', password: '' }
const emptySmb: SmbConfig = { host: '', share: '', root: '', username: '', password: '' }
type CloudForm = CloudConfig & { webdav: WebDavConfig; smb: SmbConfig }
type CloudSaveAction = 'profile' | 'activate' | 'pause'
const cloud = ref<CloudForm | null>(null)
const cloudSaved = ref<CloudConfig | null>(null)
const cloudLoadError = ref('')
const cloudMsg = ref<{ provider: CloudProvider; text: string } | null>(null)
const cloudBusy = ref(false)
const qiniuHasBinding = computed(() => Boolean(qiniuSaved.value?.enabled || qiniuSaved.value?.hasToken))
const defaultStorageProvider = computed<StorageProvider>(() =>
  qiniuHasBinding.value ? 'qiniu' : cloudSaved.value?.provider ?? 'minio',
)
function storageGroupFor(provider: StorageProvider): StorageGroup {
  return provider === 'qiniu' || provider === 'minio' ? 'object' : 'private'
}

const storageGroup = computed(() => editedStorageGroup.value ?? storageGroupFor(defaultStorageProvider.value))
const storageProvider = computed<StorageProvider>({
  get: () => {
    const group = storageGroup.value
    const provider = defaultStorageProvider.value
    return editedStorageProviders.value[group] ??
      (storageGroupFor(provider) === group ? provider : storageProviders[group][0].id)
  },
  set: (provider: StorageProvider) => { editedStorageProviders.value[storageGroup.value] = provider },
})

function onStorageTabKey(event: KeyboardEvent) {
  const first = storageTabs[0].id
  const last = storageTabs[1].id
  let next: StorageGroup
  if (event.key === 'Home') next = first
  else if (event.key === 'End') next = last
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = storageGroup.value === first ? last : first
  else return
  event.preventDefault()
  if (cloudBusy.value || qiniuBusy.value) return
  editedStorageGroup.value = next
  document.getElementById(`storage-tab-${next}`)?.focus()
}
const selectedCloudProvider = computed(() => storageProvider.value === 'qiniu' ? null : storageProvider.value)
const activeCloudProvider = computed(() =>
  legacyIsRunning.value && cloudSaved.value?.enabled ? cloudSaved.value.provider ?? 'minio' : null,
)
const selectedCloudIsRunning = computed(() =>
  selectedCloudProvider.value !== null && selectedCloudProvider.value === activeCloudProvider.value,
)
const canSaveCloud = computed(() => legacyIsRunning.value && qiniuSaved.value !== null && !qiniuHasBinding.value)
const currentStorage = computed(() => {
  if (!store.qiniu) return '正在读取'
  if (qiniuIsRunning.value) return storageNames.qiniu
  if (!legacyIsRunning.value) return '七牛已暂停'
  if (!cloudSaved.value) return cloudLoadError.value ? '读取失败' : '正在读取'
  return activeCloudProvider.value ? storageNames[activeCloudProvider.value] : '共享存储未启用'
})

const pgc = ref<MysqlConfig>({ enabled: true, host: '192.168.31.200', port: 3306, user: 'root', password: 'admin123', dbname: 'vagaga', pollSeconds: 30 })
const pgMsg = ref('')
const pgBusy = ref(false)

const cutc = ref<CutoutConfig>({ apiKey: '', kind: 'person', timeoutSecs: 90 })
const cutMsg = ref('')
const cutBusy = ref(false)

const sections = [
  { key: 'basics', label: '基础信息' },
  { key: 'mysql', label: 'MySQL 数据库' },
  { key: 'storage', label: '共享存储' },
  { key: 'cutout', label: 'AI 抠图' },
  { key: 'templates', label: '制作模板' },
]
const activeSection = ref('basics')
const sectionsEl = ref<HTMLElement | null>(null)

function goto(key: string) {
  activeSection.value = key
  sectionsEl.value?.scrollTo({ top: 0 })
}

onMounted(async () => {
  void loadQiniuSettings()
  void loadCloudSettings()
  try {
    pgc.value = await getMysqlConfig()
  } catch {
    /* 首次无配置 */
  }
  try {
    cutc.value = await getCutoutConfig()
  } catch {
    /* 首次无配置 */
  }
})

async function loadQiniuSettings() {
  try {
    const settings = await getQiniuSettings()
    qiniuSaved.value = settings
    qiniuForm.value = { apiUrl: settings.apiUrl, pollSeconds: settings.pollSeconds, token: '' }
  } catch (error) {
    qiniuMsg.value = `读取七牛设置失败：${error}`
  }
}

async function loadCloudSettings() {
  try {
    const config = await getCloudConfig()
    cloudSaved.value = config
    cloud.value = {
      ...config,
      webdav: { ...emptyWebDav, ...config.webdav },
      smb: { ...emptySmb, ...config.smb },
    }
  } catch (error) {
    cloudLoadError.value = `读取对象存储配置失败：${error}`
  }
}

async function runQiniuAction(action: () => Promise<void>) {
  qiniuBusy.value = true
  try {
    await action()
  } catch (error) {
    qiniuMsg.value = String(error)
  } finally {
    qiniuBusy.value = false
  }
}

function testQiniu() {
  return runQiniuAction(async () => {
    qiniuMsg.value = '正在检查连接…'
    const result = await testQiniuSettings(qiniuForm.value.apiUrl.trim(), qiniuForm.value.token.trim() || undefined)
    const maxMiB = Number((result.maxFileBytes / (1024 * 1024)).toFixed(1))
    qiniuMsg.value = `连接成功 · ${qiniuRoleName[result.role]} · 空间 ${result.workspaceId} · 设备 ${result.deviceId} · 单文件上限 ${maxMiB} MiB`
  })
}

function saveQiniu(enabled: boolean) {
  return runQiniuAction(async () => {
    const previous = qiniuSaved.value
    if (!previous) return
    const pollSeconds = enabled ? qiniuForm.value.pollSeconds : previous.pollSeconds
    if (!Number.isInteger(pollSeconds) || pollSeconds < 10 || pollSeconds > 60) {
      qiniuMsg.value = '轮询间隔请输入 10 到 60 秒之间的整数。'
      return
    }
    const token = enabled ? qiniuForm.value.token.trim() || undefined : undefined
    const apiUrl = enabled ? qiniuForm.value.apiUrl.trim() : previous.apiUrl
    const saved = await saveQiniuSettings({ enabled, pollSeconds, apiUrl, token })
    if (saved.apiUrl !== previous.apiUrl || saved.pollSeconds !== previous.pollSeconds || token ||
      saved.role !== previous.role || saved.deviceId !== previous.deviceId || saved.workspaceId !== previous.workspaceId) {
      store.qiniuSettingsChanged = true
    }
    qiniuSaved.value = saved
    if (enabled) qiniuForm.value = { apiUrl: saved.apiUrl, pollSeconds: saved.pollSeconds, token: '' }
    qiniuMsg.value = qiniuNeedsRestart.value ? '设置已保存，重启 vagaga 后生效。' : '设置已保存。'
  })
}

function syncQiniu() {
  return runQiniuAction(async () => {
    await qiniuSyncNow()
    qiniuMsg.value = '已通知后台立即同步。'
    await refreshQiniuStatus()
  })
}

function retryQiniu() {
  return runQiniuAction(async () => {
    await qiniuRetryFailed()
    qiniuMsg.value = '已提交失败任务重试。'
    await refreshQiniuStatus()
  })
}

function openQiniuLogs() {
  return runQiniuAction(async () => {
    const dataRoot = store.info?.dataRoot
    if (dataRoot) await openPath(dataRoot)
  })
}

async function savePg() {
  pgBusy.value = true
  try {
    await saveMysqlConfig(JSON.parse(JSON.stringify(pgc.value)))
    pgMsg.value = 'MySQL 配置已保存。'
  } catch (error) {
    pgMsg.value = String(error)
  } finally {
    pgBusy.value = false
  }
}

async function testPg() {
  pgBusy.value = true
  pgMsg.value = '正在测试连接…'
  try {
    pgMsg.value = await mysqlTest(JSON.parse(JSON.stringify(pgc.value)))
    toast('ok', 'MySQL 连接成功')
  } catch (error) {
    pgMsg.value = String(error)
    toast('error', 'MySQL 连接失败')
  } finally {
    pgBusy.value = false
  }
}

async function syncPgNow() {
  pgBusy.value = true
  pgMsg.value = '正在同步…'
  try {
    const notices = await mysqlSyncNow()
    const images = notices.reduce((sum, n) => sum + n.newImages, 0)
    const productions = notices.reduce((sum, n) => sum + n.newProductions, 0)
    pgMsg.value = notices.length
      ? `同步完成：${notices.length} 个订单更新，新增 ${images} 张素材、${productions} 个成品。`
      : '同步完成：远端没有新变化。'
    await loadOrders()
  } catch (error) {
    pgMsg.value = String(error)
  } finally {
    pgBusy.value = false
  }
}

function cloudDraft(provider: CloudProvider, saved: CloudConfig, form: CloudForm): CloudConfig {
  const { endpoint, bucket, accessKey, secretKey, region, pollSeconds, webdav, smb } = form
  const config = { ...saved, provider, pollSeconds }
  switch (provider) {
    case 'minio':
      return { ...config, endpoint, bucket, accessKey, secretKey, region }
    case 'webdav':
      return { ...config, webdav: { ...webdav } }
    case 'smb':
      return { ...config, smb: { ...smb } }
  }
}

function setCloudMsg(provider: CloudProvider, text: string) {
  cloudMsg.value = { provider, text }
}

async function runCloudAction(provider: CloudProvider, action: () => Promise<void>) {
  cloudBusy.value = true
  try {
    await action()
  } catch (error) {
    setCloudMsg(provider, String(error))
  } finally {
    cloudBusy.value = false
  }
}

function saveCloud(action: CloudSaveAction) {
  const provider = selectedCloudProvider.value
  const saved = cloudSaved.value
  const form = cloud.value
  if (!provider || !saved || !form || !canSaveCloud.value) return
  if (action === 'pause' && !selectedCloudIsRunning.value) return

  const preserveActive = action === 'profile' && saved.enabled && !selectedCloudIsRunning.value
  const config = action === 'pause' ? { ...saved, enabled: false } : {
    ...cloudDraft(provider, saved, form),
    provider: preserveActive ? saved.provider ?? 'minio' : provider,
    enabled: action === 'activate' || saved.enabled,
    pollSeconds: preserveActive ? saved.pollSeconds : form.pollSeconds,
  }
  if (action !== 'pause' && !preserveActive && (!Number.isSafeInteger(config.pollSeconds) || config.pollSeconds < 10)) {
    setCloudMsg(provider, '轮询间隔请输入至少 10 秒的整数。')
    return
  }

  return runCloudAction(provider, async () => {
    await saveCloudConfig(config)
    cloudSaved.value = config
    const name = storageNames[provider]
    const messages = {
      profile: `${name} 配置已保存。`,
      activate: `配置已保存，正在使用 ${name}。`,
      pause: `已暂停 ${name} 同步。`,
    }
    setCloudMsg(provider, messages[action])
  })
}

function testCloud() {
  const provider = selectedCloudProvider.value
  const saved = cloudSaved.value
  const form = cloud.value
  if (!provider || !saved || !form) return
  return runCloudAction(provider, async () => {
    setCloudMsg(provider, '正在测试连接…')
    const config = cloudDraft(provider, saved, form)
    try {
      setCloudMsg(provider, await cloudTest(config))
      toast('ok', '云服务连接成功')
    } catch (error) {
      toast('error', '云服务连接失败')
      throw error
    }
  })
}

function syncNow() {
  const provider = selectedCloudProvider.value
  if (!provider || !selectedCloudIsRunning.value) return
  return runCloudAction(provider, async () => {
    setCloudMsg(provider, '正在同步…')
    const notices = await cloudSyncNow()
    const total = notices.reduce((sum, n) => sum + n.newImages, 0)
    setCloudMsg(provider, notices.length
      ? `同步完成，更新 ${notices.length} 个订单，新增 ${total} 张素材。`
      : '同步完成，云端没有新素材。')
    await loadOrders()
  })
}

function backfillCloud() {
  const provider = selectedCloudProvider.value
  if (!selectedCloudIsRunning.value || (provider !== 'webdav' && provider !== 'smb')) return
  return runCloudAction(provider, async () => {
    setCloudMsg(provider, '正在补传历史素材…')
    const count = await cloudBackfill()
    setCloudMsg(provider, count ? `已补传 ${count} 个订单的历史素材。` : '没有需要补传的历史素材。')
  })
}

async function saveCutout() {
  cutBusy.value = true
  try {
    await saveCutoutConfig(JSON.parse(JSON.stringify(cutc.value)))
    toast('ok', 'AI 抠图配置已保存')
    cutMsg.value = '已保存。下次执行 AI 抠图 / 一键去底时按新配置调用。'
  } catch (error) {
    cutMsg.value = String(error)
  } finally {
    cutBusy.value = false
  }
}

async function openCutoutLogs() {
  if (!store.info?.dataRoot) return
  try {
    await openPath(store.info.dataRoot)
  } catch (error) {
    cutMsg.value = `打开日志目录失败：${error}`
  }
}
</script>

<template>
  <div class="wrap">
    <div class="panel glass">
      <header class="settingsHeader">
        <button type="button" class="back" aria-label="返回订单" @click="$emit('back')">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M13 8H3m0 0 4-4M3 8l4 4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          返回
        </button>
        <h2>设置</h2>
      </header>
      <div class="layout">
        <nav class="nav" aria-label="设置栏目">
          <button
            v-for="s in sections"
            :key="s.key"
            class="navBtn"
            :class="{ on: activeSection === s.key }"
            :aria-current="activeSection === s.key ? 'true' : undefined"
            @click="goto(s.key)"
          >{{ s.label }}</button>
        </nav>

        <div class="sections" ref="sectionsEl">
          <div v-show="activeSection === 'basics'" class="card">
            <h3>基础信息</h3>
            <div class="row">
              <span class="label">数据目录</span>
              <span class="value">{{ store.info?.dataRoot ?? '-' }}</span>
            </div>
            <div class="row">
              <span class="label">千帆 CDP 端口</span>
              <span class="value">{{ store.info?.cdpPort ?? '-' }}</span>
            </div>
            <div class="row">
              <span class="label">注入器</span>
              <span class="value">每 3 秒扫描工作台页面，自动接入新开账号 tab</span>
            </div>
          </div>

          <div v-show="activeSection === 'mysql'" class="card">
            <h3>MySQL 数据库</h3>
            <p class="hint">客户端直连时，同步订单信息和导出的成品。</p>
            <p v-if="qiniuIsRunning" class="hint">当前使用七牛同步，订单数据库由排单服务配置。</p>
            <p v-else-if="store.qiniu && !legacyIsRunning" class="hint">七牛同步已暂停，客户端的 MySQL 同步也已暂停。</p>
            <label class="row checkRow">
              <input v-model="pgc.enabled" type="checkbox" />
              <span>启用 MySQL 同步</span>
            </label>
            <div class="formGrid">
              <div class="row">
                <span class="label">主机</span>
                <input v-model="pgc.host" class="input" placeholder="192.168.31.200" spellcheck="false" />
              </div>
              <div class="row">
                <span class="label">端口</span>
                <input v-model.number="pgc.port" class="input narrow" type="number" placeholder="3306" />
              </div>
              <div class="row">
                <span class="label">用户名</span>
                <input v-model="pgc.user" class="input" placeholder="root" spellcheck="false" />
              </div>
              <div class="row">
                <span class="label">密码</span>
                <input v-model="pgc.password" class="input" type="password" placeholder="数据库密码" />
              </div>
              <div class="row">
                <span class="label">数据库</span>
                <input v-model="pgc.dbname" class="input" placeholder="vagaga" spellcheck="false" />
              </div>
              <div class="row">
                <span class="label">轮询间隔(秒)</span>
                <input v-model.number="pgc.pollSeconds" class="input narrow" type="number" min="10" step="5" />
              </div>
            </div>
            <div class="row actions">
              <button class="btn" :disabled="pgBusy" @click="savePg">保存</button>
              <button class="btn" :disabled="pgBusy" @click="testPg">测试连接</button>
              <button class="btn" :disabled="pgBusy || !legacyIsRunning" @click="syncPgNow">立即同步</button>
            </div>
            <div v-if="pgMsg" class="cloudMsg">{{ pgMsg }}</div>
          </div>

          <div v-show="activeSection === 'storage'" class="card">
            <div class="storageHeading">
              <h3>共享存储</h3>
              <div class="storageStatus" role="status">
                <span class="storageState">当前存储 <strong>{{ currentStorage }}</strong></span>
                <span v-if="qiniuNeedsRestart" class="restartNote">{{ qiniuRestartNote }}</span>
              </div>
            </div>
            <div class="storageTabs" role="tablist" aria-label="共享存储类型" @keydown="onStorageTabKey">
              <button
                v-for="tab in storageTabs"
                :id="`storage-tab-${tab.id}`"
                :key="tab.id"
                type="button"
                class="storageTab"
                role="tab"
                aria-controls="storage-provider-panel"
                :aria-selected="storageGroup === tab.id"
                :tabindex="storageGroup === tab.id ? 0 : -1"
                :disabled="cloudBusy || qiniuBusy"
                @click="editedStorageGroup = tab.id"
              >{{ tab.label }}</button>
            </div>
            <div id="storage-provider-panel" role="tabpanel" :aria-labelledby="`storage-tab-${storageGroup}`">
              <label class="row">
                <span class="label">存储类型</span>
                <select v-model="storageProvider" class="input providerSelect" :disabled="cloudBusy || qiniuBusy">
                  <option v-for="provider in storageProviders[storageGroup]" :key="provider.id" :value="provider.id">
                    {{ provider.label }}
                  </option>
                </select>
              </label>

              <template v-if="selectedCloudProvider">
                <p v-if="qiniuHasBinding" class="hint">此数据目录已绑定七牛。重启后如需使用 {{ storageNames[selectedCloudProvider] }}，请使用独立的数据目录。</p>
                <p v-else-if="!selectedCloudIsRunning" class="hint">可先保存连接配置，点击「保存并启用」后切换当前存储。</p>
                <template v-if="cloud">
                  <p v-if="selectedCloudProvider === 'minio'" class="hint">客服机与制作机共用一个 MinIO Bucket，同步素材和订单清单。</p>
                  <div class="formGrid">
                    <template v-if="selectedCloudProvider === 'minio'">
                      <label class="row">
                        <span class="label">端点</span>
                        <input v-model="cloud.endpoint" class="input" placeholder="http://your-minio.example.com:9000" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">Bucket</span>
                        <input v-model="cloud.bucket" class="input" placeholder="vagaga" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">Access Key</span>
                        <input v-model="cloud.accessKey" class="input" placeholder="MinIO Access Key" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">Secret Key</span>
                        <input v-model="cloud.secretKey" class="input" type="password" placeholder="MinIO Secret Key" autocomplete="new-password" />
                      </label>
                      <label class="row">
                        <span class="label">Region</span>
                        <input v-model="cloud.region" class="input" placeholder="us-east-1" spellcheck="false" />
                      </label>
                    </template>
                    <template v-else-if="selectedCloudProvider === 'webdav'">
                      <label class="row">
                        <span class="label">WebDAV 地址</span>
                        <input v-model.trim="cloud.webdav.endpoint" class="input" type="url" placeholder="https://nas.example.com/dav" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">同步目录</span>
                        <input v-model.trim="cloud.webdav.root" class="input" placeholder="相对目录，留空使用 WebDAV 根目录" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">用户名</span>
                        <input v-model="cloud.webdav.username" class="input" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">密码</span>
                        <input v-model="cloud.webdav.password" class="input" type="password" autocomplete="new-password" />
                      </label>
                    </template>
                    <template v-else>
                      <label class="row">
                        <span class="label">服务器</span>
                        <input v-model.trim="cloud.smb.host" class="input" placeholder="nas.example.com" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">共享名</span>
                        <input v-model.trim="cloud.smb.share" class="input" placeholder="例如 images" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">同步目录</span>
                        <input v-model.trim="cloud.smb.root" class="input" placeholder="相对目录，留空使用共享根目录" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">用户名</span>
                        <input v-model="cloud.smb.username" class="input" spellcheck="false" />
                      </label>
                      <label class="row">
                        <span class="label">密码</span>
                        <input v-model="cloud.smb.password" class="input" type="password" autocomplete="new-password" />
                      </label>
                    </template>
                    <label class="row">
                      <span class="label">轮询间隔（秒）</span>
                      <input v-model.number="cloud.pollSeconds" class="input narrow" type="number" min="10" step="1" />
                    </label>
                  </div>
                  <p v-if="canSaveCloud && activeCloudProvider && !selectedCloudIsRunning" class="hint">切换到 {{ storageNames[selectedCloudProvider] }} 后应用此轮询间隔。</p>
                  <div class="row actions storageActions">
                    <button class="btn" :disabled="cloudBusy" @click="testCloud">测试连接</button>
                    <button class="btn" :disabled="cloudBusy || !canSaveCloud" @click="saveCloud('profile')">保存配置</button>
                    <button v-if="!selectedCloudIsRunning" class="btn" :disabled="cloudBusy || !canSaveCloud" @click="saveCloud('activate')">保存并启用</button>
                    <template v-else>
                      <button class="btn" :disabled="cloudBusy || !canSaveCloud" @click="saveCloud('pause')">暂停同步</button>
                      <button class="btn" :disabled="cloudBusy" @click="syncNow">立即同步</button>
                      <button v-if="selectedCloudProvider !== 'minio'" class="btn" :disabled="cloudBusy" @click="backfillCloud">补传历史素材</button>
                    </template>
                  </div>
                </template>
                <div v-if="cloudLoadError" class="cloudMsg" role="status">{{ cloudLoadError }}</div>
                <div v-else-if="cloudMsg?.provider === selectedCloudProvider" class="cloudMsg" role="status">{{ cloudMsg.text }}</div>
              </template>
              <template v-else-if="storageProvider === 'qiniu'">
                <p class="hint">通过排单服务同步原图和成品，客服和制作权限由设备凭证决定。</p>
                <div class="formGrid">
                  <label class="row">
                    <span class="label">API 地址</span>
                    <input v-model="qiniuForm.apiUrl" class="input" type="url" placeholder="https://sync.example.com" spellcheck="false" :disabled="qiniuBusy || !qiniuSaved" />
                  </label>
                  <label class="row">
                    <span class="label">设备凭证</span>
                    <input v-model="qiniuForm.token" class="input" type="password" autocomplete="new-password" :placeholder="qiniuSaved?.hasToken ? '已配置，留空沿用' : '输入设备接入凭证'" :disabled="qiniuBusy || !qiniuSaved" />
                  </label>
                  <label class="row">
                    <span class="label">轮询间隔（秒）</span>
                    <input v-model.number="qiniuForm.pollSeconds" class="input narrow" type="number" min="10" max="60" step="1" :disabled="qiniuBusy || !qiniuSaved" />
                  </label>
                </div>
                <div class="row actions">
                  <button class="btn" :disabled="qiniuBusy || !qiniuSaved || !qiniuForm.apiUrl.trim()" @click="testQiniu">测试连接</button>
                  <button class="btn" :disabled="qiniuBusy || !qiniuSaved || !qiniuForm.apiUrl.trim()" @click="saveQiniu(true)">
                    {{ qiniuSaved?.enabled ? '保存七牛配置' : '保存并启用七牛' }}
                  </button>
                  <button v-if="qiniuSaved?.enabled" class="btn" :disabled="qiniuBusy" @click="saveQiniu(false)">暂停七牛同步</button>
                </div>
                <div v-if="store.qiniu?.enabled" class="qiniuQueue">
                  <p v-if="store.qiniu.role" class="hint">
                    {{ qiniuRoleName[store.qiniu.role] }}
                    <template v-if="store.qiniu.workspaceId"> · 空间 {{ store.qiniu.workspaceId }}</template>
                    <template v-if="store.qiniu.deviceId"> · 设备 {{ store.qiniu.deviceId }}</template>
                  </p>
                  <p v-else class="hint">等待设备接入</p>
                  <p class="queueCounts">
                    <span>{{ store.qiniu.active ? '同步中' : '后台待命' }}</span>
                    <span>待处理 {{ store.qiniu.pending }}</span>
                    <span>下载中 {{ store.qiniu.downloading }}</span>
                    <span :class="{ qiniuError: store.qiniu.failed > 0 }">失败 {{ store.qiniu.failed }}</span>
                  </p>
                  <p v-if="store.qiniu.lastError" class="hint qiniuError">最近错误：{{ store.qiniu.lastError }}</p>
                  <div class="row actions">
                    <button class="btn" :disabled="qiniuBusy" @click="syncQiniu">立即同步</button>
                    <button class="btn" :disabled="qiniuBusy || !store.qiniu.failed" @click="retryQiniu">重试失败任务</button>
                    <button class="btn" :disabled="qiniuBusy || !store.info?.dataRoot" @click="openQiniuLogs">打开日志目录</button>
                  </div>
                  <p class="hint logHint">七牛同步日志为 qiniu-sync.log。</p>
                </div>
                <div v-if="qiniuMsg" class="cloudMsg" role="status">{{ qiniuMsg }}</div>
              </template>
            </div>
          </div>

          <div v-show="activeSection === 'cutout'" class="card">
            <h3>AI 抠图（PicWish）</h3>
            <p class="hint">
              「AI 抠图」「一键去底」共用此配置：识别类型决定抠图的主体；
              API Key 留空时使用内置默认（也可用环境变量 PIC_PICWISH_API_KEY 覆盖）。
            </p>
            <div class="row">
              <span class="label">识别类型</span>
              <select v-model="cutc.kind" class="input">
                <option value="person">人物（买家照片主体）</option>
                <option value="product">商品（物件主体）</option>
              </select>
            </div>
            <div class="row">
              <span class="label">API Key</span>
              <input v-model="cutc.apiKey" class="input" type="password" placeholder="留空使用内置默认 Key" />
            </div>
            <div class="row">
              <span class="label">超时(秒)</span>
              <input v-model.number="cutc.timeoutSecs" class="input narrow" type="number" min="30" step="10" />
            </div>
            <div class="row actions">
              <button class="btn" :disabled="cutBusy" @click="saveCutout">保存</button>
              <button class="btn" :disabled="!store.info?.dataRoot" @click="openCutoutLogs">打开日志目录</button>
            </div>
            <p class="hint">抠图日志为目录中的 cutout.log，记录每张照片的缓存命中、接口状态、处理与下载耗时、失败原因。批量逐张处理，全部完成后统一更新画板。</p>
            <div v-if="cutMsg" class="cloudMsg">{{ cutMsg }}</div>
          </div>

          <div v-show="activeSection === 'templates'" class="card">
            <h3>制作模板（只读）</h3>
            <div class="tplList">
              <div v-for="t in store.info?.templates ?? []" :key="t.code" class="tplRow">
                <span class="code">{{ t.code }}</span>
                <span>{{ t.name }}</span>
                <span class="dim">{{ t.webId }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  padding: 10px 12px 12px;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.settingsHeader {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  padding: 10px 14px;
  border-bottom: 1px solid var(--stroke);
}
h2 {
  margin: 0;
  font-size: 18px;
}
.layout {
  display: grid;
  grid-template-columns: clamp(122px, 12vw, 154px) minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 8px;
  border-right: 1px solid var(--stroke);
}
.navBtn {
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}
.navBtn:hover {
  background: var(--bg-card-hover);
  color: var(--text);
}
.navBtn.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.sections {
  overflow: auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 12px;
  min-height: 0;
}
.card {
  border: 1px solid var(--stroke);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  background: transparent;
  flex-shrink: 0;
}
.card h3 {
  margin: 0 0 10px;
  font-size: 14px;
}
.formGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: clamp(16px, 2vw, 30px);
}
.row {
  display: flex;
  min-width: 0;
  gap: 10px;
  padding: 4px 0;
  align-items: center;
}
.label {
  width: 100px;
  flex-shrink: 0;
  color: var(--text-dim);
}
.value {
  word-break: break-all;
}
.hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.7;
}
.checkRow {
  cursor: pointer;
}
.input {
  flex: 1;
  min-width: 0;
  background: var(--bg-input);
  border: 1px solid var(--stroke);
  border-radius: 8px;
  color: var(--text);
  padding: 6px 10px;
  font-size: 12px;
  outline: none;
}
.input:focus {
  border-color: var(--accent);
}
.input.narrow {
  flex: 0 0 90px;
}
.actions {
  gap: 8px;
  padding-top: 10px;
}
.storageActions {
  flex-wrap: wrap;
}
.storageHeading, .storageStatus, .queueCounts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
}
.storageHeading {
  justify-content: space-between;
  margin-bottom: 10px;
}
.storageHeading h3 {
  margin: 0;
}
.storageState {
  color: var(--text-dim);
  font-size: 12px;
}
.storageState strong {
  margin-left: 4px;
  color: var(--text);
}
.storageTabs {
  display: flex;
  gap: 20px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--stroke);
}
.storageTab {
  margin-bottom: -1px;
  padding: 7px 3px 9px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.storageTab:hover:not(:disabled) {
  color: var(--text);
}
.storageTab[aria-selected="true"] {
  color: var(--accent);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
.storageTab:disabled {
  cursor: default;
}
.providerSelect {
  max-width: 270px;
}
.queueCounts {
  margin: 0 0 8px;
}
.restartNote {
  padding: 2px 8px;
  border-radius: 6px;
  background: #fff4dc;
  color: #81500c;
  font-size: 11px;
}
.qiniuQueue {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--stroke);
}
.qiniuError {
  color: var(--danger);
  overflow-wrap: anywhere;
}
.logHint {
  margin: 4px 0 0;
}
.btn {
  border: 1px solid var(--stroke);
  background: var(--bg-card);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 16px;
  cursor: pointer;
  font-size: 12px;
}
.btn:hover:not(:disabled) {
  background: var(--bg-card-hover);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.cloudMsg {
  font-size: 11px;
  color: var(--text-dim);
  padding: 6px 0;
  word-break: break-all;
}
.tplList {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
}
.tplRow {
  display: flex;
  gap: 8px;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--stroke);
}
.code {
  font-weight: 700;
  color: #9db9ff;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--stroke);
  background: var(--bg-card);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.back:hover {
  background: var(--bg-card-hover);
}
.back:focus-visible, .storageTab:focus-visible, .navBtn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 960px) {
  .formGrid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 620px) {
  .wrap {
    padding: 6px;
  }
  .layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .nav {
    flex-direction: row;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--stroke);
    padding-block: 6px;
  }
  .navBtn {
    white-space: nowrap;
  }
  .sections {
    padding: 8px;
  }
}
</style>
