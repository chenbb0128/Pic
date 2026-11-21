// 给 vagaga_capture.js 注入菜单替换 emoji 为 SVG 图标
import { readFileSync, writeFileSync } from 'node:fs'

const p = new URL('../src-tauri/assets/vagaga_capture.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
let s = readFileSync(p, 'utf8')

const ICONS = {
  receipt:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h16v20l-3-2-3 2-3-2-3 2-3-2-1 2V2z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/></svg>',
}

// 1) 注入图标定义（TEMPLATES 之后）
const templatesEnd = s.indexOf(']', s.indexOf('const TEMPLATES'))
if (templatesEnd < 0) throw new Error('TEMPLATES 未找到')
const insertAt = s.indexOf('\n', templatesEnd) + 1
const iconDef = `
  // SF-Symbols 风格内联图标（shadow DOM 内可用，无外部依赖）
  const ICONS = {
    receipt: '${ICONS.receipt}',
  }
`
s = s.slice(0, insertAt) + iconDef + s.slice(insertAt)

// 2) 区块标题 🧾 排单 → receipt 图标 + 文字
s = s.replace(
  '<span style="font-weight:700;">🧾 排单</span>',
  `<span style="font-weight:700;display:inline-flex;align-items:center;gap:6px;">${ICONS.receipt}排单</span>`,
)

// 3) 确认排单按钮去 emoji
s = s.replace('>🧾 确认排单</button>', '>确认排单</button>')

// 4) toast 去符号前缀
s = s.replace(
  "'⚠ 已提交排单（原图拉取失败，本次为缩图 ' + (bytes / 1024).toFixed(0) + 'KB）'",
  "'已提交排单（原图拉取失败，本次为缩图 ' + (bytes / 1024).toFixed(0) + 'KB）'",
)
s = s.replace(
  "'✓ 已提交排单：原图 ' + (bytes / 1024).toFixed(0) + 'KB，' + templates.length + ' 个模板'",
  "'已提交排单：原图 ' + (bytes / 1024).toFixed(0) + 'KB，' + templates.length + ' 个模板'",
)
s = s.replace("toast('✗ 提交失败：'", "toast('提交失败：'")

writeFileSync(p, s)
console.log('core.js 图标替换完成')
