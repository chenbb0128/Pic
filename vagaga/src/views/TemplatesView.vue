<script setup lang="ts">
import { computed, ref } from 'vue'
import { LayoutTemplate } from '@lucide/vue'
import { useOrdersStore } from '../stores/orders'

const store = useOrdersStore()
const templates = computed(() => store.info?.templates ?? [])
const previewFrame = ref<HTMLIFrameElement | null>(null)
const previews = ref<Record<string, string>>({})
const previewUrl = new URL('embedded/heart-star/index.html?catalog', document.baseURI).href

function loadPreviews() {
  const frame = previewFrame.value?.contentWindow as (Window & {
    __picTemplateThumbnail?: (name: string) => Promise<string>
  }) | null
  const getThumbnail = frame?.__picTemplateThumbnail
  if (!getThumbnail) return
  for (const { webId } of templates.value) {
    if (webId in previews.value) continue
    void getThumbnail(webId).then(url => { previews.value[webId] = url }).catch(() => {})
  }
}
</script>

<template>
  <div class="wrap">
    <section class="gallery glass" aria-labelledby="templates-title">
      <header class="galleryHeader">
        <h2 id="templates-title">模板中心</h2>
      </header>
      <iframe v-if="templates.length" ref="previewFrame" :src="previewUrl" title="模板图片生成器" hidden @load="loadPreviews" />
      <div v-if="templates.length" class="galleryBody">
        <figure v-for="template in templates" :key="template.code" class="templateCard">
          <div class="templatePreview">
            <img v-if="previews[template.webId]" :src="previews[template.webId]" alt="" />
            <LayoutTemplate v-else class="size-7 text-muted-foreground/50" aria-hidden="true" />
          </div>
          <figcaption>
            <span class="templateCode">{{ template.code }}</span>
            <span>{{ template.name }}</span>
          </figcaption>
        </figure>
      </div>
      <p v-else-if="store.info" class="empty">暂无制作模板。</p>
    </section>
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
  display: grid;
  place-items: center;
  height: 164px;
  padding: 12px;
  background: #f4f7ff;
  border-bottom: 1px solid var(--stroke);
}
.templatePreview img {
  width: 100%;
  height: 140px;
  object-fit: contain;
}
.templateCard figcaption {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 8px 10px;
  overflow-wrap: anywhere;
}
.templateCode {
  flex: none;
  border-radius: 5px;
  padding: 1px 5px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
}
.empty {
  margin: 16px;
  color: var(--text-dim);
}
</style>
