<template>
  <div class="flex min-h-screen flex-col bg-slate-100">
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex w-full max-w-[1500px] items-center justify-between px-4 py-3 sm:px-5">
        <RouterLink class="font-bold text-slate-900" to="/workspace">贴纸排版</RouterLink>
        <nav class="flex items-center gap-1 text-sm" aria-label="主导航">
          <RouterLink class="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100" active-class="bg-slate-100 text-slate-900" to="/workspace">工作台</RouterLink>
          <RouterLink class="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100" active-class="bg-slate-100 text-slate-900" to="/help">帮助</RouterLink>
        </nav>
      </div>
    </header>
    <main class="flex min-h-0 flex-1 flex-col"><RouterView /></main>
  </div>
</template>
