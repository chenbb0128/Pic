<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowLeft, ClipboardList, Cloud, Database, FlaskConical, FolderNetwork, HardDrive, Layers, Package, Scissors, Server, Settings2, User, Workflow } from '@lucide/vue'
import OptionSelect from '../components/OptionSelect.vue'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
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
} from '../lib/tauri'
import type { CloudConfig, CloudProvider, CutoutConfig, MysqlConfig, QiniuDevice, QiniuSettings, SmbConfig, StorageProvider, WebDavConfig, WorkflowRole } from '../types'

defineEmits<{ back: [] }>()

const store = useOrdersStore()
const props = defineProps<{ activeOrder: string | null }>()
const roleBusy = ref(false)
const roleMessage = ref('')
const role = ref<WorkflowRole>(store.workflow.role)
const roles = [
  { id: 'customer', label: '排单', detail: '接收千帆订单并上传', icon: ClipboardList },
  { id: 'production', label: '制作', detail: '同步共享订单并制作', icon: Layers },
  { id: 'both', label: '排单与制作', detail: '在这台设备上完成整个流程', icon: Workflow },
] as const
const cutoutKinds = [
  { id: 'person', label: '人物', detail: '保留照片中的人物主体', icon: User },
  { id: 'product', label: '商品', detail: '保留照片中的物件主体', icon: Package },
] as const

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

const storageTabs = [
  { id: 'object', label: '对象存储' },
  { id: 'private', label: '私有化存储' },
] as const
type StorageGroup = typeof storageTabs[number]['id']

const storageProviders = {
  object: [
    { id: 'qiniu', label: '七牛 Kodo', detail: '使用设备凭证连接七牛空间', icon: Cloud },
    { id: 'minio', label: 'MinIO（S3 兼容）', detail: '使用 S3 端点与访问密钥', icon: Server },
  ],
  private: [
    { id: 'webdav', label: 'WebDAV', detail: '通过 HTTP(S) 访问远程目录', icon: FolderNetwork },
    { id: 'smb', label: 'SMB（共享文件夹）', detail: '访问 NAS 或 Windows 共享目录', icon: HardDrive },
  ],
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
const cloud = ref<CloudForm | null>(null)
const cloudSaved = ref<CloudConfig | null>(null)
const cloudLoadError = ref('')
const cloudMsg = ref<{ provider: CloudProvider; text: string } | null>(null)
const cloudBusy = ref(false)
const storageBusy = computed(() => cloudBusy.value || qiniuBusy.value)
const defaultStorageProvider = computed<StorageProvider>(() =>
  store.workflow.storageProvider ?? cloudSaved.value?.provider ?? 'minio',
)
function storageGroupFor(provider: StorageProvider): StorageGroup {
  return provider === 'qiniu' || provider === 'minio' ? 'object' : 'private'
}

const storageGroup = computed(() => editedStorageGroup.value ?? storageGroupFor(defaultStorageProvider.value))
const storageProvider = computed<StorageProvider>(() => {
  const group = storageGroup.value
  const provider = defaultStorageProvider.value
  return editedStorageProviders.value[group] ??
    (storageGroupFor(provider) === group ? provider : storageProviders[group][0].id)
})
function selectStorageGroup(group: unknown) {
  if (!storageBusy.value && (group === 'object' || group === 'private')) {
    editedStorageGroup.value = group
  }
}

function selectStorageProvider(value: unknown) {
  const group = storageGroup.value
  const provider = storageProviders[group].find(option => option.id === value)
  if (provider && !storageBusy.value) editedStorageProviders.value[group] = provider.id
}
const selectedCloudProvider = computed(() => storageProvider.value === 'qiniu' ? null : storageProvider.value)
const selectedCloudIsRunning = computed(() =>
  selectedCloudProvider.value !== null && selectedCloudProvider.value === store.workflow.storageProvider,
)
const currentStorage = computed(() => {
  const provider = store.workflow.storageProvider
  return provider ? storageNames[provider] : '未配置'
})

const mysqlForm = ref<MysqlConfig>({ enabled: false, host: '', port: 3306, user: '', password: '', dbname: 'vagaga', pollSeconds: 30 })
const mysqlSaved = ref<MysqlConfig | null>(null)
const canSyncMysql = computed(() => {
  const config = mysqlSaved.value
  return store.workflow.role !== 'customer' && Boolean(config && mysqlConfigured(config))
})
const mysqlMessage = ref('')
const mysqlBusy = ref(false)

function mysqlConfigured(config: MysqlConfig) {
  return config.host.trim() && config.user.trim() && config.dbname.trim()
    && Number.isInteger(config.port) && config.port > 0 && config.port <= 65535
}

const cutc = ref<CutoutConfig>({ apiKey: '', kind: 'person', timeoutSecs: 90 })
const cutMsg = ref('')
const cutBusy = ref(false)

const sections = [
  { key: 'basics', label: '基础信息', icon: Settings2 },
  { key: 'database', label: '共享数据库', icon: Database },
  { key: 'storage', label: '共享存储', icon: Cloud },
  { key: 'cutout', label: 'AI 抠图', icon: Scissors },
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
    mysqlForm.value = { ...config }
  } catch (error) {
    mysqlMessage.value = `读取共享数据库配置失败：${error}`
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

function saveQiniu() {
  return runQiniuAction(async () => {
    const previous = qiniuSaved.value
    if (!previous) return
    const token = qiniuForm.value.token.trim() || undefined
    const apiUrl = qiniuForm.value.apiUrl.trim()
    const saved = await saveQiniuSettings({ enabled: true, pollSeconds: previous.pollSeconds, apiUrl, token })
    qiniuSaved.value = saved
    qiniuForm.value = { apiUrl: saved.apiUrl, token: '' }
    await refreshWorkflowSettings()
    qiniuMsg.value = '已保存，上传和同步将使用七牛 Kodo。'
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

async function saveMysql() {
  const saved = mysqlSaved.value
  if (!saved || mysqlBusy.value) return
  const config = { ...mysqlForm.value, enabled: true }
  if (!mysqlConfigured(config)) {
    mysqlMessage.value = '请填写主机、端口、用户名和数据库名。'
    return
  }
  mysqlBusy.value = true
  try {
    await saveMysqlConfig(config)
    mysqlSaved.value = config
    mysqlMessage.value = 'MySQL 配置已保存。'
  } catch (error) {
    mysqlMessage.value = String(error)
  } finally {
    mysqlBusy.value = false
  }
}

async function testMysql() {
  mysqlBusy.value = true
  mysqlMessage.value = '正在测试连接…'
  try {
    mysqlMessage.value = await mysqlTest({ ...mysqlForm.value })
  } catch (error) {
    mysqlMessage.value = String(error)
  } finally {
    mysqlBusy.value = false
  }
}

async function syncMysql() {
  if (!canSyncMysql.value) return
  mysqlBusy.value = true
  mysqlMessage.value = '正在同步…'
  try {
    const result = await mysqlSyncNow(props.activeOrder)
    const conflicts = result.conflicts.length ? '有本机修改的订单，请在订单页点击「同步」查看。' : ''
    mysqlMessage.value = [result.errors[0] || '同步完成。', conflicts].filter(Boolean).join(' ')
    await loadOrders()
  } catch (error) {
    mysqlMessage.value = String(error)
  } finally {
    mysqlBusy.value = false
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

function saveCloud() {
  const provider = selectedCloudProvider.value
  const saved = cloudSaved.value
  const form = cloud.value
  if (!provider || !saved || !form) return
  const config = { ...cloudDraft(provider, saved, form), enabled: true }

  return runCloudAction(provider, async () => {
    await saveCloudConfig(config)
    cloudSaved.value = config
    await refreshWorkflowSettings()
    setCloudMsg(provider, `已保存，上传和同步将使用 ${storageNames[provider]}。`)
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
        <Button type="button" variant="outline" size="sm" aria-label="返回订单" @click="$emit('back')">
          <ArrowLeft aria-hidden="true" />
          返回
        </Button>
        <h2>设置</h2>
      </header>
      <div class="layout">
        <nav class="nav" aria-label="设置栏目">
          <Button
            v-for="s in sections"
            :key="s.key"
            type="button"
            variant="ghost"
            class="justify-start text-muted-foreground aria-[current=true]:bg-primary/10 aria-[current=true]:text-primary"
            :aria-current="activeSection === s.key ? 'true' : undefined"
            @click="goto(s.key)"
          ><component :is="s.icon" aria-hidden="true" />{{ s.label }}</Button>
        </nav>

        <div class="sections" ref="sectionsEl">
          <div v-show="activeSection === 'basics'" class="card">
            <h3>基础信息</h3>
            <div class="row">
              <Label for="workflow-role" class="label">设备角色</Label>
              <OptionSelect id="workflow-role" v-model="role" :options="roles" class="w-full max-w-64" :disabled="roleBusy" />
              <Button type="button" :disabled="roleBusy || role === store.workflow.role" @click="saveRole">保存角色</Button>
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

          <div v-show="activeSection === 'database'" class="card">
            <h3>共享数据库</h3>
            <div class="row">
              <span class="label">数据库类型</span>
              <span class="inline-flex h-9 items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-2.5 font-medium text-primary">
                <Database class="size-4" aria-hidden="true" /> MySQL
              </span>
            </div>
            <div class="formGrid">
              <label class="row">
                <span class="label">主机</span>
                <Input v-model.trim="mysqlForm.host" class="flex-1" placeholder="192.168.31.200" spellcheck="false" :disabled="mysqlBusy" />
              </label>
              <label class="row">
                <span class="label">端口</span>
                <Input v-model.number="mysqlForm.port" class="w-24" type="number" min="1" max="65535" placeholder="3306" :disabled="mysqlBusy" />
              </label>
              <label class="row">
                <span class="label">用户名</span>
                <Input v-model="mysqlForm.user" class="flex-1" placeholder="root" spellcheck="false" :disabled="mysqlBusy" />
              </label>
              <label class="row">
                <span class="label">密码</span>
                <Input v-model="mysqlForm.password" class="flex-1" type="password" placeholder="数据库密码" autocomplete="new-password" :disabled="mysqlBusy" />
              </label>
              <label class="row">
                <span class="label">数据库</span>
                <Input v-model="mysqlForm.dbname" class="flex-1" placeholder="vagaga" spellcheck="false" :disabled="mysqlBusy" />
              </label>
            </div>
            <div class="row actions">
              <Button type="button" :disabled="mysqlBusy || !mysqlSaved" @click="saveMysql()">保存配置</Button>
              <Button type="button" variant="outline" :disabled="mysqlBusy" @click="testMysql"><FlaskConical aria-hidden="true" />测试连接</Button>
              <Button v-if="store.workflow.role !== 'customer'" type="button" variant="outline" :disabled="mysqlBusy || !canSyncMysql" @click="syncMysql">立即同步</Button>
            </div>
            <div v-if="mysqlMessage" class="cloudMsg" role="status">{{ mysqlMessage }}</div>
          </div>

          <div v-show="activeSection === 'storage'" class="card">
            <div class="storageHeading">
              <h3>共享存储</h3>
              <div class="storageStatus" role="status">
                <span class="storageState">当前存储 <strong>{{ currentStorage }}</strong></span>
              </div>
            </div>
            <Tabs :model-value="storageGroup" @update:model-value="selectStorageGroup">
              <TabsList aria-label="共享存储类型">
                <TabsTrigger
                  v-for="tab in storageTabs"
                  :key="tab.id"
                  :value="tab.id"
                  :disabled="storageBusy"
                  class="bg-transparent px-4 text-[13px] data-[state=active]:text-primary"
                >{{ tab.label }}</TabsTrigger>
              </TabsList>
              <TabsContent v-for="tab in storageTabs" :key="tab.id" :value="tab.id">
                <template v-if="storageGroup === tab.id">
                  <div class="row">
                    <Label for="storage-provider" class="storageFieldLabel">存储类型</Label>
                    <OptionSelect
                      id="storage-provider"
                      :model-value="storageProvider"
                      :options="storageProviders[storageGroup]"
                      class="w-full max-w-[320px]"
                      :disabled="storageBusy"
                      @update:model-value="selectStorageProvider"
                    />
                  </div>
                  <template v-if="selectedCloudProvider">
                    <template v-if="cloud">
                      <p v-if="selectedCloudProvider === 'minio'" class="hint">排单端与制作端共用一个 MinIO Bucket，存放原图和成品。</p>
                      <div class="formGrid">
                        <template v-if="selectedCloudProvider === 'minio'">
                          <div class="row">
                            <Label for="storage-cloud-endpoint" class="storageFieldLabel">端点</Label>
                            <Input id="storage-cloud-endpoint" v-model="cloud.endpoint" class="flex-1 bg-background text-[13px] md:text-[13px]" placeholder="http://your-minio.example.com:9000" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-bucket" class="storageFieldLabel">Bucket</Label>
                            <Input id="storage-cloud-bucket" v-model="cloud.bucket" class="flex-1 bg-background text-[13px] md:text-[13px]" placeholder="vagaga" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-access-key" class="storageFieldLabel">Access Key</Label>
                            <Input id="storage-cloud-access-key" v-model="cloud.accessKey" class="flex-1 bg-background text-[13px] md:text-[13px]" placeholder="MinIO Access Key" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-secret-key" class="storageFieldLabel">Secret Key</Label>
                            <Input id="storage-cloud-secret-key" v-model="cloud.secretKey" class="flex-1 bg-background text-[13px] md:text-[13px]" type="password" placeholder="MinIO Secret Key" autocomplete="new-password" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-region" class="storageFieldLabel">Region</Label>
                            <Input id="storage-cloud-region" v-model="cloud.region" class="flex-1 bg-background text-[13px] md:text-[13px]" placeholder="us-east-1" spellcheck="false" :disabled="storageBusy" />
                          </div>
                        </template>
                        <template v-else-if="selectedCloudProvider === 'webdav'">
                          <div class="row">
                            <Label for="storage-cloud-webdav-endpoint" class="storageFieldLabel">WebDAV 地址</Label>
                            <Input id="storage-cloud-webdav-endpoint" v-model.trim="cloud.webdav.endpoint" class="flex-1 bg-background text-[13px] md:text-[13px]" type="url" placeholder="https://nas.example.com/dav" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-webdav-root" class="storageFieldLabel">同步目录</Label>
                            <Input id="storage-cloud-webdav-root" v-model.trim="cloud.webdav.root" class="flex-1 bg-background text-[13px] md:text-[13px]" placeholder="相对目录，留空使用 WebDAV 根目录" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-webdav-username" class="storageFieldLabel">用户名</Label>
                            <Input id="storage-cloud-webdav-username" v-model="cloud.webdav.username" class="flex-1 bg-background text-[13px] md:text-[13px]" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-webdav-password" class="storageFieldLabel">密码</Label>
                            <Input id="storage-cloud-webdav-password" v-model="cloud.webdav.password" class="flex-1 bg-background text-[13px] md:text-[13px]" type="password" autocomplete="new-password" :disabled="storageBusy" />
                          </div>
                        </template>
                        <template v-else>
                          <div class="row">
                            <Label for="storage-cloud-smb-host" class="storageFieldLabel">服务器</Label>
                            <Input id="storage-cloud-smb-host" v-model.trim="cloud.smb.host" class="flex-1 bg-background text-[13px] md:text-[13px]" placeholder="nas.example.com" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-smb-share" class="storageFieldLabel">共享名</Label>
                            <Input id="storage-cloud-smb-share" v-model.trim="cloud.smb.share" class="flex-1 bg-background text-[13px] md:text-[13px]" placeholder="例如 images" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-smb-root" class="storageFieldLabel">同步目录</Label>
                            <Input id="storage-cloud-smb-root" v-model.trim="cloud.smb.root" class="flex-1 bg-background text-[13px] md:text-[13px]" placeholder="相对目录，留空使用共享根目录" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-smb-username" class="storageFieldLabel">用户名</Label>
                            <Input id="storage-cloud-smb-username" v-model="cloud.smb.username" class="flex-1 bg-background text-[13px] md:text-[13px]" spellcheck="false" :disabled="storageBusy" />
                          </div>
                          <div class="row">
                            <Label for="storage-cloud-smb-password" class="storageFieldLabel">密码</Label>
                            <Input id="storage-cloud-smb-password" v-model="cloud.smb.password" class="flex-1 bg-background text-[13px] md:text-[13px]" type="password" autocomplete="new-password" :disabled="storageBusy" />
                          </div>
                        </template>
                      </div>
                      <div class="row actions storageActions">
                        <Button type="button" variant="outline" class="text-[13px]" :disabled="storageBusy" @click="testCloud">测试连接</Button>
                        <Button type="button" class="text-[13px]" :disabled="storageBusy" @click="saveCloud">保存配置</Button>
                        <Button type="button" variant="ghost" v-if="selectedCloudIsRunning && store.workflow.role !== 'customer'" class="text-[13px]" :disabled="storageBusy" @click="syncNow">导入旧数据</Button>
                      </div>
                    </template>
                    <div v-if="cloudLoadError" class="cloudMsg" role="status">{{ cloudLoadError }}</div>
                    <div v-else-if="cloudMsg?.provider === selectedCloudProvider" class="cloudMsg" role="status">{{ cloudMsg.text }}</div>
                  </template>
                  <template v-else-if="storageProvider === 'qiniu'">
                    <p class="hint">设备凭证用于连接七牛排单服务。设备角色在「基础信息」中单独设置。</p>
                    <div class="formGrid">
                      <div class="row">
                        <Label for="storage-qiniu-form-api-url" class="storageFieldLabel">API 地址</Label>
                        <Input id="storage-qiniu-form-api-url" v-model="qiniuForm.apiUrl" class="flex-1 bg-background text-[13px] md:text-[13px]" type="url" placeholder="https://sync.example.com" spellcheck="false" :disabled="storageBusy || !qiniuSaved" />
                      </div>
                      <div class="row">
                        <Label for="storage-qiniu-form-token" class="storageFieldLabel">设备凭证</Label>
                        <Input id="storage-qiniu-form-token" v-model="qiniuForm.token" class="flex-1 bg-background text-[13px] md:text-[13px]" type="password" autocomplete="new-password" :placeholder="qiniuSaved?.hasToken ? '已配置，留空沿用' : '输入设备接入凭证'" :disabled="storageBusy || !qiniuSaved" />
                      </div>
                    </div>
                    <div class="row actions">
                      <Button type="button" variant="outline" class="text-[13px]" :disabled="storageBusy || !qiniuSaved || !qiniuForm.apiUrl.trim()" @click="testQiniu">测试连接</Button>
                      <Button type="button" class="text-[13px]" :disabled="storageBusy || !qiniuSaved || !qiniuForm.apiUrl.trim()" @click="saveQiniu">保存配置</Button>
                    </div>
                    <div v-if="qiniuSaved?.hasToken" class="qiniuLegacy">
                      <p v-if="qiniuSaved.role" class="hint">
                        凭证权限 {{ qiniuRoleName[qiniuSaved.role] }}
                        <template v-if="qiniuSaved.workspaceId"> · 空间 {{ qiniuSaved.workspaceId }}</template>
                        <template v-if="qiniuSaved.deviceId"> · 设备 {{ qiniuSaved.deviceId }}</template>
                      </p>
                      <div class="row actions">
                        <Button type="button" variant="ghost" v-if="store.workflow.role !== 'customer'" class="text-[13px]" :disabled="storageBusy" @click="syncQiniu">导入旧数据</Button>
                        <Button type="button" variant="ghost" class="text-[13px]" :disabled="storageBusy || !store.info?.dataRoot" @click="openQiniuLogs">打开日志目录</Button>
                      </div>
                    </div>
                    <div v-if="qiniuMsg" class="cloudMsg" role="status">{{ qiniuMsg }}</div>
                  </template>
                </template>
              </TabsContent>
            </Tabs>
          </div>

          <div v-show="activeSection === 'cutout'" class="card">
            <h3>AI 抠图（PicWish）</h3>
            <p class="hint">
              「AI 抠图」「一键去底」共用此配置：识别类型决定抠图的主体；
              API Key 留空时使用内置默认（也可用环境变量 PIC_PICWISH_API_KEY 覆盖）。
            </p>
            <div class="row">
              <Label for="cutout-kind" class="label">识别类型</Label>
              <OptionSelect id="cutout-kind" v-model="cutc.kind" :options="cutoutKinds" class="w-full max-w-64" :disabled="cutBusy" />
            </div>
            <div class="row">
              <span class="label">API Key</span>
              <Input v-model="cutc.apiKey" class="max-w-md flex-1" type="password" placeholder="留空使用内置默认 Key" />
            </div>
            <div class="row">
              <span class="label">超时(秒)</span>
              <Input v-model.number="cutc.timeoutSecs" class="w-24" type="number" min="30" step="10" />
            </div>
            <div class="row actions">
              <Button type="button" :disabled="cutBusy" @click="saveCutout">保存</Button>
              <Button type="button" variant="outline" :disabled="!store.info?.dataRoot" @click="openCutoutLogs">打开日志目录</Button>
            </div>
            <p class="hint">抠图日志为目录中的 cutout.log，记录每张照片的缓存命中、接口状态、处理与下载耗时、失败原因。批量逐张处理，全部完成后统一更新画板。</p>
            <div v-if="cutMsg" class="cloudMsg">{{ cutMsg }}</div>
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
  margin: 0 0 14px;
  font-size: 16px;
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
  color: var(--text);
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
.actions {
  gap: 8px;
  padding-top: 10px;
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
.storageFieldLabel {
  width: 100px;
  flex-shrink: 0;
  color: var(--text);
  font-size: 13px;
}
.qiniuLegacy {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--stroke);
}
.cloudMsg {
  font-size: 11px;
  color: var(--text-dim);
  padding: 6px 0;
  word-break: break-all;
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
  .sections {
    padding: 8px;
  }
}
</style>
