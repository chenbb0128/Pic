// 从 web 端权威源同步模板目录：
//   读取 web/public/embedded/heart-star/index.html 的 select#template 下拉框，
//   校验 src-tauri/assets/vagaga_capture.js 内嵌 TEMPLATES 目录的 id 全部有效，
//   并打印 A01–A12 对照（若 web 模板有增删，先更新 vagaga_capture.js 的 TEMPLATES）。
// 用法: node tool/sync_templates.mjs [--json]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const project = join(here, '..')
const webSource = join(project, '..', 'web', 'public', 'embedded', 'heart-star', 'index.html')
const coreAsset = join(project, 'src-tauri', 'assets', 'vagaga_capture.js')

const html = readFileSync(webSource, 'utf8')
const selectMatch = html.match(/<select\b[^>]*\bid="template"[^>]*>([\s\S]*?)<\/select>/)
if (!selectMatch) {
  console.error('未在 web 端找到 select#template 模板下拉框')
  process.exit(1)
}
const options = [...selectMatch[1].matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)].map(
  m => ({ id: m[1], label: m[2] }),
)
const webIds = new Set(options.map(o => o.id))

// 提取 vagaga_capture.js 中内嵌的 TEMPLATES 数组
const core = readFileSync(coreAsset, 'utf8')
const arrayMatch = core.match(/const TEMPLATES = (\[[\s\S]*?\])\s*\n/)
if (!arrayMatch) {
  console.error('未找到 vagaga_capture.js 的 TEMPLATES 目录')
  process.exit(1)
}
const baked = [
  ...arrayMatch[1].matchAll(
    /\{\s*code:\s*'([^']+)',\s*name:\s*'([^']+)',\s*id:\s*'([^']+)'\s*\}/g,
  ),
].map(m => ({ code: m[1], name: m[2], id: m[3] }))

const missing = baked.filter(t => !webIds.has(t.id))
const unused = options.filter(o => !o.id.startsWith('自定义') && !baked.some(t => t.id === o.id))

console.log(`web 模板下拉框共 ${options.length} 项；排单目录内嵌 ${baked.length} 项`)
for (const t of baked) {
  const ok = webIds.has(t.id)
  console.log(` ${ok ? '✓' : '✗'} ${t.code} ${t.name} → ${t.id}`)
}
if (missing.length) {
  console.error('\n✗ 以下内嵌模板在 web 端已不存在，请修正 vagaga_capture.js：')
  for (const t of missing) console.error('  -', t.id)
}
if (unused.length) {
  console.log('\nℹ web 端尚未纳入排单目录的模板（如需支持请更新 TEMPLATES 与 A01–A12 对照）：')
  for (const o of unused) console.log('  -', o.id, o.label)
}
if (missing.length) process.exit(1)
console.log('\n同步校验通过。')
