import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src-tauri/assets/vagaga_capture.js', import.meta.url), 'utf8')
function fixture({ document, bridge } = {}) {
  const window = { addEventListener() {}, qianfanBridge: bridge }
  window.top = window
  vm.runInNewContext(source.replace(/\}\)\(\)\s*$/, `
    window.readLayoutNumber = readLayoutNumber
    window.parseOrderPanel = parseOrderPanel
    window.requestTemplateCatalog = () => requestTemplateCatalog()
    window.buildSection = (templates, onCapture) => {
      capture = onCapture
      return buildSection({}, false, templates)
    }
  })()`), {
    window, document, setTimeout, clearTimeout,
    location: { origin: 'https://walle.xiaohongshu.com', pathname: '/cstools/fixtures' },
  })
  return window
}

const window = fixture()
const custom = { code: 'A100', name: '自定义模板', id: '0123456789abcdef0123456789abcdef' }

function panelDocument(specification) {
  const panel = {
    textContent: `待发货P1234567890123456规格/尺寸: ${specification} ¥12x2`,
    querySelectorAll: () => [],
  }
  return {
    querySelector: selector => selector === '.farmer-chat__right' ? panel : null,
    createElement: tag => ({
      tagName: tag.toUpperCase(),
      children: [],
      style: { cssText: '' },
      appendChild(child) { this.children.push(child) },
      addEventListener(type, callback) { this[type] = callback },
      setCustomValidity() {},
    }),
  }
}

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

test('reopening the menu requests the latest enabled runtime catalog', async () => {
  const builtIn = { code: 'A01', name: '爱心款', id: '模板爱心.png' }
  const responses = [[builtIn], [builtIn, custom], [builtIn]]
  const requests = []
  const capture = fixture({ bridge: raw => {
    const payload = JSON.parse(raw)
    requests.push(payload)
    capture.__qfReceiveTemplateCatalog(payload.requestId, responses.shift())
  } })
  assert.deepEqual(await capture.requestTemplateCatalog(), [builtIn])
  assert.deepEqual(await capture.requestTemplateCatalog(), [builtIn, custom])
  assert.deepEqual(await capture.requestTemplateCatalog(), [builtIn])
  assert.deepEqual(requests.map(({ type, requestId }) => [type, requestId]), [
    ['paidan.listTemplates', 1], ['paidan.listTemplates', 2], ['paidan.listTemplates', 3],
  ])
})

test('uses the built-in catalog when the catalog bridge is unavailable', async () => {
  const templates = await fixture().requestTemplateCatalog()
  assert.equal(templates[0].code, 'A01')
  assert.equal(templates[0].id, '模板爱心.png')
})

test('matches the complete custom code in the order specification', () => {
  const document = panelDocument('A100自定义')
  const capture = fixture({ document })
  const templates = [{ code: 'A10', id: '内置.png' }, custom]
  const [order] = capture.parseOrderPanel(templates)
  assert.equal(order.specs.length, 1)
  assert.equal(order.specs[0].code, 'A100')
  assert.equal(order.specs[0].webId, custom.id)
  assert.equal(order.specs[0].qty, 2)
})

test('submits manually selected templates alongside recognized order specifications', () => {
  const capture = fixture({ document: panelDocument('A01爱心') })
  const builtIn = { code: 'A01', name: '爱心款', id: '模板爱心.png' }
  let sent
  const section = capture.buildSection([builtIn, custom], (_img, _orderNo, templates) => {
    sent = JSON.parse(JSON.stringify(templates))
  })
  const event = { stopPropagation() {} }
  const customRow = section.children[2].children[1]
  customRow.click(event)
  customRow.children[3].children[2].click(event)
  section.children[4].children[0].click(event)
  assert.deepEqual(sent, [{ id: builtIn.id, qty: 2 }, { id: custom.id, qty: 2 }])
})
