<template>
  <RouterLink
    to="/pricing"
    class="group flex items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 p-3 transition hover:border-sky-300 hover:bg-sky-100"
  >
    <div class="min-w-0">
      <p class="text-xs font-semibold text-sky-700">A4 · 293 × 210mm</p>
      <p class="mt-0.5 text-lg font-bold text-slate-900">
        5.05元<span class="text-xs font-medium text-slate-500"> / 张</span>
      </p>
      <p class="mt-0.5 text-xs text-slate-500">5元起订 · 运费4元 · 满30元包邮</p>
    </div>
    <span class="shrink-0 text-xs font-semibold text-sky-700 transition group-hover:translate-x-0.5">完整价格 →</span>
  </RouterLink>
</template>
