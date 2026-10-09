<script setup lang="ts">
import { ref } from 'vue'
import { XIAOHONGSHU_ORDER_TEXT, XIAOHONGSHU_ORDER_URL } from '../domain/order'
import { copyText } from '../services/clipboard'

const copyStatus = ref<'idle' | 'copied' | 'manual'>('idle')

async function copyOrderText(): Promise<void> {
  copyStatus.value = await copyText(XIAOHONGSHU_ORDER_TEXT) ? 'copied' : 'manual'
}

function selectOrderText(event: FocusEvent): void {
  (event.target as HTMLTextAreaElement).select()
}
</script>

<template>
  <article class="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-8">
    <div>
      <p class="text-sm font-semibold text-slate-500">使用说明</p>
      <h1 class="mt-1 text-3xl font-bold text-slate-900">贴纸排版怎么用</h1>
    </div>
    <section class="space-y-2 rounded-2xl bg-white p-5 shadow-sm">
      <h2 class="text-lg font-bold">1. 准备素材</h2>
      <p class="text-sm leading-6 text-slate-600">上传 PNG、WebP、JPG 或 JPEG。透明底 PNG/WebP 会保留透明背景；JPG/JPEG 没有透明通道。素材会保留比例缩放到 2CM 或 3CM 的方形位置，不会上传到服务器。</p>
    </section>
    <section class="space-y-2 rounded-2xl bg-white p-5 shadow-sm">
      <h2 class="text-lg font-bold">2. 选择规格</h2>
      <p class="text-sm leading-6 text-slate-600">混合版同时使用 2CM 和 3CM 区域；铺满模式只使用对应尺寸。行数可以调整，预览会自动重新均匀分布。</p>
    </section>
    <section class="space-y-2 rounded-2xl bg-white p-5 shadow-sm">
      <h2 class="text-lg font-bold">3. 导出文件</h2>
      <p class="text-sm leading-6 text-slate-600">A4 纸张为 297×210mm，A5 为 210×148mm，A6 为 148×105mm。300 DPI 适合大多数场景，600 DPI 文件更大、生成更慢。导出的 PNG 保留透明背景，并写入真实 DPI 信息。</p>
    </section>
    <section class="space-y-2 rounded-2xl bg-white p-5 shadow-sm">
      <h2 class="text-lg font-bold">4. 工具箱入口</h2>
      <p class="text-sm leading-6 text-slate-600">顶部工具栏提供自动排版、改色、波点、框架对比、姓名排版和文字方格。除自动抠图外，这些工具都在浏览器本地处理，图片不会上传服务器；“经典 2/3CM”入口保留旧版排版方式。</p>
      <p class="text-sm leading-6 text-slate-600">自动抠图目前是预留入口，后续接入服务端后再开放处理。</p>
    </section>
    <section class="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
      <h2 class="text-lg font-bold">5. 生成与下载</h2>
      <ol class="list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-600">
        <li>确认排版预览、导出精度和文件名称后，点击“生成高清透明 PNG”。</li>
        <li>生成期间请等待 Loading 完成，600 DPI 在手机上需要更长时间和更多内存。</li>
        <li>图片生成后，第一次点击绿色按钮复制下单文案。</li>
        <li>按钮变为“文案已复制，点击下载图片”后，再点击一次下载 PNG。</li>
      </ol>
    </section>
    <section class="space-y-3 rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
      <div>
        <h2 class="text-lg font-bold text-slate-900">6. 去小红书下单</h2>
        <p class="mt-1 text-sm leading-6 text-slate-600">下载图片后，复制下面的文案并打开小红书粘贴，即可进入主页下单。</p>
      </div>
      <div class="rounded-xl bg-white p-3 text-sm leading-6 text-slate-700">
        {{ XIAOHONGSHU_ORDER_TEXT }}
      </div>
      <div class="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          class="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700"
          @click="copyOrderText"
        >
          {{ copyStatus === 'copied' ? '下单文案已复制 ✓' : '复制下单文案' }}
        </button>
        <a
          class="flex min-h-11 items-center justify-center rounded-lg bg-red-500 px-4 text-sm font-semibold text-white hover:bg-red-600"
          :href="XIAOHONGSHU_ORDER_URL"
          target="_blank"
          rel="noopener noreferrer"
        >打开小红书去下单</a>
      </div>
      <div v-if="copyStatus === 'manual'" class="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3" aria-live="polite">
        <p class="text-xs leading-5 text-amber-800">浏览器未允许自动复制，请长按下面的文案手动复制。</p>
        <textarea
          class="h-24 w-full resize-none rounded-lg border border-amber-300 bg-white p-2 text-xs leading-5 text-slate-700 outline-none focus:ring-2 focus:ring-amber-200"
          :value="XIAOHONGSHU_ORDER_TEXT"
          readonly
          @focus="selectOrderText"
        />
      </div>
    </section>
  </article>
</template>
