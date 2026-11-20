<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useOrdersStore, toast, loadOrders, refreshQiniuStatus } from '../stores/orders'
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
  qiniuRetryFailed,
  qiniuSyncNow,
  saveCloudConfig,
  saveCutoutConfig,
  saveMysqlConfig,
  saveQiniuSettings,
  testQiniuSettings,
} from '../lib/tauri'
import type { CloudConfig, CutoutConfig, MysqlConfig, QiniuDevice, QiniuSettings } from '../types'

defineEmits<{ back: [] }>()

const store = useOrdersStore()

const storageProvider = ref<'minio' | 'qiniu' | null>(null)
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
const qiniuRoleName: Record<QiniuDevice['role'], string> = {
  customer: '客服',
  production: '制作',
  both: '客服与制作',
}

const cloud = ref<CloudConfig>({
  enabled: false,
  endpoint: '',
  bucket: '',
  accessKey: '',
  secretKey: '',
  region: 'us-east-1',
  pollSeconds: 30,
})
const cloudMsg = ref('')
const cloudBusy = ref(false)
const minioEnabled = ref<boolean | null>(null)
const currentStorage = computed(() => {
  if (!store.qiniu) return '正在读取'
  if (qiniuIsRunning.value) return '七牛 Kodo'
  if (!legacyIsRunning.value) return '仅本机（七牛已暂停）'
  if (minioEnabled.value === null) return cloudMsg.value ? '读取失败' : '正在读取'
  return minioEnabled.value ? 'MinIO' : '仅本机'
})

const pgc = ref<MysqlConfig>({ enabled: true, host: '192.168.31.200', port: 3306, user: 'root', password: 'admin123', dbname: 'vagaga', pollSeconds: 30 })
const pgMsg = ref('')
const pgBusy = ref(false)

const cutc = ref<CutoutConfig>({ apiKey: '', kind: 'person', timeoutSecs: 90 })
const cutMsg = ref('')
const cutBusy = ref(false)

// 左侧锚点导航
const sections = [
  { key: 'basics', label: '基础信息' },
  { key: 'mysql', label: 'MySQL 数据库' },
  { key: 'storage', label: '对象存储' },
  { key: 'cutout', label: 'AI 抠图' },
  { key: 'templates', label: '制作模板' },
]
const activeSection = ref('basics')
const sectionsEl = ref<HTMLElement | null>(null)

function goto(key: string) {
  activeSection.value = key
  document.getElementById('sec-' + key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onScroll() {
  const box = sectionsEl.value?.getBoundingClientRect()
  if (!box) return
  let current = sections[0]!.key
  for (const s of sections) {
    const el = document.getElementById('sec-' + s.key)
    if (!el) continue
    if (el.getBoundingClientRect().top - box.top - 90 <= 0) current = s.key
  }
  activeSection.value = current
}

onMounted(async () => {
  void loadQiniuSettings()
  try {
    cloud.value = await getCloudConfig()
    minioEnabled.value = cloud.value.enabled
  } catch (error) {
    cloudMsg.value = `读取 MinIO 配置失败：${error}`
  }
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
    storageProvider.value ??= settings.enabled || settings.hasToken ? 'qiniu' : 'minio'
  } catch (error) {
    qiniuMsg.value = `读取七牛设置失败：${error}`
    storageProvider.value ??= 'minio'
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

async function saveCloud() {
  cloudBusy.value = true
  try {
    const config = { ...cloud.value }
    await saveCloudConfig(config)
    minioEnabled.value = config.enabled
    cloudMsg.value = 'MinIO 配置已保存。'
  } catch (error) {
    cloudMsg.value = String(error)
  } finally {
    cloudBusy.value = false
  }
}

async function testCloud() {
  cloudBusy.value = true
  cloudMsg.value = '正在测试连接…'
  try {
    cloudMsg.value = await cloudTest(JSON.parse(JSON.stringify(cloud.value)))
    toast('ok', '云服务连接成功')
  } catch (error) {
    cloudMsg.value = String(error)
    toast('error', '云服务连接失败')
  } finally {
    cloudBusy.value = false
  }
}

async function syncNow() {
  cloudBusy.value = true
  cloudMsg.value = '正在同步…'
  try {
    const notices = await cloudSyncNow()
    const total = notices.reduce((sum, n) => sum + n.newImages, 0)
    cloudMsg.value = notices.length
      ? `同步完成：${notices.length} 个订单更新，新增 ${total} 张素材。`
      : '同步完成：云端没有新变化。'
    await loadOrders()
  } catch (error) {
    cloudMsg.value = String(error)
  } finally {
    cloudBusy.value = false
  }
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
      <h2>设置</h2>
      <div class="layout">
        <nav class="nav">
          <button
            v-for="s in sections"
            :key="s.key"
            class="navBtn"
            :class="{ on: activeSection === s.key }"
            @click="goto(s.key)"
          >{{ s.label }}</button>
        </nav>

        <div class="sections" ref="sectionsEl" @scroll="onScroll">
          <div class="card" id="sec-basics">
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

          <div class="card" id="sec-mysql">
            <h3>MySQL 数据库</h3>
            <p class="hint">客户端直连时，同步订单信息和导出的成品。</p>
            <p v-if="qiniuIsRunning" class="hint">当前使用七牛同步，订单数据库由排单服务配置。</p>
            <p v-else-if="store.qiniu && !legacyIsRunning" class="hint">当前仅保存在本机，客户端的 MySQL 同步已暂停。</p>
            <label class="row checkRow">
              <input v-model="pgc.enabled" type="checkbox" />
              <span>启用 MySQL 同步</span>
            </label>
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
            <div class="row actions">
              <button class="btn" :disabled="pgBusy" @click="savePg">保存</button>
              <button class="btn" :disabled="pgBusy" @click="testPg">测试连接</button>
              <button class="btn" :disabled="pgBusy || !legacyIsRunning" @click="syncPgNow">立即同步</button>
            </div>
            <div v-if="pgMsg" class="cloudMsg">{{ pgMsg }}</div>
          </div>

          <div class="card" id="sec-storage">
            <h3>对象存储</h3>
            <div class="storageStatus">
              <div>
                <strong>当前存储</strong>
                <span>{{ currentStorage }}</span>
              </div>
              <span v-if="qiniuNeedsRestart" class="restartNote">
                {{ qiniuSaved?.enabled ? '重启后使用七牛' : '重启后仅保存在本机' }}
              </span>
            </div>
            <label class="row">
              <span class="label">存储类别</span>
              <select v-model="storageProvider" class="input" :disabled="cloudBusy || qiniuBusy">
                <option value="minio">MinIO（S3 兼容）</option>
                <option value="qiniu">七牛 Kodo</option>
              </select>
            </label>

            <template v-if="storageProvider === 'minio'">
              <p class="hint">客服机与制作机共用一个 MinIO Bucket，同步素材和订单清单。</p>
              <p v-if="qiniuSaved?.hasToken" class="hint">此数据目录已绑定七牛。使用 MinIO 需要独立的数据目录。</p>
              <label class="row checkRow">
                <input v-model="cloud.enabled" type="checkbox" />
                <span>启用 MinIO</span>
              </label>
              <div class="row">
                <span class="label">端点</span>
                <input v-model="cloud.endpoint" class="input" placeholder="http://your-minio.example.com:9000" spellcheck="false" />
              </div>
              <div class="row">
                <span class="label">Bucket</span>
                <input v-model="cloud.bucket" class="input" placeholder="vagaga" spellcheck="false" />
              </div>
              <div class="row">
                <span class="label">Access Key</span>
                <input v-model="cloud.accessKey" class="input" placeholder="MinIO Access Key" spellcheck="false" />
              </div>
              <div class="row">
                <span class="label">Secret Key</span>
                <input v-model="cloud.secretKey" class="input" type="password" placeholder="MinIO Secret Key" />
              </div>
              <div class="row">
                <span class="label">Region</span>
                <input v-model="cloud.region" class="input" placeholder="us-east-1" spellcheck="false" />
              </div>
              <div class="row">
                <span class="label">轮询间隔(秒)</span>
                <input v-model.number="cloud.pollSeconds" class="input narrow" type="number" min="10" step="5" />
              </div>
              <div class="row actions">
                <button class="btn" :disabled="cloudBusy || minioEnabled === null" @click="saveCloud">保存</button>
                <button class="btn" :disabled="cloudBusy || minioEnabled === null" @click="testCloud">测试连接</button>
                <button class="btn" :disabled="cloudBusy || !legacyIsRunning || !minioEnabled" @click="syncNow">立即同步</button>
              </div>
              <div v-if="cloudMsg" class="cloudMsg" role="status">{{ cloudMsg }}</div>
            </template>
            <template v-else-if="storageProvider === 'qiniu'">
              <p class="hint">通过排单服务同步原图和成品，客服和制作权限由设备凭证决定。</p>
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

          <div class="card" id="sec-cutout">
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

          <div class="card" id="sec-templates">
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
      <button class="back" @click="$emit('back')">← 返回</button>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  justify-content: center;
  padding: 20px;
  flex: 1;
  min-height: 0;
}
.panel {
  width: 1020px;
  max-width: 100%;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
h2 {
  margin: 0 0 12px;
  font-size: 16px;
}
.layout {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
}
.nav {
  width: 150px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.navBtn {
  text-align: left;
  padding: 9px 14px;
  border-radius: 10px;
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
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 2px 6px 8px 2px;
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
  margin-top: 4px;
}
.row {
  display: flex;
  gap: 14px;
  padding: 5px 0;
  align-items: center;
}
.label {
  width: 120px;
  flex-shrink: 0;
  color: var(--text-dim);
}
.value {
  word-break: break-all;
}
.hint {
  margin: 0 0 8px;
  font-size: 11px;
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
.storageStatus, .queueCounts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  align-items: center;
  margin: 0 0 8px;
}
.storageStatus strong {
  margin-right: 8px;
  font-weight: 600;
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
  margin-top: 14px;
  border: 1px solid var(--stroke);
  background: transparent;
  color: var(--text);
  border-radius: 8px;
  padding: 6px 16px;
  cursor: pointer;
  flex-shrink: 0;
}
</style>
