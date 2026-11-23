<script setup lang="ts" generic="Value extends string">
import { computed } from 'vue'
import type { Component } from 'vue'
import { Check } from '@lucide/vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  options: readonly { id: Value; label: string; detail?: string; icon: Component }[]
  disabled?: boolean
  compact?: boolean
  portalTo?: HTMLElement | string
}>()
const model = defineModel<Value>({ required: true })
const selected = computed(() => props.options.find(option => option.id === model.value))

function choose(value: unknown) {
  const option = props.options.find(option => option.id === value)
  if (option) model.value = option.id
}
</script>

<template>
  <Select :model-value="model" :disabled="disabled" @update:model-value="choose">
    <SelectTrigger
      v-bind="$attrs"
      :size="compact ? 'sm' : 'default'"
      class="gap-2 border-primary/25 bg-primary/5 px-2.5 py-0 text-[13px] font-medium enabled:cursor-pointer enabled:hover:border-primary/50 enabled:hover:bg-primary/10 data-[state=open]:border-primary data-[state=open]:bg-primary/10"
    >
      <span class="flex min-w-0 items-center gap-2">
        <span class="grid shrink-0 place-items-center rounded-sm bg-primary/12 text-primary" :class="compact ? 'size-5' : 'size-6'">
          <component v-if="selected" :is="selected.icon" :class="compact ? 'size-3.5' : 'size-4'" aria-hidden="true" />
        </span>
        <SelectValue>{{ selected?.label }}</SelectValue>
      </span>
    </SelectTrigger>
    <SelectContent :side-offset="5" :portal-to="portalTo" class="rounded-xl border-border p-1 shadow-lg" :class="compact ? 'min-w-52' : ''">
      <SelectItem
        v-for="option in options"
        :key="option.id"
        :value="option.id"
        :text-value="option.label"
        class="min-h-14 cursor-pointer rounded-lg px-2.5 py-2.5 pr-9 focus:bg-primary/8 focus:text-foreground data-[highlighted]:bg-primary/8 data-[state=checked]:bg-primary/12"
      >
        <span class="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <component :is="option.icon" class="size-4 text-primary" aria-hidden="true" />
        </span>
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="text-[13px] leading-tight font-semibold">{{ option.label }}</span>
          <span v-if="option.detail" class="text-xs leading-tight text-muted-foreground">{{ option.detail }}</span>
        </span>
        <template #indicator-icon><Check class="size-4 text-primary" aria-hidden="true" /></template>
      </SelectItem>
    </SelectContent>
  </Select>
</template>
