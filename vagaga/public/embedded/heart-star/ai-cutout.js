(() => {
  'use strict';
  // Client of /api/v1/photos/cutout (same-origin, tool-session cookie).
  // 订单制作中心（Tauri）模式：经父窗口 postMessage 桥调 Rust 直连 PicWish（本地 sha256 缓存）。
  // Reuses the solid-background store so originals, restore and processed marks behave identically.
  const maxSide = 4096;
  // 嵌在订单制作中心主窗口里时，父帧必然带 __TAURI_INTERNALS__。
  const isTauri = !!(window.parent && window.parent !== window && window.parent.__TAURI_INTERNALS__);
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const s = String(reader.result); resolve(s.slice(s.indexOf(',') + 1)); };
      reader.onerror = () => reject(Error('图片编码失败，请重试。'));
      reader.readAsDataURL(blob);
    });
  }
  function base64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'image/png' });
  }
  // Rust 分别限制处理请求和结果下载；父窗口按实际配置设置总等待上限。
  function tauriCutout(dataB64) {
    return new Promise((resolve, reject) => {
      const id = 'cut' + Math.random().toString(36).slice(2);
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      };
      const armTimeout = timeoutMs => {
        clearTimeout(timer);
        const delay = Math.min(2147483647, timeoutMs);
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`AI 抠图等待超时（${Math.ceil(delay / 1000)}s），请查看设置中的抠图日志。`));
        }, delay);
      };
      const onMessage = event => {
        const data = event.data || {};
        if (data.id !== id) return;
        if (data.type === 'pic-cutout-started') {
          if (Number.isFinite(data.timeoutMs) && data.timeoutMs > 0) armTimeout(data.timeoutMs);
          return;
        }
        if (data.type !== 'pic-cutout-response') return;
        cleanup();
        if (data.error) reject(new Error(data.error)); else resolve(data.pngB64);
      };
      window.addEventListener('message', onMessage);
      armTimeout(210000); // 缺省覆盖两段各 90 秒的请求及桥接余量。
      window.parent.postMessage({ type: 'pic-cutout-request', id, dataB64 }, '*');
    });
  }
  async function failureMessage(response) {
    const payload = await response.json().catch(() => null);
    if (payload?.message) return payload.message;
    if (response.status === 401) return 'AI 抠图需要先解锁工具，请刷新页面重新输入访问密码。';
    if (response.status === 429) return 'AI 抠图请求过于频繁或今日次数已用完，请稍后再试。';
    return 'AI 抠图服务暂时不可用，请稍后重试。';
  }
  function shrink(image, ratio) {
    const surface = document.createElement('canvas');
    surface.width = Math.max(1, Math.round((image.naturalWidth || image.width) * ratio));
    surface.height = Math.max(1, Math.round((image.naturalHeight || image.height) * ratio));
    surface.getContext('2d').drawImage(image, 0, 0, surface.width, surface.height);
    return new Promise((resolve, reject) => surface.toBlob(
      blob => blob ? resolve(blob) : reject(Error('图片压缩失败，请先手动缩小后再试。')), 'image/png'));
  }
  async function sourceBlob(image) {
    let response;
    try { response = await fetch(image.src); }
    catch { throw Error('原图读取失败，请重新上传后再试。'); }
    if (!response.ok) throw Error('原图读取失败，请重新上传后再试。');
    let blob = await response.blob();
    const width = image.naturalWidth || image.width || 0, height = image.naturalHeight || image.height || 0;
    // The upstream rejects sides above 4096 px; shrink before uploading.
    if (width > maxSide || height > maxSide) blob = await shrink(image, Math.min(maxSide / width, maxSide / height));
    return blob;
  }
  function loadIntoCanvas(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob), image = new Image();
      image.onload = () => {
        try {
          const surface = document.createElement('canvas');
          surface.width = image.naturalWidth; surface.height = image.naturalHeight;
          const paint = surface.getContext('2d');
          paint.drawImage(image, 0, 0);
          URL.revokeObjectURL(url); resolve(surface);
        } catch (error) { URL.revokeObjectURL(url); reject(error); }
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(Error('AI 抠图结果读取失败，请重试。')); };
      image.src = url;
    });
  }
  async function processOne(image) {
    if (isTauri) {
      const blob = await sourceBlob(image);
      const dataB64 = await blobToBase64(blob);
      const pngB64 = await tauriCutout(dataB64);
      return await loadIntoCanvas(base64ToBlob(pngB64, 'image/png'));
    }
    const blob = await sourceBlob(image);
    const form = new FormData();
    form.append('file', blob, 'photo.png');
    let response;
    try { response = await fetch('/api/v1/photos/cutout', { method: 'POST', credentials: 'same-origin', body: form }); }
    catch { throw Error('网络连接失败，请检查网络后重试。'); }
    if (!response.ok) throw Error(await failureMessage(response));
    const payload = await response.json().catch(() => null);
    const id = payload?.data?.id;
    if (payload?.code !== 0 || !id) throw Error(payload?.message || 'AI 抠图返回异常，请稍后重试。');
    let asset;
    try { asset = await fetch(`/api/v1/assets/${id}`, { credentials: 'same-origin' }); }
    catch { throw Error('AI 抠图结果下载失败，请稍后重试。'); }
    if (!asset.ok) throw Error('AI 抠图结果下载失败，请稍后重试。');
    return await loadIntoCanvas(await asset.blob());
  }
  function mount({ button, store, getBoard, report, changed }) {
    let working = false;
    function update() {
      const board = getBoard();
      // 只在处理中禁用；无照片时保持可点，点击给出明确提示（原实现 disabled 导致"点了没反应"）
      button.disabled = working;
      button.textContent = working ? 'AI 抠图中…' : 'AI 抠图（所选照片）';
    }
    async function run(ids) {
      if (working) return;
      const board0 = getBoard();
      if (!board0.ready || !board0.ids.some(id => board0.photoAt(id))) {
        report('请先注入或上传照片到槽位（并选中槽位），再使用 AI 抠图。', true);
        return;
      }
      let session;
      try { session = store.begin(ids); }
      catch (error) { report(error.message || '照片尚未准备好。', true); return; }
      working = true; update(); changed();
      const started = Date.now();
      let current = 0, total = session.entries.length, imageStarted = started;
      const progress = () => {
        if (current > 0) report(`AI 抠图：第 ${current} / ${total} 张，本张等待 ${Math.floor((Date.now() - imageStarted) / 1000)} 秒，累计 ${Math.floor((Date.now() - started) / 1000)} 秒…`);
      };
      const progressTimer = setInterval(progress, 1000);
      try {
        report('正在处理所选照片，批量完成后统一更新画板…');
        await new Promise(resolve => setTimeout(resolve, 0));
        const count = await store.apply(session, processOne,
          (index, length) => { current = index; total = length; imageStarted = Date.now(); progress(); });
        report(`已完成 ${count} 个照片槽位的 AI 抠图，耗时 ${Math.floor((Date.now() - started) / 1000)} 秒，可恢复原图。`);
      } catch (error) { report(error.message || 'AI 抠图失败，原图已保留。', true); }
      finally { clearInterval(progressTimer); store.cancel(session); working = false; update(); changed(); }
    }
    button.addEventListener('click', () => run());
    update();
    return { update, busy: () => working };
  }
  globalThis.HeartStarAICutout = { mount };
})();
