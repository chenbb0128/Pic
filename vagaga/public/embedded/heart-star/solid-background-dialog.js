(() => {
  'use strict';
  function mount({ button, store, getBoard, report }) {
    const api = globalThis.HeartStarSolidBackground, dialog = document.createElement('dialog');
    dialog.className = 'solid-dialog'; dialog.setAttribute('aria-labelledby', 'solidBackgroundTitle');
    dialog.innerHTML = `<div class="solid-head"><h2 id="solidBackgroundTitle">手动去纯色背景</h2><button type="button" class="preview-tool" data-close aria-label="关闭去底弹窗">✕</button></div>
      <p class="small">只处理本次指定的照片，不修改模板底图和排版位置。先预览再应用；复杂背景、阴影或主体与底色接近时，请谨慎提高容差。</p>
      <label class="solid-choice">预览照片 <select class="select" data-photo aria-label="选择去底预览照片"></select></label>
      <div class="solid-previews"><section><h3>原图 · 点击背景取色</h3><div class="solid-checker"><canvas data-original aria-label="点击原图选取要去除的底色"></canvas></div></section>
      <section><h3>去底预览</h3><div class="solid-checker"><canvas data-result aria-label="透明背景处理预览"></canvas></div></section></div>
      <div class="solid-settings"><label>底色 <input type="color" data-color value="#ffffff" aria-label="要去除的底色"></label><button type="button" class="preview-tool" data-auto>自动识别底色</button>
      <label>容差 <input type="range" data-tolerance min="0" max="120" value="24"><output data-tolerance-value>24</output></label>
      <label>边缘柔化 <input type="range" data-feather min="0" max="60" value="12"><output data-feather-value>12</output></label></div>
      <p class="small">多张照片分别自动识别底色，可切换逐张调整。仅去除与图片边缘连通的同色区域，不会主动删除被主体包围的同色细节。原始尺寸不变。</p>
      <div class="solid-status small" data-status role="status" aria-live="polite"></div>
      <div class="solid-actions"><button type="button" class="btn" data-restore>恢复原图</button><button type="button" class="btn" data-download>下载当前透明 PNG</button><button type="button" class="btn primary" data-apply>应用处理结果</button></div>
      <p class="small">本次编辑期间可恢复原图；保存作品会保留去底结果，原始上传文件不会被覆盖。重新加载作品后如需重做，请重新上传原图。</p>`;
    document.body.append(dialog);
    const find = name => dialog.querySelector(`[data-${name}]`), picker = find('photo'), color = find('color'), tolerance = find('tolerance'),
      feather = find('feather'), original = find('original'), result = find('result'), status = find('status'), apply = find('apply'),
      restore = find('restore'), download = find('download'), auto = find('auto');
    let session = null, working = false, timer = null, previewRequest = 0, previewReady = false;
    const entry = () => session?.entries[Number(picker.value) || 0];
    function update() {
      const board = getBoard(); button.disabled = !board.ready || !board.ids.some(id => board.photoAt(id));
    }
    function controls() {
      for (const control of [picker, color, tolerance, feather, auto]) control.disabled = working;
      apply.disabled = working || !previewReady; download.disabled = working || !previewReady;
      restore.disabled = working || !session?.entries.some(item => item.image !== item.original);
      dialog.setAttribute('aria-busy', String(working));
    }
    const hex = rgb => '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('');
    function schedule() {
      clearTimeout(timer); previewRequest++; previewReady = false; controls();
      status.textContent = '正在生成预览…';
      timer = setTimeout(preview, 80);
    }
    async function preview() {
      const item = entry(), active = session, request = ++previewRequest;
      if (!item) return;
      try {
        const image = item.original, w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
        if (w * h > 16000000) throw Error('图片超过 1600 万像素，请先缩小原图后再去底。');
        // Preserve thin boundaries and corner colors. Only CSS scales the display, never the input pixels.
        original.width = w; original.height = h;
        const context = original.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, original.width, original.height);
        const pixels = context.getImageData(0, 0, original.width, original.height), detected = api.detect(pixels);
        color.value = hex(item.options.color || detected || [255, 255, 255]);
        const output = await api.remove(pixels, { ...item.options,
          shouldCancel: () => active !== session || request !== previewRequest || !store.valid(active) });
        if (active !== session || request !== previewRequest) return;
        result.width = output.width; result.height = output.height;
        result.getContext('2d').putImageData(new ImageData(output.data, output.width, output.height), 0, 0);
        previewReady = true;
        status.textContent = detected || item.options.color ? '预览已更新。确认主体边缘和细节后，再应用处理结果。' :
          '未识别到一致的四角底色（可能已透明），当前保留原图。可点击原图背景取色。';
        controls();
      } catch (error) {
        if (active === session && request === previewRequest) { status.textContent = error.message || '预览失败，原图已保留。'; controls(); }
      }
    }
    function showEntry() {
      const item = entry(); if (!item) return;
      // Do not let a click sample the previous photo during the preview debounce.
      original.width = original.height = result.width = result.height = 0;
      tolerance.value = String(item.options.tolerance); feather.value = String(item.options.feather);
      find('tolerance-value').textContent = tolerance.value; find('feather-value').textContent = feather.value;
      schedule();
    }
    function close() { dialog.close(); }
    function cleanup() {
      store.cancel(session); session = null; previewRequest++; clearTimeout(timer); working = false; previewReady = false;
      original.width = original.height = result.width = result.height = 0; update();
    }
    function open(ids) {
      try {
        if (dialog.open) return;
        session = store.begin(ids); picker.replaceChildren();
        session.entries.forEach((item, index) => {
          const option = document.createElement('option'); option.value = String(index);
          option.textContent = `照片 ${index + 1} · ${item.ids.length} 个对应位置`; picker.append(option);
        });
        picker.value = '0';
        apply.textContent = `应用到 ${session.entries.reduce((n, item) => n + item.ids.length, 0)} 个对应位置`;
        dialog.showModal(); showEntry();
      } catch (error) { report(error.message || '打开去底预览失败。', true); }
    }
    async function run(task) {
      if (working || !session) return;
      const active = session; working = true; clearTimeout(timer); previewRequest++; controls();
      try { await task(active); }
      catch (error) { if (active === session) { status.textContent = error.message || '处理失败，原图已保留。'; report(status.textContent, true); } }
      finally { if (active === session) { working = false; controls(); } }
    }
    button.addEventListener('click', () => open()); find('close').addEventListener('click', close);
    dialog.addEventListener('close', cleanup);
    picker.addEventListener('change', showEntry);
    for (const [control, key] of [[tolerance, 'tolerance'], [feather, 'feather']]) control.addEventListener('input', () => {
      if (!entry() || working) return;
      entry().options[key] = Number(control.value); find(key + '-value').textContent = control.value; schedule();
    });
    color.addEventListener('input', () => {
      if (!entry() || working) return;
      entry().options.color = color.value.slice(1).match(/../g).map(c => parseInt(c, 16)); schedule();
    });
    auto.addEventListener('click', () => { if (entry() && !working) { delete entry().options.color; schedule(); } });
    original.addEventListener('click', event => {
      if (!entry() || working || !original.width) return;
      const rect = original.getBoundingClientRect(), x = Math.max(0, Math.min(original.width - 1, Math.floor((event.clientX - rect.left) / rect.width * original.width))),
        y = Math.max(0, Math.min(original.height - 1, Math.floor((event.clientY - rect.top) / rect.height * original.height))),
        pixel = original.getContext('2d').getImageData(x, y, 1, 1).data;
      if (!pixel[3]) { status.textContent = '这里已经透明，请点击有颜色的背景。'; return; }
      entry().options.color = [...pixel.slice(0, 3)]; schedule();
    });
    apply.addEventListener('click', () => run(async active => {
      const count = await store.apply(active, undefined, (current, total) => { status.textContent = `正在处理 ${current} / ${total} 张照片… 可关闭弹窗取消。`; });
      close(); report(`已去除 ${count} 处照片的纯色背景，已标记为已处理，排版位置保持不变。`);
    }));
    restore.addEventListener('click', () => run(async active => {
      store.restore(active); close(); report('已恢复原图并取消已处理标记，排版位置保持不变。');
    }));
    download.addEventListener('click', () => run(async active => {
      const item = entry(), output = await api.processImage(item.original, item.options, () => !store.valid(active));
      const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
      if (!store.valid(active)) throw Error('处理已取消。');
      if (!blob) throw Error('PNG 生成失败，请重试。');
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `去底照片_${Number(picker.value) + 1}.png`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = '透明 PNG 已下载，排版尚未修改。';
    }));
    update(); return { update, open };
  }
  globalThis.HeartStarSolidBackgroundDialog = { mount };
})();
