import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const catalog = readFileSync(new URL('../src-tauri/assets/templates.json', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src-tauri/assets/vagaga_capture.js', import.meta.url), 'utf8')
  .replace('/* VAGAGA_TEMPLATES */ []', catalog)

function fixture({ document, bridge, startPoll = setInterval, stopPoll = clearInterval } = {}) {
  const window = { addEventListener(type, callback) { this[type] = callback }, qianfanBridge: bridge }
  window.top = window
  vm.runInNewContext(source.replace(/\}\)\(\)\s*$/, `
    window.readLayoutNumber = readLayoutNumber
    window.parseOrderPanel = parseOrderPanel
    window.requestTemplateCatalog = () => requestTemplateCatalog()
    window.captureWith = onCapture => { capture = onCapture }
    window.buildSection = (templates, onCapture) => {
      capture = onCapture
      return buildSection({}, false, templates, () => {})
    }
  })()`), {
    window, document, setTimeout, clearTimeout, setInterval: startPoll, clearInterval: stopPoll,
    getComputedStyle: element => element.style,
    requestAnimationFrame() {},
    location: { origin: 'https://walle.xiaohongshu.com', pathname: '/cstools/fixtures' },
  })
  return window
}

const window = fixture()
const custom = { code: 'A100', name: '自定义模板', id: '0123456789abcdef0123456789abcdef' }

function panelDocument(specification, textContent = `待发货P1234567890123456规格/尺寸: ${specification} ¥12x2`) {
  const panel = {
    textContent,
    querySelectorAll: () => [],
  }
  return {
    querySelector: selector => selector === '.farmer-chat__right' ? panel : null,
    createElement: tag => ({
      tagName: tag.toUpperCase(),
      children: [],
      style: { cssText: '' },
      appendChild(child) { this.children.push(child); child.parentNode = this },
      remove() { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1) },
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

test('the same platform menu reopens on the first poll while a previous capture is pending', async () => {
  const document = panelDocument('A05草莓甜心')
  const menu = document.createElement('div')
  menu.style = {
    display: 'block', opacity: '1', visibility: '', priority: '',
    getPropertyValue() { return this.visibility },
    getPropertyPriority() { return this.priority },
    setProperty(_name, value, priority) { this.visibility = value; this.priority = priority },
  }
  menu.getBoundingClientRect = () => ({ left: 100, top: 100, width: 120, height: 64 })
  menu.querySelector = selector => menu.children.find(child => '#' + child.id === selector)
  document.querySelectorAll = selector => selector === '.copy-paste' ? [menu] : []

  let poll
  const sent = []
  const capture = fixture({
    document,
    bridge: raw => capture.__qfReceiveTemplateCatalog(JSON.parse(raw).requestId, JSON.parse(catalog)),
    startPoll: callback => { poll = callback; return 1 },
    stopPoll: () => { poll = null },
  })
  capture.captureWith(img => {
    sent.push(img)
    return new Promise(() => {})
  })
  async function rightClick(img) {
    capture.contextmenu({ target: { closest: () => img }, clientX: 100, clientY: 100 })
    assert.equal(typeof poll, 'function')
    poll()
    await Promise.resolve()
    return menu.children[0]
  }
  const firstImage = { clientWidth: 100 }, secondImage = { clientWidth: 100 }
  const first = await rightClick(firstImage)
  first.children[4].children[0].click({ stopPropagation() {} })
  assert.equal(menu.style.visibility, 'hidden')
  assert.equal(menu.style.display, 'block')

  const second = await rightClick(secondImage)
  assert.equal(menu.style.visibility, '')
  assert.notEqual(second, first)
  assert.equal(menu.children.length, 1)
  second.children[4].children[0].click({ stopPropagation() {} })
  assert.deepEqual(sent, [firstImage, secondImage])
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

test('reads actual placed times and prefers the paid amount over the line item subtotal', () => {
  const document = panelDocument('', [
    '待发货P1234567890123456下单时间：2026/11/2 9:30 支付时间 2026-11-02 09:45:00',
    '规格/尺寸: A01爱心 ¥12.35 x2 规格/尺寸: A13圣诞 ￥10.10×3 实付款：¥52.50',
    '待发货P1234567890123457下单2026年11月3日 10:15:20 ¥12.35x2 ￥10.10×3',
  ].join(' '))
  const [first, second] = fixture({ document }).parseOrderPanel(JSON.parse(catalog))
  assert.equal(first.orderedAt, '2026-11-02T09:30:00+08:00')
  assert.equal(first.amount, '52.50')
  assert.equal(first.specs[0].qty, 2)
  assert.equal(first.specs[1].qty, 3)
  assert.equal(second.orderedAt, '2026-11-03T10:15:20+08:00')
  assert.equal(second.amount, '55.00')
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

test('preselects A05 Strawberry Sweetheart and allows manual A13 Christmas selection', () => {
  const builtIns = JSON.parse(catalog)
  const capture = fixture({ document: panelDocument('A05草莓甜心') })
  let sent
  const section = capture.buildSection(builtIns, (_img, _orderNo, templates) => {
    sent = JSON.parse(JSON.stringify(templates))
  })
  const list = section.children[2].children
  const row = name => list.find(item => item.children.some(child => child.textContent === name))
  const strawberry = row('草莓甜心')
  const christmas = row('欢乐圣诞')
  assert.ok(strawberry && christmas)
  assert.equal(row('蓝色款'), undefined)
  assert.equal(strawberry.children[1].textContent, 'A05')
  assert.equal(christmas.children[1].textContent, 'A13')
  assert.equal(strawberry.children[3].style.display, 'inline-flex')

  const event = { stopPropagation() {} }
  christmas.click(event)
  section.children[4].children[0].click(event)
  assert.deepEqual(sent, [{ id: '草莓.png', qty: 2 }, { id: '圣诞.png', qty: 1 }])
})

test('preselects built-in A13 Christmas ahead of a saved template with the same code', () => {
  const builtIns = JSON.parse(catalog)
  const legacy = { ...custom, code: 'A13' }
  const capture = fixture({ document: panelDocument('A13欢乐圣诞') })
  let sent
  const section = capture.buildSection([...builtIns, legacy], (_img, _orderNo, templates) => {
    sent = JSON.parse(JSON.stringify(templates))
  })
  const list = section.children[2].children
  const row = name => list.find(item => item.children[2].textContent === name)
  assert.equal(row('欢乐圣诞').children[3].style.display, 'inline-flex')
  assert.equal(row(legacy.name).children[3].style.display, 'none')
  section.children[4].children[0].click({ stopPropagation() {} })
  assert.deepEqual(sent, [{ id: '圣诞.png', qty: 2 }])
})
