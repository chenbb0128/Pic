// ============================================================
// 排单小助手注入核心（排单中心版）
// 右键图片 → 平台菜单弹出 → 排单区块嵌入菜单（平台项 + 模板选择一体）
//   · 嵌入后自动检测溢出：菜单底部超出窗口时整体上移，装不下则区块内滚动
//   · 平台菜单 5s 未出现（如右面板商品图）→ 降级独立面板
// 传输协议：window.qianfanBridge(JSON)（由排单中心 CDP 注入器提供）
// payload: { type:'paidan.capture', b64, mime, scaled, context:{orderNo, layoutNumber}, templates:[{id,qty}] }
// ============================================================
;(function () {
  function onWorkbench() {
    return window === window.top
      && location.origin === 'https://walle.xiaohongshu.com'
      && location.pathname.startsWith('/cstools/')
      && !location.pathname.startsWith('/cstools/login')
  }
  if (!onWorkbench()) return
  var VER = 'v15'
  // 已打开的旧版页面需刷新。旧脚本没有注销入口，重复注入会同时触发两套菜单。
  if (window.__QF_CORE__ === true) return
  window.__QF_CORE__ = true
  window.__QF_CORE_VER__ = VER

  const TAG = '[qf-core]'
  const SECTION_ID = '__qf_section__'
  const PANEL_ID = '__qf_menu__'
  const PLATFORM_MENU_SEL = '.copy-paste'
  const ORDER_NUMBER_PATTERN = /P\d{15,22}(?!\d)/g
  let ctxImg = null

  // 内置目录供没有桌面桥接的页面使用。
  const TEMPLATES = [
    { code: 'A01', name: '爱心款', id: '模板爱心.png' },
    { code: 'A02', name: '爱心横版', id: '爱心横版.png' },
    { code: 'A03', name: '爱心+星星混合版', id: '模板混合.png' },
    { code: 'A04', name: '粉色款', id: '模板粉色.png' },
    { code: 'A05', name: '蓝色款', id: '模板蓝色.png' },
    { code: 'A06', name: '黄色款', id: '模板黄色.png' },
    { code: 'A07', name: '混合竖版', id: '甜心派对.png' },
    { code: 'A08', name: '缤纷糖果版', id: '缤纷糖果.png' },
    { code: 'A09', name: '大头混合横版', id: 'I-ME横版大头.png' },
    { code: 'A10', name: '心动马卡龙款', id: '爱心心动马卡龙.png' },
    { code: 'A11', name: '焦糖秋枫混合豹纹', id: '经典豹纹混合.png' },
    { code: 'A12', name: '奶油黑粉混合豹纹', id: '黑粉奶油混合豹纹.png' },
  ]

  let nextCatalogRequest = 0
  const catalogRequests = new Map()
  window.__qfReceiveTemplateCatalog = (requestId, templates) => {
    catalogRequests.get(requestId)?.(Array.isArray(templates) ? templates : TEMPLATES)
  }

  function requestTemplateCatalog() {
    if (typeof window.qianfanBridge !== 'function') return Promise.resolve(TEMPLATES)
    const requestId = ++nextCatalogRequest
    return new Promise(resolve => {
      const timeout = setTimeout(() => complete(TEMPLATES), 1000)
      const complete = (templates) => {
        clearTimeout(timeout)
        catalogRequests.delete(requestId)
        resolve(templates)
      }
      catalogRequests.set(requestId, complete)
      try {
        send({ type: 'paidan.listTemplates', requestId })
      } catch (_) {
        complete(TEMPLATES)
      }
    })
  }

  // SF-Symbols 风格内联图标（shadow DOM 内可用，无外部依赖）
  const ICONS = {
    receipt: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h16v20l-3-2-3 2-3-2-3 2-3-2-1 2V2z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    save: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg>',
  }

  const log = (...args) => { try { console.log(TAG, ...args) } catch (_) {} }

  function normalizeLayoutNumber(number) {
    return number.replace(/^(ch|yy|x)(?=-)/i, prefix => prefix.toLowerCase())
  }

  function readLayoutNumber(remarks) {
    const numbers = new Set()
    for (const remark of remarks) {
      for (const [, number] of remark.matchAll(/(?:^|[^a-z\d_-])((?:ch|yy|x)-[a-z\d]{1,64})(?![a-z\d_-])/gi)) {
        numbers.add(normalizeLayoutNumber(number))
      }
    }
    return numbers.size === 1 ? numbers.values().next().value : ''
  }

  function readOrderRemarks(panel) {
    const remarksByNumber = new Map()
    for (const card of panel.querySelectorAll('.order-card')) {
      if (!card.getClientRects().length) continue
      const numberText = card.querySelector('.order-card-title-id .id-text')?.textContent || ''
      const orderNumber = numberText.match(ORDER_NUMBER_PATTERN)?.[0]
      if (!orderNumber) continue
      if (!remarksByNumber.has(orderNumber)) remarksByNumber.set(orderNumber, [])
      for (const remark of card.querySelectorAll('.delivery-row-note .mark-note-text')) {
        const value = remark.textContent?.trim()
        if (value && remark.getClientRects().length && !remarksByNumber.get(orderNumber).includes(value)) {
          remarksByNumber.get(orderNumber).push(value)
        }
      }
    }
    return remarksByNumber
  }

  /* ---------- 订单面板解析：订单号 + 每规格数量 ---------- */
  // 右侧订单面板（.farmer-chat__right）文本结构（实测）：
  //   待发货P<订单号>下单<时间>支付<时间> <商品名> <规格文本> 规格/尺寸: <规格> 发送
  //   ...¥<单价>x<N>商品总价...共 <包裹件数> 件...
  // 注意：xN 是购买数量（ASCII x）；"共 N 件" 是包裹件数，不要混用。
  function parseOrderPanel(templates) {
    const panel = document.querySelector('.farmer-chat__right')
    if (!panel) return []
    const text = (panel.textContent || '').replace(/\s+/g, ' ')
    const matches = [...text.matchAll(ORDER_NUMBER_PATTERN)]
    if (!matches.length) return []
    const remarksByOrder = readOrderRemarks(panel)
    const orders = []
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length
      const segment = text.slice(start, end)
      const orderNumber = matches[i][0]
      const specs = []
      const specMatches = [...segment.matchAll(/规格\/尺寸:\s*(\S+)/g)]
      const qtyMatches = [...segment.matchAll(/¥[\d.]+x(\d+)/g)]
      for (let s = 0; s < specMatches.length; s++) {
        const specText = specMatches[s][1]
        const code = specText.match(/A\d{2,}/i)?.[0].toUpperCase()
        if (!code) continue
        const template = templates.find(t => t.code === code)
        if (!template) continue
        const qty = s < qtyMatches.length ? parseInt(qtyMatches[s][1], 10) : 1
        specs.push({ code, webId: template.id, qty: qty > 0 ? qty : 1 })
      }
      // 订单元数据：状态词 / 金额（首个单价×数量）/ 规格文本（制作端悬浮卡展示）
      const statusMatch = segment.match(/(待发货|待付款|待收货|已完成|已发货|交易成功|退款中)/)
      let amount = ''
      if (qtyMatches.length) {
        const price = parseFloat(segment.match(/¥([\d.]+)x\d+/)?.[1] || '0')
        const qty = parseInt(qtyMatches[0][1], 10)
        if (price > 0) amount = (price * qty).toFixed(2)
      }
      const remarks = remarksByOrder.get(orderNumber) || []
      orders.push({
        orderNumber,
        specs,
        status: statusMatch ? statusMatch[1] : '',
        amount,
        specText: specs.map(sp => `${sp.code}×${sp.qty}`).join(' '),
        layoutNumber: readLayoutNumber(remarks),
        merchantRemark: remarks.join('\n').slice(0, 4096),
      })
    }
    return orders
  }

  /* ---------- 事件入口 ---------- */
  window.addEventListener(
    'contextmenu',
    e => {
      const img = e.target && e.target.closest ? e.target.closest('img') : null
      if (!img || img.clientWidth < 40) return // 仅处理 ≥40px 图片，小图标/文字放行
      ctxImg = img
      waitForPlatformMenu(img, e.clientX, e.clientY)
    },
    true,
  )

  /* ---------- 等待平台菜单（最长 5s）并嵌入排单区块 ---------- */
  let pollTimer = null
  let pollToken = 0
  function waitForPlatformMenu(img, x, y) {
    const token = ++pollToken
    const catalog = requestTemplateCatalog()
    if (pollTimer) clearInterval(pollTimer)
    let tries = 0
    pollTimer = setInterval(() => {
      tries++
      const menu = findVisiblePlatformMenu(x, y)
      if (menu) {
        clearInterval(pollTimer)
        pollTimer = null
        void catalog.then(templates => {
          if (token !== pollToken || findVisiblePlatformMenu(x, y) !== menu) return
          embedSection(menu, img, templates)
        })
        return
      }
      if (tries >= 100) {
        clearInterval(pollTimer)
        pollTimer = null
        void catalog.then(templates => {
          if (token !== pollToken) return
          openStandalone(img, x, y, templates)
          log('平台菜单未出现，降级独立面板')
        })
      }
    }, 50)
  }

  function findVisiblePlatformMenu(x, y) {
    for (const el of document.querySelectorAll(PLATFORM_MENU_SEL)) {
      let st, r
      try { st = getComputedStyle(el); r = el.getBoundingClientRect() } catch (_) { continue }
      if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) continue
      if (r.width < 40 || r.height < 40) continue
      if (Math.abs(r.left - x) > 420 || Math.abs(r.top - y) > 420) continue
      return el
    }
    return null
  }

  /* ---------- 嵌入 + 溢出校正 ---------- */
  function embedSection(container, img, templates) {
    try {
      const existing = container.querySelector('#' + SECTION_ID)
      if (existing) existing.remove()
      const section = buildSection(img, false, templates)
      // 平台菜单容器加宽到区块宽度（原宽度装不下排单区块）
      container.style.width = '392px'
      container.style.boxSizing = 'border-box'
      container.style.overflowX = 'hidden'
      container.appendChild(section)
      // 溢出校正：右缘/下缘越界收敛
      requestAnimationFrame(() => {
        const rect = container.getBoundingClientRect()
        if (rect.right > window.innerWidth - 8) {
          container.style.left = Math.max(4, window.innerWidth - 8 - rect.width) + 'px'
        }
        const overflow = rect.bottom - (window.innerHeight - 8)
        if (overflow > 0) {
          const currentTop = parseFloat(container.style.top) || rect.top
          container.style.top = Math.max(4, currentTop - overflow) + 'px'
        }
        // 区块自身过高装不下 → 内部滚动
        const spaceBelow = window.innerHeight - 8 - section.getBoundingClientRect().top
        if (spaceBelow > 0) section.style.maxHeight = Math.max(160, spaceBelow) + 'px'
        section.style.overflowY = 'auto'
      })
      log('排单区块已嵌入平台菜单')
    } catch (err) {
      log('嵌入失败，降级独立面板', err)
      openStandalone(img, 120, 120, templates)
    }
  }

  /* ---------- 独立排单面板（降级） ---------- */
  function hideStandalone() {
    const p = document.getElementById(PANEL_ID)
    if (p) p.remove()
  }

  function openStandalone(img, x, y, templates) {
    hideStandalone()
    const host = document.createElement('div')
    host.id = PANEL_ID
    host.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;'
    const shadow = host.attachShadow({ mode: 'open' })
    const section = buildSection(img, true, templates)
    shadow.appendChild(section)
    document.body.appendChild(host)
    requestAnimationFrame(() => {
      const r = section.getBoundingClientRect()
      const left = Math.max(8, Math.min(x - 40, window.innerWidth - r.width - 8))
      const top = Math.max(8, Math.min(y + 8, window.innerHeight - r.height - 8))
      section.style.position = 'fixed'
      section.style.left = left + 'px'
      section.style.top = top + 'px'
    })
    setTimeout(() => {
      const outside = ev => {
        if (!host.isConnected) return
        if (ev.composedPath().includes(host)) return
        hideStandalone()
        document.removeEventListener('mousedown', outside, true)
      }
      document.addEventListener('mousedown', outside, true)
    }, 0)
  }

  /* ---------- 排单区块构建（dark=独立面板配色） ----------
     结构：头部（订单号和备注编号）→ 模板清单行（勾选框 + 编号 + 名称 + 份数步进器）→ 底部确认排单
     嵌入模式：区块透明融入平台菜单容器，行风格与平台菜单项一致 */
  function buildSection(img, dark, templates) {
    const section = document.createElement('div')
    section.id = SECTION_ID
    section.style.cssText =
      'width:100%;box-sizing:border-box;display:flex;flex-direction:column;' +
      (dark
        ? 'background:rgba(24,27,38,.96);backdrop-filter:blur(14px);color:#e8eaf0;' +
          'border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:6px 4px;' +
          'box-shadow:0 12px 40px rgba(0,0,0,.45);'
        : 'background:transparent;color:#2a2f3a;padding:2px 0 4px;') +
      'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;user-select:none;'

    const panelOrders = parseOrderPanel(templates)
    const selected = new Map() // webId → qty
    const cellSyncs = new Map() // webId → 行视图同步函数

    // 头部：订单号（单订单输入框；多订单下拉切换）
    const head = document.createElement('div')
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px 4px;'
    const ordLabel = document.createElement('span')
    ordLabel.textContent = '订单'
    ordLabel.style.cssText = 'flex-shrink:0;color:' + (dark ? '#9aa3b5' : '#8b93a5') + ';font-size:11px;'
    head.appendChild(ordLabel)
    let ordInput
    if (panelOrders.length > 1) {
      ordInput = document.createElement('select')
      for (const order of panelOrders) {
        const option = document.createElement('option')
        option.value = order.orderNumber
        option.textContent = order.orderNumber + '（' + order.specs.map(s => s.code + '×' + s.qty).join(' ') + '）'
        ordInput.appendChild(option)
      }
    } else {
      ordInput = document.createElement('input')
      ordInput.placeholder = '订单号（自动识别，可修改）'
      ordInput.spellcheck = false
      ordInput.value = panelOrders[0]?.orderNumber || ''
      ordInput.style.cssText = 'flex:1;min-width:0;padding:4px 8px;border:1px solid ' +
        (dark ? 'rgba(255,255,255,.16)' : '#d8dbe3') + ';border-radius:7px;background:transparent;color:inherit;outline:none;font:12px sans-serif;'
    }
    ordInput.style.cssText += 'flex:1;min-width:0;box-sizing:border-box;'
    head.appendChild(ordInput)
    section.appendChild(head)

    const layoutRow = document.createElement('label')
    layoutRow.style.cssText = head.style.cssText
    const layoutLabel = document.createElement('span')
    layoutLabel.textContent = '备注编号'
    layoutLabel.style.cssText = ordLabel.style.cssText
    const layoutInput = document.createElement('input')
    layoutInput.placeholder = '例如 ch-00123，可留空'
    layoutInput.autocomplete = 'off'
    layoutInput.spellcheck = false
    layoutInput.style.cssText = 'flex:1;min-width:0;padding:4px 8px;border:1px solid ' +
      (dark ? 'rgba(255,255,255,.16)' : '#d8dbe3') + ';border-radius:7px;background:transparent;color:inherit;font:12px sans-serif;'
    layoutRow.appendChild(layoutLabel)
    layoutRow.appendChild(layoutInput)
    section.appendChild(layoutRow)
    layoutRow.addEventListener('click', ev => ev.stopPropagation())
    layoutInput.addEventListener('keydown', ev => ev.stopPropagation())

    const layoutDrafts = new Map()
    function showLayoutNumber() {
      const orderNumber = ordInput.value.trim()
      layoutInput.value = layoutDrafts.get(orderNumber) ?? panelOrders.find(o => o.orderNumber === orderNumber)?.layoutNumber ?? ''
      layoutInput.setCustomValidity('')
    }
    layoutInput.addEventListener('input', () => {
      layoutDrafts.set(ordInput.value.trim(), layoutInput.value)
      layoutInput.setCustomValidity('')
    })
    ordInput.addEventListener('input', showLayoutNumber)
    ordInput.addEventListener('change', () => {
      showLayoutNumber()
      if (ordInput.tagName === 'SELECT') applyOrderSpecs(panelOrders.find(o => o.orderNumber === ordInput.value))
    })
    showLayoutNumber()

    // 模板清单行（菜单项风格：勾选框 + 编号 + 名称 + 份数）
    const list = document.createElement('div')
    list.style.cssText = 'display:flex;flex-direction:column;'
    for (const t of templates) {
      const row = document.createElement('div')
      row.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer;' +
        'transition:background .12s;'
      row.addEventListener('mouseenter', () => { row.style.background = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)' })
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent' })

      const cbx = document.createElement('span')
      cbx.style.cssText =
        'width:14px;height:14px;flex-shrink:0;border-radius:4px;border:1.5px solid ' +
        (dark ? 'rgba(255,255,255,.3)' : '#c5c9d4') + ';display:inline-flex;align-items:center;justify-content:center;'
      const checkSvg = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      const code = document.createElement('span')
      code.textContent = t.code
      code.style.cssText = 'font-weight:700;color:#5b8cff;font-size:11px;min-width:28px;flex-shrink:0;'
      const name = document.createElement('span')
      name.textContent = t.name
      name.style.cssText = 'flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;'
      const qty = document.createElement('span')
      qty.style.cssText =
        'display:none;align-items:center;gap:6px;flex-shrink:0;'
      const minus = document.createElement('button')
      minus.textContent = '−'
      minus.style.cssText = 'width:18px;height:18px;border-radius:5px;border:1px solid ' +
        (dark ? 'rgba(255,255,255,.2)' : '#ccc') + ';background:transparent;color:inherit;cursor:pointer;font-size:11px;line-height:1;padding:0;'
      const qtyLabel = document.createElement('b')
      qtyLabel.textContent = '1'
      qtyLabel.style.cssText = 'min-width:14px;text-align:center;font-size:12px;'
      const plus = document.createElement('button')
      plus.textContent = '＋'
      plus.style.cssText = minus.style.cssText
      qty.appendChild(minus); qty.appendChild(qtyLabel); qty.appendChild(plus)
      row.appendChild(cbx); row.appendChild(code); row.appendChild(name); row.appendChild(qty)

      const sync = () => {
        const on = selected.has(t.id)
        cbx.style.background = on ? '#5b8cff' : 'transparent'
        cbx.style.borderColor = on ? '#5b8cff' : dark ? 'rgba(255,255,255,.3)' : '#c5c9d4'
        cbx.innerHTML = on ? checkSvg : ''
        qty.style.display = on ? 'inline-flex' : 'none'
        qtyLabel.textContent = String(selected.get(t.id) ?? 1)
        cellSyncs.set(t.id, sync)
        updateTotal()
      }
      row.addEventListener('click', ev => {
        ev.stopPropagation()
        if (selected.has(t.id)) selected.delete(t.id)
        else selected.set(t.id, 1)
        sync()
      })
      minus.addEventListener('click', ev => {
        ev.stopPropagation()
        selected.set(t.id, Math.max(1, (selected.get(t.id) ?? 1) - 1))
        sync()
      })
      plus.addEventListener('click', ev => {
        ev.stopPropagation()
        selected.set(t.id, (selected.get(t.id) ?? 1) + 1)
        sync()
      })
      list.appendChild(row)
      cellSyncs.set(t.id, sync)
    }
    section.appendChild(list)

    // 总数指示：已选件数 vs 订单件数（多规格/多图时保持总数统一对照）
    const pickedTotal = document.createElement('span')
    const orderTotal = document.createElement('span')
    const totalLine = document.createElement('div')
    totalLine.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:2px 14px 0;font-size:11px;color:' +
      (dark ? '#9aa3b5' : '#8b93a5') + ';'
    totalLine.appendChild(pickedTotal)
    totalLine.appendChild(orderTotal)
    section.appendChild(totalLine)

    function updateTotal() {
      let n = 0
      for (const q of selected.values()) n += q
      pickedTotal.textContent = '已选 ' + n + ' 件'
      const order = panelOrders.find(o => o.orderNumber === ordInput.value) || panelOrders[0]
      if (order && order.specs.length) {
        const m = order.specs.reduce((a, s) => a + s.qty, 0)
        orderTotal.textContent = '订单 ' + m + ' 件'
        orderTotal.style.color = n === m ? '' : (dark ? '#ff9a6b' : '#d9663f')
      } else {
        orderTotal.textContent = ''
      }
    }

    // 底部：确认排单（全宽）
    const foot = document.createElement('div')
    foot.style.cssText = 'padding:6px 12px 8px;'
    const confirmBtn = document.createElement('button')
    confirmBtn.textContent = '确认排单'
    confirmBtn.style.cssText =
      'width:100%;height:32px;border:none;border-radius:8px;cursor:pointer;' +
      'background:linear-gradient(135deg,#4f7dff,#6a5bff);color:#fff;font:600 13px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'display:inline-flex;align-items:center;justify-content:center;gap:6px;'
    confirmBtn.innerHTML = ICONS.receipt + '<span>确认排单</span>'
    foot.appendChild(confirmBtn)
    section.appendChild(foot)

    // 规格 → 模板预选（按订单面板解析的规格与份数）
    function applyOrderSpecs(order) {
      if (!order) return
      selected.clear()
      for (const spec of order.specs) selected.set(spec.webId, spec.qty)
      for (const t of templates) cellSyncs.get(t.id)?.()
    }

    confirmBtn.addEventListener('click', ev => {
      ev.stopPropagation()
      if (selected.size === 0) return
      const orderNumber = ordInput.value.trim()
      const order = panelOrders.find(o => o.orderNumber === orderNumber)
      const layoutNumber = normalizeLayoutNumber(layoutInput.value.trim())
      if (layoutNumber && !/^(?:ch|yy|x)-[a-zA-Z\d]{1,64}$/.test(layoutNumber)) {
        layoutInput.setCustomValidity('请输入 ch-、yy- 或 x- 开头的完整编号，例如 ch-00123')
        layoutInput.reportValidity()
        return
      }
      // 订单规格决定初始勾选，入库使用最终选择。
      const picked = Array.from(selected, ([id, qty]) => ({ id, qty }))
      if (dark) hideStandalone()
      else {
        const menu = document.querySelector(PLATFORM_MENU_SEL)
        if (menu) menu.style.display = 'none'
      }
      capture(img, orderNumber, picked, { ...order, layoutNumber })
    })

    // 初始：按第一个订单的规格预选
    if (panelOrders.length) applyOrderSpecs(panelOrders[0])
    window.__qfMenuState = () => ({
      panelOrders: panelOrders.map(o => ({ orderNumber: o.orderNumber, specs: o.specs, layoutNumber: o.layoutNumber })),
      selected: [...selected.entries()].map(([id, qty]) => ({ id, qty })),
      parsedSpecCount: panelOrders.reduce((n, o) => n + o.specs.length, 0),
    })
    return section
  }


  /* ---------- 订单号启发式识别 ---------- */
  function detectOrderNumber() {
    try {
      const text = (document.body && document.body.innerText) || ''
      const match = text.match(/\bP\d{12,22}\b/)
      return match ? match[0] : ''
    } catch (_) {
      return ''
    }
  }

  /* ---------- 抓图 + 回传 ---------- */
  // 千帆 arkgoods 原图地址规则（与订单素材台 EVA 拖入一致）：
  // 去掉 imageView2/ 缩图参数，保留其余参数 → 未缩放原图
  function originalUrl(src) {
    try {
      const u = new URL(src, location.href)
      if (u.protocol !== 'https:' || u.hostname !== 'qimg.xiaohongshu.com') return null
      if (!/^\/arkgoods\/[a-zA-Z0-9]+$/.test(u.pathname)) return null
      const parts = u.search ? u.search.slice(1).split('&').filter(Boolean) : []
      if (parts.some(p => /^(?:imageMogr2|imageSlim|watermark|thumbnail|x-oss-process)(?:[\/=]|$)/i.test(decodeURIComponent(p)))) return null
      const kept = parts.filter(p => !decodeURIComponent(p).startsWith('imageView2/'))
      return (
        'https://qimg.xiaohongshu.com' +
        u.pathname +
        (kept.length ? '?' + kept.join('&') : '')
      )
    } catch (_) {
      return null
    }
  }

  async function fetchAsB64(url) {
    const resp = await fetch(url, { credentials: 'include' })
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    const blob = await resp.blob()
    return { bytes: blob.size, mime: blob.type || '', b64: blob.size ? toB64(await blob.arrayBuffer()) : null }
  }

  async function capture(img, orderNumber, templates, meta) {
    if (!onWorkbench()) return
    const capturedAt = Date.now()
    try {
      const src = (img && img.src) || ''
      let b64 = null
      let bytes = 0
      let mime = ''
      let scaled = false
      let sourceQuality = 'unknown'
      if (src) {
        const original = originalUrl(src)
        if (original && original !== src) {
          try {
            ;({ bytes, mime, b64 } = await fetchAsB64(original))
            if (b64) sourceQuality = 'original'
          } catch (_) {
            scaled = true // 原图拉取失败，退回气泡缩图并明确标记
            sourceQuality = 'scaled'
          }
        }
        if (!b64) {
          ;({ bytes, mime, b64 } = await fetchAsB64(src))
          if (original === src && b64) sourceQuality = 'original'
        }
      }
      send({
        type: 'paidan.capture',
        href: location.href,
        imgSrc: src.slice(0, 500),
        bytes,
        mime,
        b64,
        scaled,
        sourceQuality,
        ts: capturedAt,
        context: {
          title: document.title,
          orderNo: orderNumber,
          status: meta?.status || '',
          amount: meta?.amount || '',
          specText: meta?.specText || '',
          merchantRemark: meta?.merchantRemark || '',
          layoutNumber: meta?.layoutNumber || '',
        },
        templates,
      })
      log('captured', src.slice(0, 80), bytes + 'B', mime, sourceQuality, templates.length + ' 模板')
      toast(
        scaled
          ? '已提交排单（原图拉取失败，本次为缩图 ' + (bytes / 1024).toFixed(0) + 'KB）'
          : '已提交排单：' + (sourceQuality === 'original' ? '原图 ' : '来源未确认的图片 ') + (bytes / 1024).toFixed(0) + 'KB，' + templates.length + ' 个模板',
      )
    } catch (err) {
      send({ type: 'paidan.error', error: String(err), ts: Date.now() })
      toast('提交失败：' + String(err).slice(0, 60), 'error')
      log('capture error', err)
    }
  }

  /* ---------- 可见反馈 toast ---------- */
  function toast(msg, kind = 'ok') {
    try {
      const t = document.createElement('div')
      t.textContent = msg
      t.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
        'background:' + (kind === 'ok' ? '#10b981' : '#dc2626') + ';color:#fff;' +
        'font:13px/20px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:10px 16px;' +
        'border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.3);transition:opacity .3s;'
      document.body.appendChild(t)
      setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 350) }, 2400)
    } catch (_) {}
  }

  /* ---------- 传输层 ---------- */
  function send(payload) {
    const raw = JSON.stringify(payload)
    if (typeof window.qianfanBridge === 'function') {
      window.qianfanBridge(raw)
    } else {
      ;(window.__qfQueue = window.__qfQueue || []).push(raw)
    }
  }

  function toB64(buf) {
    const u8 = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    }
    return btoa(s)
  }

  log(`core ${VER} injected on`, location.href)
})()
