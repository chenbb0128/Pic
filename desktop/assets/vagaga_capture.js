// ============================================================
// 扩展核心 JS（客户端 / Web 版共用）v5 —— 平台菜单融合模式
// 平台图片菜单 = 预创建常驻 DOM 节点 .copy-paste（display 切换显示）
// 右键图片 → 轮询探测其显示 → 把「进入排单」项追加进平台菜单（样式跟随）
// 平台菜单未出现（如右面板商品图）→ 降级独立自绘菜单
// 传输层：window.qianfanBridge(payload)（sidecar 提供），缺省降级 __qfQueue
// ============================================================
;(function () {
  if (window.__QF_CORE__) return
  window.__QF_CORE__ = true

  const TAG = '[qf-core]'
  const ITEM_ID = '__qf_item__'
  const MENU_ID = '__qf_menu__'
  const PLATFORM_MENU_SEL = '.copy-paste'
  let ctxImg = null
  let mergeToken = 0
  let pollTimer = null

  const log = (...args) => { try { console.log(TAG, ...args) } catch (_) {} }

  /* ---------- 事件入口 ---------- */
  window.addEventListener(
    'contextmenu',
    e => {
      const img = e.target && e.target.closest ? e.target.closest('img') : null
      if (!img || img.clientWidth < 40) return // 仅处理 ≥40px 图片，小图标放行
      ctxImg = img
      // 自动化/合成事件：抑制平台 handler，直接独立菜单（PoC 用）
      if (e.isTrusted === false) {
        e.preventDefault()
        e.stopImmediatePropagation()
        buildStandalone(e.clientX, e.clientY, img)
        return
      }
      // 真实用户右键：探测平台菜单并融合
      handle(img, e.clientX, e.clientY)
    },
    true,
  )

  /* ---------- 融合流程 ---------- */
  function handle(img, x, y) {
    const token = ++mergeToken
    if (pollTimer) clearInterval(pollTimer)
    let tries = 0
    pollTimer = setInterval(() => {
      tries++
      const menu = findVisiblePlatformMenu(x, y)
      if (menu) {
        clearInterval(pollTimer)
        pollTimer = null
        mergeItem(menu, img)
        return
      }
      if (tries >= 30) {
        // 1.5s 内平台菜单未出现 → 降级独立菜单
        clearInterval(pollTimer)
        pollTimer = null
        if (token !== mergeToken) return
        buildStandalone(x, y, img)
        log('平台菜单未出现，降级独立菜单')
      }
    }, 50)
  }

  function findVisiblePlatformMenu(x, y) {
    for (const el of document.querySelectorAll(PLATFORM_MENU_SEL)) {
      let st, r
      try { st = getComputedStyle(el); r = el.getBoundingClientRect() } catch (_) { continue }
      if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) continue
      if (r.width < 40 || r.height < 40) continue
      if (Math.abs(r.left - x) > 320 || Math.abs(r.top - y) > 320) continue
      return el
    }
    return null
  }

  function mergeItem(container, img) {
    try {
      // 防重复：同一菜单实例多次弹出
      if (container.querySelector('#' + ITEM_ID)) {
        log('融合项已存在')
        return
      }
      const item = document.createElement('div')
      const ref = container.firstElementChild
      if (ref) {
        const st = getComputedStyle(ref)
        for (const k of [
          'font', 'padding', 'margin', 'color', 'fontSize', 'lineHeight',
          'display', 'alignItems', 'height', 'cursor', 'gap', 'boxSizing',
        ]) {
          try { item.style[k] = st[k] } catch (_) {}
        }
      }
      item.id = ITEM_ID
      item.textContent = '🧾 进入排单'
      item.style.whiteSpace = 'nowrap'
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(0,0,0,0.07)' })
      item.addEventListener('mouseleave', () => { item.style.background = '' })

      // 平台菜单可能在 mousedown/容器捕获阶段就关闭吞事件：
      // mousedown 最早触发（菜单未隐藏），click 兜底；800ms 去重防双触发。
      // 菜单实例被平台复用，点击时必须取「当前右键的图」（ctxImg 每次右键刷新），
      // 不能用合并时闭包里的旧图。
      let lastFireAt = 0
      const fire = ev => {
        ev.stopPropagation()
        ev.preventDefault()
        const now = Date.now()
        if (now - lastFireAt < 800) return
        lastFireAt = now
        container.style.display = 'none' // 与平台隐藏路径一致，避免残留
        capture(ctxImg || img)
      }
      item.addEventListener('mousedown', fire, true)
      item.addEventListener('click', fire, true)
      container.appendChild(item)
      log('已融合进平台菜单 .copy-paste')
    } catch (err) {
      log('融合失败，降级独立菜单', err)
      buildStandalone(120, 120, img)
    }
  }

  /* ---------- 独立菜单（降级 / PoC） ---------- */
  function hideStandalone() {
    const m = document.getElementById(MENU_ID)
    if (m) m.remove()
  }
  function buildStandalone(x, y, img) {
    hideStandalone()
    const m = document.createElement('div')
    m.id = MENU_ID
    m.style.cssText =
      'position:fixed;z-index:2147483647;background:#1f2430;color:#e8eaf0;' +
      'font:12px/32px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'border-radius:8px;padding:4px 0;box-shadow:0 6px 20px rgba(0,0,0,.4);' +
      'min-width:150px;user-select:none;'
    const item = (label, fn) => {
      const d = document.createElement('div')
      if (label.indexOf('排单') > -1) d.id = ITEM_ID
      d.textContent = label
      d.style.cssText = 'padding:0 18px;cursor:pointer;'
      d.onmouseenter = () => (d.style.background = '#2f6fed')
      d.onmouseleave = () => (d.style.background = '')
      d.onclick = ev => { ev.stopPropagation(); hideStandalone(); fn() }
      m.appendChild(d)
    }
    item('🧾 进入排单', () => capture(img))
    item('📋 复制图片地址', () => {
      navigator.clipboard && navigator.clipboard.writeText(img ? img.src : '')
    })
    document.body.appendChild(m)
    const r = m.getBoundingClientRect()
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px'
    m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px'
  }
  document.addEventListener('click', hideStandalone, true)
  window.addEventListener('blur', hideStandalone)

  /* ---------- 抓图 + 上下文回传 ---------- */
  // 千帆 arkgoods 原图地址规则（与订单素材台桌面端 EvaOriginalImageLoader 一致）：
  // 校验域名与路径形态，去掉 imageView2/ 缩图参数，保留其余参数 → 得到未缩放原图
  function originalUrl(src) {
    try {
      const u = new URL(src, location.href)
      if (u.protocol !== 'https:' || u.hostname !== 'qimg.xiaohongshu.com')
        return null
      if (!/^\/arkgoods\/[a-zA-Z0-9]+$/.test(u.pathname)) return null
      const kept = (u.search ? u.search.slice(1).split('&') : []).filter(
        p => p && !decodeURIComponent(p).startsWith('imageView2/'),
      )
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

  async function capture(img) {
    try {
      const src = (img && img.src) || ''
      let b64 = null
      let bytes = 0
      let mime = ''
      let scaled = false
      if (src) {
        const original = originalUrl(src)
        if (original && original !== src) {
          try {
            ;({ bytes, mime, b64 } = await fetchAsB64(original))
          } catch (_) {
            scaled = true // 原图拉取失败，退回气泡缩图并明确标记
          }
        }
        if (!b64) {
          ;({ bytes, mime, b64 } = await fetchAsB64(src))
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
        ts: Date.now(),
        context: extractContext(),
      })
      log('captured', src.slice(0, 80), bytes + 'B', mime, scaled ? '(缩图)' : '(原图)')
      toast(
        scaled
          ? '⚠ 已提交排单（原图拉取失败，本次为缩图 ' + (bytes / 1024).toFixed(0) + 'KB）'
          : '✓ 已提交排单：原图 ' + (bytes / 1024).toFixed(0) + 'KB 已捕获',
      )
    } catch (err) {
      send({ type: 'paidan.error', error: String(err), ts: Date.now() })
      toast('✗ 提交失败：' + String(err).slice(0, 60))
      log('capture error', err)
    }
  }

  /* ---------- 可见反馈 toast ---------- */
  function toast(msg) {
    try {
      const t = document.createElement('div')
      t.textContent = msg
      t.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#10b981;color:#fff;' +
        'font:13px/20px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:10px 16px;' +
        'border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.3);transition:opacity .3s;'
      document.body.appendChild(t)
      setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 350) }, 2400)
    } catch (_) {}
  }

  // TODO(真实选择器)：订单号目前靠全文启发式（P+12~22位数字）；后续改为订单面板精确定位
  function extractContext() {
    let orderNo = null
    try {
      const text = (document.body && document.body.innerText) || ''
      const match = text.match(/\bP\d{12,22}\b/)
      if (match) orderNo = match[0]
    } catch (_) {}
    return { title: document.title, orderNo: orderNo }
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

  log('core v5 injected on', location.href)
})()
