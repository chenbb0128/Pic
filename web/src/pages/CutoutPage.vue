<template>
  <article class="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-5 p-5 sm:p-8">
    <div class="rounded-3xl bg-white p-7 shadow-sm sm:p-10">
      <span class="inline-flex rounded-full bg-indigo-100 px-3 py-1 text-xs font-bold text-indigo-700">功能预留</span>
      <h1 class="mt-4 text-3xl font-bold text-slate-900">自动抠图</h1>
      <p class="mt-3 text-sm leading-7 text-slate-600">自动抠图需要图像分割模型和稳定的处理环境。第一版先保留入口，当前不会上传或处理图片。后续接入服务端时会明确说明图片处理方式。</p>
      <button type="button" disabled class="mt-6 min-h-12 rounded-xl bg-slate-200 px-5 text-sm font-bold text-slate-500">抠图功能即将开放</button>
      <RouterLink to="/workspace" class="ml-3 inline-flex min-h-12 items-center text-sm font-semibold text-indigo-700">返回排版工作台 →</RouterLink>
    </div>
  </article>
</template>
