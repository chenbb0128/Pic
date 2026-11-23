<script setup lang="ts">
import type { CheckboxRootEmits, CheckboxRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { Check, Minus } from '@lucide/vue'
import { CheckboxIndicator, CheckboxRoot, useForwardPropsEmits } from 'reka-ui'
import { cn } from '../../../lib/utils'

const props = defineProps<CheckboxRootProps & { class?: HTMLAttributes['class'] }>()
const emit = defineEmits<CheckboxRootEmits>()
const forwarded = useForwardPropsEmits(reactiveOmit(props, 'class'), emit)
</script>

<template>
  <CheckboxRoot
    v-slot="{ modelValue }"
    v-bind="forwarded"
    data-slot="checkbox"
    :class="cn(
      'peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-background p-0 shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
      props.class,
    )"
  >
    <CheckboxIndicator data-slot="checkbox-indicator" class="flex items-center justify-center">
      <Minus v-if="modelValue === 'indeterminate'" class="size-3" aria-hidden="true" />
      <Check v-else class="size-3" aria-hidden="true" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
