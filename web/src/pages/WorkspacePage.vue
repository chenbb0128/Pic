<script setup lang="ts">
import LayoutControls from '../components/workspace/LayoutControls.vue'
import AssetUploader from '../components/workspace/AssetUploader.vue'
import ExportPanel from '../components/workspace/ExportPanel.vue'
import PreviewStage from '../components/workspace/PreviewStage.vue'
</script>

<template>
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-x-hidden p-3 sm:p-5 lg:flex-row">
    <aside class="w-full shrink-0 space-y-5 rounded-2xl bg-white p-4 shadow-sm sm:p-5 lg:w-[340px] lg:overflow-y-auto">
      <div>
        <h1 class="text-xl font-bold text-slate-900">转印贴自助排版</h1>
        <p class="mt-1 text-xs leading-5 text-slate-500">选择排版规格，上传 PNG、WebP、JPG 或 JPEG 素材，系统自动排版并生成高清 PNG。</p>
        <p class="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">手机可直接使用。建议用 Chrome、Edge 或 Safari 打开。</p>
      </div>
      <LayoutControls />
      <AssetUploader type="2cm" title="② 上传 2CM 素材" hint="只填充上方 2CM 区域" />
      <AssetUploader type="3cm" title="③ 上传 3CM 素材" hint="只填充下方 3CM 区域" />
      <ExportPanel />
    </aside>
    <main class="flex min-h-[420px] min-w-0 flex-1 flex-col rounded-2xl bg-transparent lg:min-h-0">
      <PreviewStage />
    </main>
  </div>
</template>
