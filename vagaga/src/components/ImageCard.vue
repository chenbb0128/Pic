<script setup lang="ts">
import { computed, ref } from 'vue'
import { refreshCurrent } from '../stores/orders'
import * as api from '../lib/tauri'
import type { OrderImage, TemplateInfo } from '../types'

const props = defineProps<{ image: OrderImage; templates: TemplateInfo[] }>()

const editing = ref(false)
const working = ref(false)

const src = computed(() => api.assetUrl(props.image.thumbnailPath || props.image.filePath))
const selectedCodes = computed(() =>
  new Set(
    props.image.templates.map(t => props.templates.find(x => x.webId === t.templateId)?.code ?? ''),
  ),
)

async function persist(next: { templateId: string; quantity: number }[]) {
  working.value = true
  try {
    await api.setImageTemplates(props.image.id, next)
    await refreshCurrent()
  } catch (error) {
    console.error(error)
  } finally {
    working.value = false
  }
}

async function toggle(code: string) {
  const template = props.templates.find(t => t.code === code)
  if (!template) return
  const current = [...props.image.templates]
  const existing = current.find(t => t.templateId === template.webId)
  const next = existing
    ? current.filter(t => t.templateId !== template.webId)
    : [...current, { templateId: template.webId, quantity: 1 }]
  editing.value = true
  await persist(next)
  editing.value = false
}

async function copyImage() {
  try {
    await api.copyImageToClipboard(props.image.id)
  } catch (error) {
    console.error(error)
  }
}

async function make(templateCode: string) {
  const template = props.templates.find(t => t.code === templateCode)
  if (!template) return
  working.value = true
  try {
    await api.copyImageToClipboard(props.image.id)
    await api.makePage(props.image.id, template.webId)
  } catch (error) {
    console.error(error)
  } finally {
    working.value = false
  }
}

async function removeImage() {
  if (!confirm('确认从订单移除这张图片？磁盘原图会保留。')) return
  working.value = true
  try {
    await api.deleteImage(props.image.id)
    await refreshCurrent()
  } catch (error) {
    console.error(error)
  } finally {
    working.value = false
  }
}

function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19)
}
</script>

<template>
  <div class="card">
    <img class="thumb" :src="src" loading="lazy" :alt="image.originalName" />
    <div class="meta">
      <div class="row">
        <span class="dim">{{ formatTime(image.createdAt) }}</span>
        <span class="dim">{{ (image.byteLength / 1024).toFixed(0) }}KB · {{ image.width }}×{{ image.height }}</span>
        <span class="badge" :title="image.source">{{ image.source }}</span>
      </div>
      <div class="chips">
        <span
          v-for="t in image.templates"
          :key="t.templateId"
          class="chip"
          :title="t.templateId"
        >
          {{ templates.find(x => x.webId === t.templateId)?.code ?? t.templateId }} × {{ t.quantity }}
        </span>
        <span v-if="!image.templates.length" class="dim">未关联模板</span>
      </div>
      <div v-if="editing" class="dim working">保存中…</div>
      <div v-else class="tplRow">
        <button
          v-for="t in templates"
          :key="t.code"
          class="tplBtn"
          :class="{ on: selectedCodes.has(t.code) }"
          :disabled="working"
          @click="toggle(t.code)"
        >
          {{ t.code }}
        </button>
      </div>
      <div v-if="image.templates.length" class="makeRow">
        <span class="dim">去制作：</span>
        <button
          v-for="t in image.templates"
          :key="'make-' + t.templateId"
          class="makeBtn"
          :disabled="working"
          @click="make(templates.find(x => x.webId === t.templateId)?.code ?? '')"
        >
          {{ templates.find(x => x.webId === t.templateId)?.code }} × {{ t.quantity }}
        </button>
        <button class="makeBtn copy" :disabled="working" @click="copyImage">复制到剪贴板</button>
      </div>
    </div>
    <button class="del" title="移除图片（保留原图）" :disabled="working" @click="removeImage"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M6 6l1 15a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-15"/><path d="M10 11v6M14 11v6"/></svg></button>
  </div>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  gap: 12px;
  padding: 12px;
  background: var(--bg-card);
  border: 1px solid var(--stroke);
  border-radius: var(--radius);
}
.card:hover {
  background: var(--bg-card-hover);
}
.thumb {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: #f0f3f8;
  flex-shrink: 0;
}
.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 11px;
}
.dim {
  color: var(--text-dim);
  font-size: 11px;
}
.badge {
  font-size: 10px;
  border: 1px solid var(--stroke);
  border-radius: 6px;
  padding: 0 6px;
  color: var(--text-dim);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.chip {
  font-size: 11px;
  background: rgba(91, 140, 255, 0.18);
  border: 1px solid rgba(91, 140, 255, 0.4);
  color: #b9ccff;
  border-radius: 7px;
  padding: 1px 8px;
}
.tplRow {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.tplBtn {
  border: 1px solid var(--stroke);
  background: var(--bg-input);
  color: var(--text);
  border-radius: 7px;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
.tplBtn.on {
  border-color: var(--accent);
  background: rgba(91, 140, 255, 0.2);
  color: #b9ccff;
}
.makeRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.makeBtn {
  border: none;
  border-radius: 7px;
  background: linear-gradient(135deg, #4f7dff, #6a5bff);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  cursor: pointer;
}
.makeBtn.copy {
  background: rgba(255, 255, 255, 0.12);
}
.del {
  position: absolute;
  right: 10px;
  top: 10px;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-dim);
}
.del:hover {
  background: var(--danger);
  color: #fff;
}
.working {
  font-style: italic;
}
</style>
