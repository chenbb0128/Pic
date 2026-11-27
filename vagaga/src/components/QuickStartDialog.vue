<script setup lang="ts">
import { ref } from 'vue'
import { BookOpen, X } from '@lucide/vue'
import { Button } from './ui/button'

const emit = defineEmits<{ close: []; settings: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)

function open() {
  if (dialog.value && !dialog.value.open) dialog.value.showModal()
}

function openSettings() {
  dialog.value?.close()
  emit('settings')
}

defineExpose({ open })
</script>

<template>
  <dialog ref="dialog" class="quickStart" aria-labelledby="quick-start-title" @close="emit('close')">
    <header class="quickStartHeader">
      <div class="quickStartTitle">
        <BookOpen aria-hidden="true" />
        <h2 id="quick-start-title">操作帮助</h2>
      </div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭操作帮助" @click="dialog?.close()">
        <X aria-hidden="true" />
      </Button>
    </header>
    <div class="quickStartContent">
      <section>
        <h3>配置共享和店铺</h3>
        <p>在「设置」检查共享数据库和共享存储。排单端在「店铺管理」添加店铺，其他电脑点「同步」接收店铺列表。</p>
      </section>
      <section>
        <h3>从千帆录入订单</h3>
        <p>打开或刷新千帆，右键点击买家图片，选择店铺，核对订单号和模板，再点「确认排单」。</p>
      </section>
      <section>
        <h3>上传、同步和制作</h3>
        <p>排单端勾选订单并点「上传」，看到「已上传」即共享成功。制作端点「同步」或等后台自动同步，制作结束后点「标记完成」。</p>
      </section>
      <section>
        <h3>分配旧单和归档</h3>
        <p>订单页选「待归属」，核对后分配店铺。选定店铺并切到「已完成」后，可按日期归档，随后在「已归档」中恢复。</p>
      </section>
    </div>
    <footer class="quickStartFooter">
      <Button type="button" variant="outline" @click="openSettings">打开设置</Button>
      <Button type="button" autofocus @click="dialog?.close()">开始使用</Button>
    </footer>
  </dialog>
</template>

<style scoped>
.quickStart {
  width: min(37rem, calc(100% - 2rem));
  max-height: calc(100% - 2rem);
  margin: auto;
  overflow: auto;
  border: 1px solid var(--stroke);
  border-radius: 14px;
  background: var(--color-background);
  color: var(--color-foreground);
  box-shadow: 0 20px 60px #17263a33;
}
.quickStart::backdrop {
  background: #17263a66;
}
.quickStartHeader,
.quickStartFooter {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.875rem 1.25rem;
}
.quickStartHeader {
  justify-content: space-between;
  border-bottom: 1px solid var(--stroke);
}
.quickStartTitle {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}
.quickStartTitle svg {
  width: 1.125rem;
  height: 1.125rem;
  color: var(--color-primary);
}
.quickStartTitle h2 {
  font-size: 1.0625rem;
  font-weight: 650;
}
.quickStartContent {
  display: grid;
  gap: 1rem;
  padding: 1.125rem 1.25rem;
}
.quickStartContent h3 {
  margin-bottom: 0.25rem;
  font-size: 0.875rem;
  font-weight: 650;
}
.quickStartContent p {
  color: var(--color-muted-foreground);
  font-size: 0.875rem;
  line-height: 1.65;
}
.quickStartFooter {
  justify-content: flex-end;
  border-top: 1px solid var(--stroke);
}
</style>
