(() => {
  'use strict';
  // Client of /api/v1/photos/cutout (same-origin, tool-session cookie).
  // Reuses the solid-background store so originals, restore and processed marks behave identically.
  const maxSide = 4096;
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
      button.disabled = working || !board.ready || !board.ids.some(id => board.photoAt(id));
      button.textContent = working ? 'AI 抠图中…' : 'AI 抠图（所选照片）';
    }
    async function run(ids) {
      if (working) return;
      let session;
      try { session = store.begin(ids); }
      catch (error) { report(error.message || '照片尚未准备好。', true); return; }
      working = true; update(); changed();
      try {
        report('正在调用 AI 抠图，请稍候…');
        await new Promise(resolve => setTimeout(resolve, 0));
        const count = await store.apply(session, processOne,
          (current, total) => report(`AI 抠图 ${current} / ${total} 张照片…`));
        report(`已完成 ${count} 张照片的 AI 抠图，已标记为已处理，可恢复原图。`);
      } catch (error) { report(error.message || 'AI 抠图失败，原图已保留。', true); }
      finally { store.cancel(session); working = false; update(); changed(); }
    }
    button.addEventListener('click', () => run());
    update();
    return { update, busy: () => working };
  }
  globalThis.HeartStarAICutout = { mount };
})();
