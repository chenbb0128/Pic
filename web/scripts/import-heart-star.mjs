// Mechanical import of the supplied standalone tool; no script from it is executed.
// Usage: node scripts/import-heart-star.mjs <source.html>
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

if (!process.argv[2]) throw new Error('请提供独立版 HTML 路径。')
const source = await readFile(process.argv[2], 'utf8')
if (!source.includes('function buildCustomLayout(') || !source.includes('const templateSources=')) {
  throw new Error('源文件不是预期的爱心星星 v2.3 工具，未导入。')
}
const output = fileURLToPath(new URL('../public/embedded/heart-star/', import.meta.url))
await mkdir(join(output, 'assets'), { recursive: true })
const images = new Map()
let html = source.replace(/data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)/g, (_uri, type, base64) => {
  const bytes = Buffer.from(base64, 'base64')
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20)
  const name = `${hash}.${type === 'jpeg' ? 'jpg' : type}`
  images.set(name, bytes)
  return `./assets/${name}`
})
if (images.size === 0) throw new Error('未找到模板图片，未导入。')
// Fit the existing shell, while preserving the original tool's responsive layout.
html = html.replace('</head>', `<style id="project-embed">
.top{display:none}
.app{max-width:none;margin:0;padding:12px;gap:12px}
@media(max-width:850px){.app{padding:8px;gap:8px}}
</style></head>`)
await Promise.all([...images].map(([name, bytes]) => writeFile(join(output, 'assets', name), bytes)))
await writeFile(join(output, 'index.html'), html, 'utf8')
console.log(`已导入 ${images.size} 张图片；HTML ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB。`)
