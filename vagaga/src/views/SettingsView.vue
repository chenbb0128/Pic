<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useOrdersStore, toast, loadOrders, refreshQiniuStatus, refreshWorkflowSettings } from '../stores/orders'
import {
  cloudSyncNow,
  cloudTest,
  getCloudConfig,
  getCutoutConfig,
  getMysqlConfig,
  getQiniuSettings,
  mysqlSyncNow,
  mysqlTest,
  openPath,
  qiniuSyncNow,
  saveCloudConfig,
  saveCutoutConfig,
  saveMysqlConfig,
  saveQiniuSettings,
  testQiniuSettings,
  workflowSetRole,
  workflowTest,
} from '../lib/tauri'
import type { CloudConfig, CloudProvider, CutoutConfig, MysqlConfig, QiniuDevice, QiniuSettings, SmbConfig, WebDavConfig, WorkflowRole } from '../types'

defineEmits<{ back: [] }>()

const store = useOrdersStore()
const props = defineProps<{ activeOrder: string | null }>()
const previewFrame = ref<HTMLIFrameElement | null>(null)
const templatePreviews = ref<Record<string, string>>({})
const templatePreviewUrl = new URL('embedded/heart-star/index.html?catalog', document.baseURI).href

function loadTemplatePreviews() {
  const frame = previewFrame.value?.contentWindow as (Window & {
    __picTemplateThumbnail?: (name: string) => Promise<string>
  }) | null
  const getThumbnail = frame?.__picTemplateThumbnail
  if (!getThumbnail) return
  for (const { webId } of store.info?.templates ?? []) {
    if (webId in templatePreviews.value) continue
    void getThumbnail(webId).then(url => { templatePreviews.value[webId] = url }).catch(() => {})
  }
}
const roleBusy = ref(false)
const roleMessage = ref('')
const capabilityBusy = ref(false)
const capabilityMessage = ref('')
const role = ref<WorkflowRole>(store.workflow.role)

async function saveRole() {
  roleBusy.value = true
  roleMessage.value = ''
  try {
    store.workflow = await workflowSetRole(role.value)
    roleMessage.value = '设备角色已保存。'
  } catch (error) {
    roleMessage.value = String(error)
  } finally {
    roleBusy.value = false
  }
}

async function testWorkflow() {
  capabilityBusy.value = true
  capabilityMessage.value = ''
  try {
    const result = await workflowTest()
    capabilityMessage.value = result.message
  } catch (error) {
    capabilityMessage.value = String(error)
  } finally {
    capabilityBusy.value = false
  }
}

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
const qiniuForm = ref({ apiUrl: '', token: '' })
const qiniuMsg = ref('')
const qiniuBusy = ref(false)
const qiniuRoleName: Record<QiniuDevice['role'], string> = {
  customer: '排单',
  production: '制作',
  both: '排单与制作',
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
  qiniuSaved.value?.enabled ? 'qiniu' : cloudSaved.value?.provider ?? (qiniuHasBinding.value ? 'qiniu' : 'minio'),
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
  !qiniuSaved.value?.enabled && cloudSaved.value?.enabled ? cloudSaved.value.provider ?? 'minio' : null,
)
const selectedCloudIsRunning = computed(() =>
  selectedCloudProvider.value !== null && selectedCloudProvider.value === activeCloudProvider.value,
)
const canSaveCloud = computed(() => cloudSaved.value !== null && qiniuSaved.value !== null)
const currentStorage = computed(() => {
  if (!qiniuSaved.value) return '正在读取'
  if (qiniuSaved.value.enabled) return storageNames.qiniu
  if (!cloudSaved.value) return cloudLoadError.value ? '读取失败' : '正在读取'
  return activeCloudProvider.value ? storageNames[activeCloudProvider.value] : '共享存储未启用'
})

const pgc = ref<MysqlConfig>({ enabled: false, host: '', port: 3306, user: '', password: '', dbname: 'vagaga', pollSeconds: 30 })
const mysqlSaved = ref<MysqlConfig | null>(null)
const canSyncMysql = computed(() => {
  const config = mysqlSaved.value
  return Boolean(config?.enabled && config.host.trim() && config.user.trim() && config.dbname.trim()
    && Number.isInteger(config.port) && config.port > 0 && config.port <= 65535)
})
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
  void refreshWorkflowSettings().then(() => { role.value = store.workflow.role }).catch(error => {
    roleMessage.value = String(error)
  })
  void loadQiniuSettings()
  void loadCloudSettings()
  try {
    const config = await getMysqlConfig()
    mysqlSaved.value = config
    pgc.value = { ...config }
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
    qiniuForm.value = { apiUrl: settings.apiUrl, token: '' }
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
    const token = enabled ? qiniuForm.value.token.trim() || undefined : undefined
    const apiUrl = enabled ? qiniuForm.value.apiUrl.trim() : previous.apiUrl
    const saved = await saveQiniuSettings({ enabled, pollSeconds: previous.pollSeconds, apiUrl, token })
    qiniuSaved.value = saved
    if (enabled) qiniuForm.value = { apiUrl: saved.apiUrl, token: '' }
    await refreshWorkflowSettings()
    capabilityMessage.value = ''
    qiniuMsg.value = '七牛设置已保存。'
  })
}

function syncQiniu() {
  return runQiniuAction(async () => {
    if (!confirm('确认从七牛导入旧数据？')) return
    qiniuMsg.value = '正在导入七牛旧数据…'
    const count = await qiniuSyncNow()
    qiniuMsg.value = count ? `已导入 ${count} 条七牛旧数据。` : '没有新的七牛旧数据。'
    await Promise.all([refreshQiniuStatus(), loadOrders()])
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
    const config = { ...pgc.value }
    await saveMysqlConfig(config)
    mysqlSaved.value = config
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
  if (!canSyncMysql.value) return
  pgBusy.value = true
  pgMsg.value = '正在同步…'
  try {
    const result = await mysqlSyncNow(props.activeOrder)
    const conflicts = result.conflicts.length ? '有本机修改的订单，请在「数据同步」中查看。' : ''
    pgMsg.value = [result.errors[0] || '同步完成。', conflicts].filter(Boolean).join(' ')
    await loadOrders()
  } catch (error) {
    pgMsg.value = String(error)
  } finally {
    pgBusy.value = false
  }
}

function cloudDraft(provider: CloudProvider, saved: CloudConfig, form: CloudForm): CloudConfig {
  const { endpoint, bucket, accessKey, secretKey, region, webdav, smb } = form
  const config = { ...saved, provider }
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
  if (action === 'activate' && qiniuSaved.value?.enabled) return

  const preserveActive = action === 'profile' && saved.enabled && provider !== (saved.provider ?? 'minio')
  const config = action === 'pause' ? { ...saved, enabled: false } : {
    ...cloudDraft(provider, saved, form),
    provider: preserveActive ? saved.provider ?? 'minio' : provider,
    enabled: action === 'activate' || saved.enabled,
  }

  return runCloudAction(provider, async () => {
    await saveCloudConfig(config)
    cloudSaved.value = config
    await refreshWorkflowSettings()
    capabilityMessage.value = ''
    const name = storageNames[provider]
    const messages = {
      profile: `${name} 配置已保存。`,
      activate: `配置已保存，正在使用 ${name}。`,
      pause: `已暂停使用 ${name}。`,
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
    if (!confirm('确认从这个存储导入旧数据？')) return
    setCloudMsg(provider, '正在导入旧数据…')
    const notices = await cloudSyncNow()
    const total = notices.reduce((sum, n) => sum + n.newImages, 0)
    setCloudMsg(provider, notices.length
      ? `导入完成，更新 ${notices.length} 个订单，新增 ${total} 张素材。`
      : '导入完成，没有新素材。')
    await loadOrders()
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
              <label for="workflow-role" class="label">设备角色</label>
              <select id="workflow-role" v-model="role" class="input providerSelect" :disabled="roleBusy">
                <option value="customer">排单</option>
                <option value="production">制作</option>
                <option value="both">排单与制作</option>
              </select>
              <button type="button" class="btn" :disabled="roleBusy || role === store.workflow.role" @click="saveRole">保存角色</button>
            </div>
            <div v-if="roleMessage" class="cloudMsg" role="status">{{ roleMessage }}</div>
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
            <label class="row checkRow">
              <input v-model="pgc.enabled" type="checkbox" />
              <span>启用数据同步</span>
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
            </div>
            <div class="row actions">
              <button class="btn" :disabled="pgBusy" @click="savePg">保存</button>
              <button class="btn" :disabled="pgBusy" @click="testPg">测试连接</button>
              <button class="btn" :disabled="pgBusy || !canSyncMysql" @click="syncPgNow">立即同步</button>
            </div>
            <div v-if="pgMsg" class="cloudMsg">{{ pgMsg }}</div>
          </div>

          <div v-show="activeSection === 'storage'" class="card">
            <div class="storageHeading">
              <h3>共享存储</h3>
              <div class="storageStatus" role="status">
                <span class="storageState">当前存储 <strong>{{ currentStorage }}</strong></span>
              </div>
            </div>
            <div class="row actions storageActions">
              <button type="button" class="btn" :disabled="capabilityBusy || !store.workflow.target" @click="testWorkflow">检查协作能力</button>
              <div v-if="capabilityMessage" class="cloudMsg" role="status">{{ capabilityMessage }}</div>
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
                <p v-if="qiniuSaved?.enabled" class="hint">七牛正在使用。可先保存此配置，暂停七牛后再启用。</p>
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
                  </div>
                  <div class="row actions storageActions">
                    <button class="btn" :disabled="cloudBusy" @click="testCloud">测试连接</button>
                    <button class="btn" :disabled="cloudBusy || !canSaveCloud" @click="saveCloud('profile')">保存配置</button>
                    <button v-if="!selectedCloudIsRunning" class="btn" :disabled="cloudBusy || !canSaveCloud || qiniuSaved?.enabled" @click="saveCloud('activate')">保存并启用</button>
                    <template v-else>
                      <button class="btn" :disabled="cloudBusy || !canSaveCloud" @click="saveCloud('pause')">暂停共享存储</button>
                      <button class="btn" :disabled="cloudBusy" @click="syncNow">导入旧数据</button>
                    </template>
                  </div>
                </template>
                <div v-if="cloudLoadError" class="cloudMsg" role="status">{{ cloudLoadError }}</div>
                <div v-else-if="cloudMsg?.provider === selectedCloudProvider" class="cloudMsg" role="status">{{ cloudMsg.text }}</div>
              </template>
              <template v-else-if="storageProvider === 'qiniu'">
                <p class="hint">设备凭证用于连接七牛排单服务。设备角色在「基础信息」中单独设置。</p>
                <div class="formGrid">
                  <label class="row">
                    <span class="label">API 地址</span>
                    <input v-model="qiniuForm.apiUrl" class="input" type="url" placeholder="https://sync.example.com" spellcheck="false" :disabled="qiniuBusy || !qiniuSaved" />
                  </label>
                  <label class="row">
                    <span class="label">设备凭证</span>
                    <input v-model="qiniuForm.token" class="input" type="password" autocomplete="new-password" :placeholder="qiniuSaved?.hasToken ? '已配置，留空沿用' : '输入设备接入凭证'" :disabled="qiniuBusy || !qiniuSaved" />
                  </label>
                </div>
                <div class="row actions">
                  <button class="btn" :disabled="qiniuBusy || !qiniuSaved || !qiniuForm.apiUrl.trim()" @click="testQiniu">测试连接</button>
                  <button class="btn" :disabled="qiniuBusy || !qiniuSaved || !qiniuForm.apiUrl.trim()" @click="saveQiniu(true)">
                    {{ qiniuSaved?.enabled ? '保存七牛配置' : '保存并启用七牛' }}
                  </button>
                  <button v-if="qiniuSaved?.enabled" class="btn" :disabled="qiniuBusy" @click="saveQiniu(false)">暂停使用七牛</button>
                </div>
                <div v-if="qiniuSaved?.hasToken" class="qiniuLegacy">
                  <p v-if="qiniuSaved.role" class="hint">
                    凭证权限 {{ qiniuRoleName[qiniuSaved.role] }}
                    <template v-if="qiniuSaved.workspaceId"> · 空间 {{ qiniuSaved.workspaceId }}</template>
                    <template v-if="qiniuSaved.deviceId"> · 设备 {{ qiniuSaved.deviceId }}</template>
                  </p>
                  <div class="row actions">
                    <button class="btn" :disabled="qiniuBusy" @click="syncQiniu">导入旧数据</button>
                    <button class="btn" :disabled="qiniuBusy || !store.info?.dataRoot" @click="openQiniuLogs">打开日志目录</button>
                  </div>
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
            <h3>制作模板</h3>
            <iframe v-if="activeSection === 'templates' && store.info?.templates.length" ref="previewFrame"
              :src="templatePreviewUrl" title="模板图片生成器" hidden @load="loadTemplatePreviews" />
            <div class="tplList">
              <figure v-for="t in store.info?.templates ?? []" :key="t.code" class="tplCard">
                <div class="tplPreview">
                  <img v-if="templatePreviews[t.webId]" :src="templatePreviews[t.webId]" :alt="t.name" />
                </div>
                <figcaption><span class="code">{{ t.code }}</span> {{ t.name }}</figcaption>
              </figure>
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
.storageHeading, .storageStatus {
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
.qiniuLegacy {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--stroke);
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
  grid-template-columns: repeat(auto-fill, minmax(154px, 1fr));
  gap: 12px;
}
.tplCard {
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--stroke);
  border-radius: 8px;
  background: var(--bg-card);
}
.tplPreview {
  display: grid;
  place-items: center;
  height: 136px;
  padding: 10px;
  background: var(--bg-card-hover);
  border-bottom: 1px solid var(--stroke);
}
.tplPreview img {
  display: block;
  width: 100%;
  height: 116px;
  object-fit: contain;
}
.tplCard figcaption {
  font-size: 12px;
  padding: 8px 10px;
}
.code {
  font-weight: 700;
  color: var(--accent);
  margin-right: 4px;
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
