<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, CloudDownload, Ellipsis, LayoutTemplate, LoaderCircle, Plus, X } from '@lucide/vue'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import OptionSelect from '../components/OptionSelect.vue'
import TemplateSaveDialog from '../components/TemplateSaveDialog.vue'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { assetUrl, publishTemplate, syncTemplates, updateTemplate } from '../lib/tauri'
import { connectTemplateEditor } from '../lib/template-editor'
import { loadInfo, toast, useOrdersStore } from '../stores/orders'
import type { TemplateInfo } from '../types'

const store = useOrdersStore()
const templates = computed(() => store.info?.templates ?? [])
const previewFrame = ref<HTMLIFrameElement | null>(null)
const previews = ref<Record<string, string>>({})
const previewUrl = new URL('embedded/heart-star/index.html?catalog', document.baseURI).href
const builderUrl = new URL('embedded/heart-star/index.html?template-builder', document.baseURI).href
const blank = '自定义排版.png'
const createDialog = ref<HTMLDialogElement | null>(null)
const previewDialog = ref<HTMLDialogElement | null>(null)
const renameDialog = ref<HTMLDialogElement | null>(null)
const saveDialog = ref<InstanceType<typeof TemplateSaveDialog> | null>(null)
const source = ref(blank)
const draftSource = ref<string | null>(null)
const builder = ref<HTMLIFrameElement | null>(null)
const builderReady = ref(false)
const builderError = ref('')
const previewItem = ref<TemplateInfo | null>(null)
const renameItem = ref<TemplateInfo | null>(null)
const renameValue = ref('')
const operation = ref<'sync' | 'publish' | 'edit' | null>(null)

const sourceItem = computed(() => templates.value.find(item => item.webId === draftSource.value))
const sourceOptions = computed(() => [
  { id: blank, label: '自定义排版 · 逐排组合', icon: Plus },
  ...templates.value.filter(item => item.enabled !== false).map(item => ({
    id: item.webId, label: '复制 ' + item.code + ' ' + item.name, icon: LayoutTemplate,
  })),
])

function loadPreviews() {
  const frame = previewFrame.value?.contentWindow as (Window & {
    __picTemplateThumbnail?: (name: string) => Promise<string>
  }) | null
  const getThumbnail = frame?.__picTemplateThumbnail
  if (!getThumbnail) return
  for (const { webId, custom } of templates.value) {
    if (custom || webId in previews.value) continue
    void getThumbnail(webId).then(url => { previews.value[webId] = url }).catch(() => {})
  }
}

function previewPath(template: TemplateInfo) {
  return template.previewPath ? assetUrl(template.previewPath) : previews.value[template.webId]
}

function dimensions(template: TemplateInfo) {
  return template.width && template.height ? template.width + ' × ' + template.height + ' mm' : ''
}

function openPreview(item: TemplateInfo) {
  previewItem.value = item
  previewDialog.value?.showModal()
}

function openCreate() {
  source.value = blank
  createDialog.value?.showModal()
}

function startBuilder(id: string) {
  createDialog.value?.close()
  builderReady.value = false
  builderError.value = ''
  draftSource.value = id
}

function closeBuilder() {
  draftSource.value = null
}

async function loadBuilder() {
  const frame = builder.value?.contentWindow
  const id = draftSource.value
  if (!id || !frame) return
  try {
    connectTemplateEditor(frame, templates.value)
    if (!frame.__picOpenTemplate) throw new Error('模板编辑器未能加载。')
    await frame.__picOpenTemplate(id, true)
    if (builder.value?.contentWindow === frame) builderReady.value = true
  } catch (reason) {
    if (builder.value?.contentWindow === frame) builderError.value = String(reason)
  }
}

function saveBuilder() {
  const capture = builder.value?.contentWindow?.__picCaptureTemplate
  if (capture) saveDialog.value?.open(capture, sourceItem.value?.name ?? '')
}

function openRename(item: TemplateInfo) {
  renameItem.value = item
  renameValue.value = item.name
  renameDialog.value?.showModal()
}

async function run(kind: NonNullable<typeof operation.value>, work: () => Promise<void>) {
  if (operation.value) return
  operation.value = kind
  try {
    await work()
  } catch (reason) {
    toast('error', String(reason))
  } finally {
    operation.value = null
  }
}

async function editTemplate(item: TemplateInfo, name: string, enabled: boolean) {
  await run('edit', async () => {
    await updateTemplate(item.webId, name.trim(), enabled)
    renameDialog.value?.close()
    await loadInfo()
  })
}

function share(item: TemplateInfo) {
  void run('publish', async () => {
    await publishTemplate(item.webId)
    toast('ok', '已共享模板 ' + item.code + '。')
  })
}

function sync() {
  void run('sync', async () => {
    const result = await syncTemplates()
    await loadInfo()
    if (result.updated || !result.errors.length) {
      toast('ok', result.updated ? '已同步 ' + result.updated + ' 个模板。' : '模板目录已是最新。')
    }
    if (result.errors.length) toast('error', result.errors.join('；'))
  })
}

watch(templates, catalog => {
  loadPreviews()
  if (builder.value) connectTemplateEditor(builder.value.contentWindow, catalog)
})
</script>

<template>
  <div class="wrap">
    <section class="gallery glass" aria-labelledby="templates-title">
      <header class="galleryHeader">
        <div class="flex items-center gap-2">
          <Button v-if="draftSource" variant="ghost" size="icon-sm" aria-label="返回模板中心" @click="closeBuilder">
            <ArrowLeft aria-hidden="true" />
          </Button>
          <h2 id="templates-title">{{ draftSource ? '新建模板' : '模板中心' }}</h2>
        </div>
        <Button v-if="draftSource" size="sm" :disabled="!builderReady" @click="saveBuilder">保存模板</Button>
        <Button v-else variant="outline" size="sm" :disabled="!!operation" @click="sync">
          <LoaderCircle v-if="operation === 'sync'" class="animate-spin" aria-hidden="true" />
          <CloudDownload v-else aria-hidden="true" />
          {{ operation === 'sync' ? '正在同步…' : '同步模板' }}
        </Button>
      </header>
      <iframe v-if="templates.length" ref="previewFrame" :src="previewUrl" title="模板图片生成器" hidden @load="loadPreviews" />
      <div v-if="draftSource" class="builder">
        <div v-if="!builderReady" class="builderStatus" role="status">{{ builderError || '正在加载模板编辑器…' }}</div>
        <iframe ref="builder" class="builderFrame" :src="builderUrl" title="模板编辑器" @load="loadBuilder" />
      </div>
      <div v-else class="galleryBody">
        <figure v-for="template in templates" :key="template.webId" class="templateCard">
          <button type="button" class="templatePreview" :aria-label="'预览 ' + template.code + ' ' + template.name" @click="openPreview(template)">
            <img v-if="previewPath(template)" :src="previewPath(template)" alt="" />
            <LayoutTemplate v-else class="size-7 text-muted-foreground/50" aria-hidden="true" />
          </button>
          <figcaption>
            <div class="templateDetails">
              <div class="templateTitle"><span v-if="template.code !== template.name" class="templateCode">{{ template.code }}</span><span>{{ template.name }}</span></div>
              <span class="templateMeta">{{ dimensions(template) }}<span v-if="template.enabled === false"> · 已停用</span></span>
            </div>
            <DropdownMenuRoot>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-xs" :aria-label="template.code + ' 的模板操作'" :disabled="!!operation">
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent align="end" :side-offset="4" class="z-50 min-w-28 rounded-md border border-solid border-border bg-popover p-1 shadow-lg">
                  <DropdownMenuItem class="menuItem" @select="startBuilder(template.webId)">复制模板</DropdownMenuItem>
                  <template v-if="template.custom">
                    <DropdownMenuItem class="menuItem" @select="openRename(template)">重命名</DropdownMenuItem>
                    <DropdownMenuItem class="menuItem" @select="editTemplate(template, template.name, template.enabled === false)">
                      {{ template.enabled === false ? '重新启用' : '停用模板' }}
                    </DropdownMenuItem>
                    <DropdownMenuItem class="menuItem" @select="share(template)">共享模板</DropdownMenuItem>
                  </template>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
          </figcaption>
        </figure>
        <button class="newTemplate" type="button" @click="openCreate">
          <span class="newIcon"><Plus class="size-5" aria-hidden="true" /></span>
          <span>新建模板</span>
        </button>
      </div>
    </section>
    <dialog ref="createDialog" class="templateDialog" aria-label="新建模板">
      <h2>新建模板</h2>
      <OptionSelect v-model="source" :options="sourceOptions" :portal-to="createDialog ?? undefined" aria-label="模板来源" />
      <div class="flex justify-end gap-2">
        <Button variant="outline" @click="createDialog?.close()">取消</Button>
        <Button @click="startBuilder(source)">打开编辑器</Button>
      </div>
    </dialog>
    <dialog ref="previewDialog" class="templateDialog previewDialog" aria-label="模板预览">
      <template v-if="previewItem">
        <div class="flex items-center justify-between gap-2">
          <h2>{{ previewItem.code }} {{ previewItem.name }}</h2>
          <Button variant="ghost" size="icon-sm" aria-label="关闭模板预览" @click="previewDialog?.close()"><X aria-hidden="true" /></Button>
        </div>
        <img v-if="previewPath(previewItem)" :src="previewPath(previewItem)" :alt="previewItem.name" />
        <div class="templateMeta">{{ dimensions(previewItem) }}</div>
      </template>
    </dialog>
    <dialog ref="renameDialog" class="templateDialog" aria-label="重命名模板">
      <form v-if="renameItem" class="grid gap-3" @submit.prevent="editTemplate(renameItem, renameValue, renameItem.enabled !== false)">
        <h2>重命名模板</h2>
        <Input v-model="renameValue" maxlength="80" required aria-label="模板名称" :disabled="!!operation" />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" :disabled="!!operation" @click="renameDialog?.close()">取消</Button>
          <Button type="submit" :disabled="!!operation || !renameValue.trim()">保存</Button>
        </div>
      </form>
    </dialog>
    <TemplateSaveDialog ref="saveDialog" @saved="closeBuilder" />
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 10px 12px 12px;
}
.gallery {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.galleryHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--stroke);
}
h2 {
  margin: 0;
  font-size: 18px;
}
.galleryBody {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 174px), 1fr));
  align-content: start;
  gap: 12px;
  padding: 16px;
  overflow: auto;
}
.templateCard {
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--stroke);
  border-radius: 10px;
}
.templatePreview {
  width: 100%;
  display: grid;
  place-items: center;
  height: 164px;
  padding: 12px;
  background: #f4f7ff;
  border: 0;
  border-bottom: 1px solid var(--stroke);
  cursor: zoom-in;
}
.templatePreview:hover {
  background: #ecf1fd;
}
.templatePreview img {
  width: 100%;
  height: 140px;
  object-fit: contain;
}
.templateCard figcaption {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 10px;
  overflow-wrap: anywhere;
}
.templateDetails { min-width: 0; }
.templateTitle { display: flex; align-items: baseline; gap: 6px; }
.templateMeta { display: block; color: var(--text-dim); font-size: 11px; }
.templateCode {
  flex: none;
  border-radius: 5px;
  padding: 1px 5px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
}
.newTemplate {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  min-height: 212px;
  border: 1px dashed var(--accent-border);
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
  font-weight: 600;
}
.newTemplate:hover { border-color: var(--accent); background: #eef3ff; }
.newIcon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; background: var(--bg-card); }
.menuItem { padding: 5px 9px; cursor: pointer; border-radius: 5px; outline: none; }
.menuItem[data-highlighted] { background: var(--accent-soft); color: var(--accent); }
.builder { display: flex; position: relative; flex: 1; min-height: 0; }
.builderFrame { display: block; width: 100%; flex: 1; border: 0; }
.builderStatus { position: absolute; inset: 0; display: grid; place-items: center; background: var(--bg-card); }
.templateDialog { width: min(400px, calc(100vw - 32px)); padding: 16px; border: 1px solid var(--stroke); border-radius: var(--radius); background: var(--bg-card); color: var(--text); }
.templateDialog[open] { display: grid; gap: 12px; }
.templateDialog::backdrop { background: #17234150; }
.previewDialog { width: min(580px, calc(100vw - 32px)); }
.previewDialog img { width: 100%; max-height: 70vh; object-fit: contain; background: #f4f7ff; border-radius: 8px; }
</style>
