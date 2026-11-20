import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src-tauri/assets/paidan_core.js', import.meta.url), 'utf8')
const window = { addEventListener() {} }
window.top = window
vm.runInNewContext(source.replace(/\}\)\(\)\s*$/, `
  window.readLayoutNumber = readLayoutNumber
})()`), {
  window,
  location: { origin: 'https://walle.xiaohongshu.com', pathname: '/cstools/fixtures' },
})

test('merchant remark layout numbers retain their prefix and leading zeros', () => {
  assert.equal(window.readLayoutNumber(['请排单 YY-00032，谢谢']), 'yy-00032')
  assert.equal(window.readLayoutNumber(['商家 CH-00003', '已确认 ch-00003']), 'ch-00003')
  assert.equal(window.readLayoutNumber(['x-00195']), 'x-00195')
  assert.equal(window.readLayoutNumber(['请使用 CH-00Ab']), 'ch-00Ab')
})

test('distinct or malformed tokens are not filled in automatically', () => {
  assert.equal(window.readLayoutNumber(['ch-003 或 x-009']), '')
  assert.equal(window.readLayoutNumber(['yy-003', 'yy-007']), '')
  assert.equal(window.readLayoutNumber(['SHCH-003 ch-003-4 yy- 3 x20']), '')
  assert.equal(window.readLayoutNumber([`ch-${'A'.repeat(65)}`]), '')
})
