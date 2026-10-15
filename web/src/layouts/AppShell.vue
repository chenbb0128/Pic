<template>
  <div class="flex min-h-[100dvh] w-full min-w-0 flex-col overflow-x-hidden bg-slate-100 lg:h-[100dvh]">
    <header class="z-20 shrink-0 border-b border-slate-700 bg-slate-950 text-white">
      <div class="flex w-full min-w-0 items-center justify-between gap-3 px-3 py-2.5 sm:px-5">
        <RouterLink class="shrink-0 text-base font-bold tracking-tight text-indigo-200" to="/workspace">✦ 小星贴工具箱</RouterLink>
        <nav class="hidden items-center gap-1 text-xs lg:flex" aria-label="主导航">
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/workspace">自动排版</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/cutout">抠图</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/tools/recolor">改色</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/tools/polka">波点</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/tools/frame">框架对比</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/tools/resize">尺寸转换</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/tools/name">姓名排版</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/tools/text">文字方格</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/classic">经典2/3CM</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/pricing">价格</RouterLink>
          <RouterLink class="rounded-lg px-2.5 py-2 text-slate-300 hover:bg-slate-800" active-class="bg-indigo-500/25 text-white" to="/help">帮助</RouterLink>
        </nav>
        <details class="relative lg:hidden">
          <summary class="cursor-pointer list-none rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold">☰ 工具</summary>
          <nav class="absolute right-0 top-11 z-30 grid w-48 gap-1 rounded-xl border border-slate-700 bg-slate-900 p-2 text-sm shadow-xl" aria-label="移动端导航">
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/workspace">自动排版</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/cutout">自动抠图（预留）</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/tools/recolor">线稿改色</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/tools/polka">波点生成</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/tools/frame">框架对比</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/tools/resize">尺寸转换</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/tools/name">姓名排版</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/tools/text">文字方格</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/classic">经典2/3CM排版</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/pricing">价格</RouterLink>
            <RouterLink class="rounded-lg px-3 py-2 hover:bg-slate-800" to="/help">帮助</RouterLink>
          </nav>
        </details>
      </div>
    </header>
    <main class="flex min-h-0 w-full min-w-0 flex-1 flex-col"><RouterView /></main>
  </div>
</template>
