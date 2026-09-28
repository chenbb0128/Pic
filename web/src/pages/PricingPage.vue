<script setup lang="ts">
const paperPrices = [
  { size: 'A3', area: '293 × 420mm', price: '9.92元/张' },
  { size: 'A4', area: '293 × 210mm', price: '5.05元/张', current: true },
  { size: 'A5', area: '210 × 144mm', price: '2.69元/张' },
  { size: 'A6', area: '144 × 105mm', price: '1.88元/张' },
  { size: 'A7', area: '105 × 74mm', price: '1.02元/张' },
]
</script>

<template>
  <div class="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8">
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="text-sm font-semibold text-sky-700">UV 转印贴定制</p>
        <h1 class="mt-1 text-3xl font-bold text-slate-900">价格与制作说明</h1>
        <p class="mt-2 text-sm leading-6 text-slate-600">当前排版工具生成的是 A4 有效排版范围：293 × 210mm。</p>
      </div>
      <RouterLink class="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700" to="/workspace">
        返回工作台
      </RouterLink>
    </div>

    <div class="grid items-start gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside class="space-y-4 lg:sticky lg:top-5">
        <section class="rounded-2xl border border-sky-200 bg-sky-50 p-5 shadow-sm">
          <p class="text-sm font-semibold text-sky-700">当前工具对应价格</p>
          <div class="mt-2 flex items-end gap-2">
            <strong class="text-4xl font-bold text-slate-900">5.05元</strong>
            <span class="pb-1 text-sm text-slate-500">/ A4张</span>
          </div>
          <div class="mt-4 flex flex-wrap gap-2 text-xs text-slate-600">
            <span class="rounded-full bg-white px-3 py-1.5">5元起订</span>
            <span class="rounded-full bg-white px-3 py-1.5">运费4元</span>
            <span class="rounded-full bg-white px-3 py-1.5">满30元包邮</span>
          </div>
        </section>

        <section class="overflow-hidden rounded-2xl bg-white shadow-sm">
          <div class="border-b border-slate-100 px-4 py-3">
            <h2 class="font-bold text-slate-900">纸张参考价</h2>
          </div>
          <div class="divide-y divide-slate-100">
            <div
              v-for="item in paperPrices"
              :key="item.size"
              class="grid grid-cols-[42px_1fr_auto] items-center gap-2 px-4 py-3 text-sm"
              :class="item.current ? 'bg-amber-50' : ''"
            >
              <strong :class="item.current ? 'text-amber-700' : 'text-slate-800'">{{ item.size }}</strong>
              <span class="text-xs text-slate-500">{{ item.area }}</span>
              <span class="font-semibold text-slate-800">{{ item.price }}</span>
            </div>
          </div>
        </section>

        <section class="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          <p class="font-bold">下单前请准备</p>
          <p class="mt-1">原始图片或设计稿、单个图案最大边尺寸、每个图案制作数量、粘贴材质或使用物品。</p>
        </section>
      </aside>

      <section class="overflow-hidden rounded-2xl bg-white p-2 shadow-sm sm:p-4">
        <a href="/images/uv-transfer-price-list.jpg" target="_blank" rel="noopener noreferrer" title="点击查看价格表原图">
          <img
            class="mx-auto h-auto w-full max-w-[720px] rounded-xl"
            src="/images/uv-transfer-price-list.jpg"
            alt="小星贴 UV 转印贴定制价格表，包含纸张价格、A4参考数量、费用、制作要求与注意事项"
          />
        </a>
        <p class="py-3 text-center text-xs text-slate-500">点击图片可查看原图；实际数量以图案形状、间距及最终排版为准。</p>
      </section>
    </div>
  </div>
</template>
