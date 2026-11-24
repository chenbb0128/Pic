// 从 web 端权威源同步模板目录：
//   读取 web/public/embedded/heart-star/index.html 的 select#template 下拉框，
//   校验客户端内置编辑器包含同一套模板选项，
//   校验 src-tauri/assets/templates.json 的排单模板 ID，并打印对照。
// 用法: node tool/sync_templates.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const project = join(here, '..')
const webSource = join(project, '..', 'web', 'public', 'embedded', 'heart-star', 'index.html')
const desktopSource = join(project, 'public', 'embedded', 'heart-star', 'index.html')
const catalog = join(project, 'src-tauri', 'assets', 'templates.json')

function readOptions(source) {
  const html = readFileSync(source, 'utf8')
  const selectMatch = html.match(/<select\b[^>]*\bid="template"[^>]*>([\s\S]*?)<\/select>/)
  if (!selectMatch) throw new Error(`未找到 select#template 模板下拉框：${source}`)
  return [...selectMatch[1].matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)].map(
    m => ({ id: m[1], label: m[2] }),
  )
}

const options = readOptions(webSource)
const webIds = new Set(options.map(o => o.id))
const desktopIds = new Set(readOptions(desktopSource).map(o => o.id))
const missingInDesktop = options.filter(o => !desktopIds.has(o.id))

const baked = JSON.parse(readFileSync(catalog, 'utf8'))

const missing = baked.filter(t => !webIds.has(t.id))
const unused = options.filter(o => !o.id.startsWith('自定义') && !baked.some(t => t.id === o.id))

console.log(`web 模板下拉框共 ${options.length} 项；排单目录内嵌 ${baked.length} 项`)
for (const t of baked) {
  const ok = webIds.has(t.id)
  console.log(` ${ok ? '✓' : '✗'} ${t.code === t.name ? t.name : `${t.code} ${t.name}`} → ${t.id}`)
}
if (missing.length) {
  console.error('\n✗ 以下排单模板在 web 端已不存在，请修正 templates.json：')
  for (const t of missing) console.error('  -', t.id)
}
if (unused.length) {
  console.log('\nℹ web 端尚未纳入排单目录的模板：')
  for (const o of unused) console.log('  -', o.id, o.label)
}
if (missingInDesktop.length) {
  console.error('\n✗ 以下 Web 模板尚未加入客户端的内置编辑器：')
  for (const o of missingInDesktop) console.error('  -', o.id, o.label)
}
if (missing.length || missingInDesktop.length) process.exit(1)
console.log('\n同步校验通过。')
