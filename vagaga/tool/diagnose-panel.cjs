// 订单面板解析诊断：在千帆工作台页面执行解析逻辑，输出每一步结果
const fs = require('fs')
const path = require('path')

class CDP {
  constructor(url) { this.seq = 0; this.pending = new Map(); this.ws = new WebSocket(url) }
  open() { return new Promise((ok, err) => { this.ws.onopen = ok; this.ws.onerror = err }) }
  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)) }, timeoutMs)
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v) }, reject: e => { clearTimeout(t); reject(e) } })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  start() {
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      }
    }
  }
}

const EXPRESSION = String.raw`(() => {
  const out = {}
  const panel = document.querySelector('.farmer-chat__right')
  out.panelExists = !!panel
  if (!panel) return JSON.stringify(out)
  const raw = panel.textContent || ''
  const text = raw.replace(/\s+/g, ' ')
  out.panelText = text.slice(0, 700)
  const pMatches = [...text.matchAll(/P\d{15,22}/g)]
  out.pNumbers = pMatches.map(m => m[0])
  const specMatches = [...text.matchAll(/规格\/尺寸:\s*(\S+)/g)]
  out.specs = specMatches.map(m => m[1])
  const qtyMatches = [...text.matchAll(/¥[\d.]+x(\d+)/g)]
  out.xQty = qtyMatches.map(m => m[1])
  out.skuVariants = panel.querySelectorAll('.sku-card-info-variant').length
  return JSON.stringify(out)
})()`

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const t = list.find(t => t.type === 'page' && /walle\.xiaohongshu\.com/.test(t.url) && !/login/.test(t.url))
  if (!t) { console.error('工作台 target 未找到'); process.exit(1) }
  const cdp = new CDP(t.webSocketDebuggerUrl)
  await cdp.open(); cdp.start()
  const r = await cdp.send('Runtime.evaluate', { expression: EXPRESSION, returnByValue: true })
  if (r.result.exceptionDetails) {
    console.error('页面内异常:', JSON.stringify(r.result.exceptionDetails, null, 2))
  } else {
    console.log('解析结果:', JSON.parse(r.result.value, null, 2))
  }
  process.exit(0)
}

main().catch(e => { console.error('failed:', e.message); process.exit(1) })
