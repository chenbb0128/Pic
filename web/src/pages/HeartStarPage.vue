<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { clearHeartStarAccess, hasHeartStarAccess, rememberHeartStarAccess } from '../services/heartStarAccess'

// MVP entry guard only. Static tool files are not protected server-side.
const ACCESS_PASSWORD = '87654321'
const password = ref('')
const unlocked = ref(false)
const checkingAccess = ref(false)
const error = ref('')
const loading = ref(true)
const toolUrl = `${import.meta.env.BASE_URL}embedded/heart-star/index.html?v=photo-fit-41`
const shortcutGuide = ref<HTMLDialogElement | null>(null)
const shortcutGroups = [
  { title: '选择图案', items: [
    { keys: ['Esc'], action: '取消全部选中', note: '输入框编辑、图片拖动或弹窗打开时不触发。' },
    { keys: ['鼠标拖框'], action: '框选多个图案', note: '框住图案中心即可选中；请先关闭“拖动图片”。' },
    { keys: ['Shift + 拖框'], action: '追加选中图案', note: '保留原选择，再添加框内图案。' },
  ] },
  { title: '调整图案', items: [
    { keys: ['Alt + 滚轮'], action: '缩放选中的图案', note: '鼠标放在画板上使用，向上放大、向下缩小；不适用于文案模板。' },
  ] },
  { title: '文案模板专用', items: [
    { keys: ['Ctrl / ⌘ + Z'], action: '撤销上一步', note: '仅用于文案排版；输入框内使用系统原有撤销。' },
    { keys: ['Ctrl / ⌘ + Shift + Z', 'Ctrl / ⌘ + Y'], action: '重做上一步', note: '仅用于文案排版。' },
  ] },
]

function openShortcutGuide(): void {
  if (!shortcutGuide.value?.open) shortcutGuide.value?.showModal()
}

function closeShortcutGuide(): void {
  shortcutGuide.value?.close()
}

function onShortcutBackdrop(event: MouseEvent): void {
  const dialog = shortcutGuide.value
  if (!dialog || event.target !== dialog) return
  const bounds = dialog.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close()
}

onMounted(async () => {
  checkingAccess.value = true
  unlocked.value = await hasHeartStarAccess(ACCESS_PASSWORD)
  checkingAccess.value = false
})

async function unlock(): Promise<void> {
  if (password.value !== ACCESS_PASSWORD) {
    error.value = '密码错误，请重新输入。'
    return
  }
  password.value = ''
  error.value = ''
  loading.value = true
  checkingAccess.value = true
  await rememberHeartStarAccess(ACCESS_PASSWORD)
  unlocked.value = true
  checkingAccess.value = false
}

function lock(): void {
  if (!window.confirm('重新锁定会清空此工具内尚未下载的编辑内容，确定继续吗？')) return
  clearHeartStarAccess()
  unlocked.value = false
  password.value = ''
  error.value = ''
  loading.value = true
}
</script>

<template>
  <section v-if="checkingAccess" class="flex w-full flex-1 items-center justify-center px-4 py-12">
    <p class="text-sm text-slate-500" role="status">正在验证访问记录…</p>
  </section>
  <section v-else-if="!unlocked" class="flex w-full flex-1 items-center justify-center px-4 py-12">
    <div class="w-full max-w-md rounded-3xl border border-pink-100 bg-white p-6 shadow-sm sm:p-9">
      <span class="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-pink-100 text-2xl text-pink-600" aria-hidden="true">♡</span>
      <h1 class="mt-5 text-2xl font-bold text-slate-900">爱心星星排版</h1>
      <p class="mt-3 text-sm leading-7 text-slate-600">爱心、星星等装饰模板，支持照片填充、逐排组合、文案排版和高清 PNG 导出。</p>
      <form class="mt-6" @submit.prevent="unlock">
        <label for="heart-star-password" class="text-sm font-semibold text-slate-700">访问密码</label>
        <input id="heart-star-password" v-model="password" type="password" required autocomplete="current-password" placeholder="请输入访问密码" :aria-invalid="!!error" aria-describedby="heart-star-access-feedback" class="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-slate-50 px-4 text-base outline-none focus:border-pink-400 focus:ring-2 focus:ring-pink-100" @input="error = ''" />
        <p id="heart-star-access-feedback" class="mt-2 min-h-5 text-xs text-rose-600" role="status">{{ error }}</p>
        <button type="submit" class="mt-3 min-h-12 w-full rounded-xl bg-pink-600 px-4 text-sm font-bold text-white hover:bg-pink-700">解锁使用</button>
      </form>
      <p class="mt-5 text-xs leading-6 text-slate-500">仅此工具需要密码，其他功能照常使用。同一浏览器解锁后记住 30 天，密码更新后需重新解锁；图片在当前浏览器处理。</p>
    </div>
  </section>
  <section v-else class="flex h-[calc(100dvh-64px)] min-h-[420px] w-full min-w-0 flex-1 flex-col bg-[#faf8f9] lg:h-auto lg:min-h-0">
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-pink-100 bg-white px-4 py-3">
      <div class="min-w-0">
        <h1 class="text-sm font-bold text-slate-900">♡ 爱心星星排版</h1>
        <p class="mt-1 text-[11px] text-slate-500">保留原尺寸 · 照片填充 · 文案排版</p>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <button type="button" aria-haspopup="dialog" aria-controls="heart-star-shortcut-guide" class="min-h-10 rounded-lg border border-pink-200 bg-pink-50 px-3 text-xs font-semibold text-pink-700 hover:bg-pink-100" @click="openShortcutGuide">快捷键指南</button>
        <button type="button" class="min-h-10 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50" @click="lock">重新锁定</button>
      </div>
    </div>
    <p v-if="loading" class="shrink-0 px-4 py-2 text-xs text-pink-700" role="status">正在载入模板工具…</p>
    <iframe :src="toolUrl" title="爱心星星排版工具" class="block min-h-0 w-full flex-1 border-0" sandbox="allow-scripts allow-same-origin allow-downloads allow-modals" allow="clipboard-write" @load="loading = false"></iframe>
    <dialog id="heart-star-shortcut-guide" ref="shortcutGuide" aria-labelledby="heart-star-shortcut-title" aria-describedby="heart-star-shortcut-note" class="shortcut-dialog m-auto rounded-2xl border border-pink-100 bg-white p-5 text-slate-800 shadow-xl backdrop:bg-slate-900/45 sm:p-6" @click="onShortcutBackdrop">
      <div class="mb-2 flex items-center justify-between gap-4">
        <h2 id="heart-star-shortcut-title" class="text-lg font-bold">快捷键指南</h2>
        <button type="button" aria-label="关闭快捷键指南" autofocus class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-lg text-slate-500 hover:bg-slate-50" @click="closeShortcutGuide">×</button>
      </div>
      <p id="heart-star-shortcut-note" class="text-xs leading-6 text-slate-500">先点击画板再使用快捷键。手机可使用页面上的按钮和触摸框选。</p>
      <section v-for="group in shortcutGroups" :key="group.title" class="mt-5">
        <h3 class="mb-2 text-xs font-bold text-pink-700">{{ group.title }}</h3>
        <dl class="divide-y divide-slate-100 rounded-xl border border-slate-100 px-3">
          <div v-for="item in group.items" :key="item.action" class="py-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <dt class="text-sm font-semibold">{{ item.action }}</dt>
              <dd class="flex flex-wrap gap-1.5"><kbd v-for="key in item.keys" :key="key" class="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-sans text-xs text-slate-600">{{ key }}</kbd></dd>
            </div>
            <p class="mt-1.5 text-xs leading-5 text-slate-500">{{ item.note }}</p>
          </div>
        </dl>
      </section>
      <p class="mt-4 text-xs text-slate-400">按 Esc、点击 × 或弹窗外部可关闭指南。⌘ 为 Mac 的 Command 键。</p>
    </dialog>
  </section>
</template>

<style scoped>
.shortcut-dialog {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
</style>
