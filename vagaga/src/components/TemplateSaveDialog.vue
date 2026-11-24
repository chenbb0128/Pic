<script setup lang="ts">
import { ref } from 'vue'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { saveTemplate } from '../lib/tauri'
import { loadInfo, toast, useOrdersStore } from '../stores/orders'
import type { TemplateDraft } from '../types'

const emit = defineEmits<{ saved: [] }>()
const store = useOrdersStore()
const dialog = ref<HTMLDialogElement | null>(null)
const code = ref('')
const name = ref('')
const saving = ref(false)
const error = ref('')
let capture: (() => TemplateDraft) | undefined

function open(createDraft: () => TemplateDraft, suggestedName = '') {
  if (saving.value || !dialog.value || dialog.value.open) return
  const used = new Set(store.info?.templates.map(template => template.code))
  let next = 13
  while (used.has('A' + next)) next++
  code.value = 'A' + next
  name.value = suggestedName
  error.value = ''
  capture = createDraft
  dialog.value.showModal()
}

function close() {
  if (!saving.value) dialog.value?.close()
}

async function save() {
  if (saving.value || !capture) return
  const templateCode = code.value.trim().toUpperCase()
  const templateName = name.value.trim()
  if (!templateName || !/^A\d{2,11}$/.test(templateCode)) {
    error.value = '请输入模板名称和类似 A14 的规格编号。'
    return
  }
  saving.value = true
  error.value = ''
  try {
    await saveTemplate({ ...capture(), code: templateCode, name: templateName })
    dialog.value?.close()
    emit('saved')
    toast('ok', '模板已保存到本机。')
    await loadInfo().catch(reason => toast('error', '刷新模板目录失败：' + reason))
  } catch (reason) {
    error.value = String(reason)
  } finally {
    saving.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <dialog ref="dialog" class="saveDialog" aria-label="保存模板" @cancel.prevent="close">
    <form class="grid gap-3" @submit.prevent="save">
      <h2 class="m-0 text-base font-semibold">保存模板</h2>
      <label class="grid gap-1">
        <span>模板名称</span>
        <Input v-model="name" maxlength="80" required autofocus placeholder="例如 草莓横版" :disabled="saving" />
      </label>
      <label class="grid gap-1">
        <span>规格编号</span>
        <Input v-model="code" maxlength="12" required :disabled="saving" />
      </label>
      <p v-if="error" class="m-0 text-destructive" role="alert">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" :disabled="saving" @click="close">取消</Button>
        <Button type="submit" :disabled="saving">{{ saving ? '正在保存…' : '保存模板' }}</Button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.saveDialog {
  width: min(360px, calc(100vw - 32px));
  padding: 16px;
  border: 1px solid var(--stroke);
  border-radius: var(--radius);
  color: var(--text);
  background: var(--bg-card);
}
.saveDialog::backdrop { background: #17234150; }
</style>
