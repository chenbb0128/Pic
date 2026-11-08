(() => {
  'use strict';
  const STORAGE_KEY = 'pic:heart-star:product-preview:v1';
  const BACKGROUNDS = { cream: '#fffaf2', pink: '#fff1f5', transparent: null };
  const BACKGROUND_NAMES = { cream: '奶油白', pink: '浅粉', transparent: '透明' };
  const DEFAULT_TEXT = '仅供确认 · 禁止盗用';
  const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;

  function normalize(value) {
    value = value && typeof value === 'object' ? value : {};
    return {
      background: Object.hasOwn(BACKGROUNDS, value.background) ? value.background : 'cream',
      padding: bounded(value.padding ?? 6, 6, 2, 12),
      watermark: value.watermark !== false,
      text: typeof value.text === 'string' && value.text.trim() ? value.text.trim().slice(0, 40) : DEFAULT_TEXT,
      opacity: bounded(value.opacity ?? 40, 40, 8, 50),
    };
  }

  function loadSettings(storage) {
    try { return normalize(JSON.parse((storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY) || 'null')); }
    catch { return normalize(); }
  }

  function saveSettings(storage, settings) {
    try { (storage ?? globalThis.localStorage)?.setItem(STORAGE_KEY, JSON.stringify(normalize(settings))); }
    catch { /* The export also works when browser storage is unavailable. */ }
  }

  function layout(width, height, padding) {
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw Error('当前排版没有可导出的图像');
    const edge = 1600, inset = edge * normalize({ padding }).padding / 100;
    const scale = (edge - inset * 2) / Math.max(width, height);
    const artWidth = width * scale, artHeight = height * scale;
    const outWidth = Math.round(artWidth + inset * 2), outHeight = Math.round(artHeight + inset * 2);
    return { width: outWidth, height: outHeight, artWidth, artHeight, x: (outWidth - artWidth) / 2, y: (outHeight - artHeight) / 2 };
  }

  function compose(source, options) {
    const settings = normalize(options), box = layout(source.width, source.height, settings.padding);
    const output = document.createElement('canvas'); output.width = box.width; output.height = box.height;
    const paint = output.getContext('2d');
    if (!paint) throw Error('无法生成商品展示图，请重试');
    paint.imageSmoothingEnabled = true; paint.imageSmoothingQuality = 'high';
    paint.drawImage(source, box.x, box.y, box.artWidth, box.artHeight);
    if (settings.watermark) {
      paint.save();
      // Reserve a separate footer for the watermark; never paint over the artwork.
      const top = Math.ceil(box.y + box.artHeight) + 2, height = output.height - top;
      paint.beginPath(); paint.rect(0, top, output.width, height); paint.clip();
      paint.globalCompositeOperation = 'source-over';
      paint.fillStyle = `rgba(102,112,133,${settings.opacity / 100})`;
      let size = Math.min(26, height * .45);
      paint.font = `600 ${size}px "Microsoft YaHei",sans-serif`;
      const measured = paint.measureText(settings.text).width, maxWidth = Math.max(1, output.width - 24);
      if (measured > maxWidth) size *= maxWidth / measured;
      paint.font = `600 ${size}px "Microsoft YaHei",sans-serif`; paint.textAlign = 'center'; paint.textBaseline = 'middle';
      paint.fillText(settings.text, output.width / 2, top + height / 2);
      paint.restore();
    }
    if (BACKGROUNDS[settings.background]) {
      paint.globalCompositeOperation = 'destination-over';
      paint.fillStyle = BACKGROUNDS[settings.background]; paint.fillRect(0, 0, output.width, output.height);
    }
    return output;
  }

  function mount({ button, capture, report, storage }) {
    let settings = loadSettings(storage), snapshot = null, output = null, pendingFrame = 0, downloading = false;
    const dialog = document.createElement('dialog'); dialog.className = 'product-dialog';
    dialog.setAttribute('aria-labelledby', 'productPreviewTitle');
    dialog.innerHTML = `<div class="product-dialog-head"><div><h2 id="productPreviewTitle">商品展示图</h2><p>保留当前排版 · 不含编号 · 图片长边 1600 px</p></div><button type="button" class="preview-tool" aria-label="关闭商品展示图">✕</button></div>
      <div class="product-layout"><section class="product-settings" aria-label="展示设置">
        <label for="productBackground">展示背景</label><select id="productBackground"><option value="cream">奶油白</option><option value="pink">浅粉色</option><option value="transparent">透明 PNG</option></select>
        <label for="productPadding">四周留白 <output id="productPaddingValue">6%</output></label><input id="productPadding" type="range" min="2" max="12" step="1" value="6">
        <label class="product-watermark-toggle"><input id="productWatermarkEnabled" type="checkbox" checked>展示水印（下方留白）</label>
        <label for="productWatermarkText">水印文字</label><input id="productWatermarkText" type="text" maxlength="40" autocomplete="off">
        <label for="productWatermarkOpacity">水印浓度 <output id="productWatermarkOpacityValue">40%</output></label><input id="productWatermarkOpacity" type="range" min="8" max="50" step="1" value="40">
        <p class="product-settings-note">所有模板通用，设置自动记住。透明背景在预览中显示为棋盘格，下载图片不含棋盘格。</p>
        <button type="button" class="btn primary" id="downloadProductPreview">下载商品展示图</button><p id="productPreviewStatus" role="status" aria-live="polite"></p>
      </section><div class="product-preview-content" id="productPreviewContent" aria-label="商品展示效果"></div></div>`;
    document.body.append(dialog);
    const find = id => dialog.querySelector('#' + id);
    const background = find('productBackground'), padding = find('productPadding'), enabled = find('productWatermarkEnabled');
    const text = find('productWatermarkText'), opacity = find('productWatermarkOpacity'), content = find('productPreviewContent');
    const download = find('downloadProductPreview'), status = find('productPreviewStatus'), close = dialog.querySelector('[aria-label="关闭商品展示图"]');
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');

    function updateControls() {
      find('productPaddingValue').textContent = `${settings.padding}%`;
      find('productWatermarkOpacityValue').textContent = `${settings.opacity}%`;
      text.disabled = opacity.disabled = !settings.watermark;
    }

    function render() {
      pendingFrame = 0;
      if (!snapshot) return;
      try {
        output = compose(snapshot.canvas, settings);
        output.setAttribute('role', 'img'); output.setAttribute('aria-label', `${snapshot.name}商品展示图`);
        content.replaceChildren(output); download.disabled = downloading;
        status.textContent = `${output.width} × ${output.height} px · PNG`;
      } catch (error) { output = null; download.disabled = true; status.textContent = error.message || '生成失败，请重试'; }
    }

    function change() {
      settings = normalize({ background: background.value, padding: padding.value, watermark: enabled.checked, text: text.value, opacity: opacity.value });
      updateControls(); saveSettings(storage, settings);
      if (!pendingFrame) pendingFrame = requestAnimationFrame(render);
    }

    function open() {
      if (dialog.open) return;
      try {
        snapshot = capture();
        background.value = settings.background; padding.value = String(settings.padding); enabled.checked = settings.watermark;
        text.value = settings.text; opacity.value = String(settings.opacity); updateControls(); render();
        dialog.showModal(); button.setAttribute('aria-expanded', 'true'); close.focus();
      } catch (error) { snapshot = null; output = null; content.replaceChildren(); report(error.message || '展示图暂时无法生成，请稍后重试', true); }
    }

    async function exportImage() {
      if (downloading) return;
      // Flush a pending slider update so the downloaded PNG matches its controls.
      if (pendingFrame) { cancelAnimationFrame(pendingFrame); render(); }
      if (!output || !snapshot) return;
      const image = output, chosen = { ...settings }, name = snapshot.name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').slice(0, 80) || '排版';
      downloading = true; download.disabled = true; status.textContent = '正在生成 PNG…';
      try {
        const blob = await new Promise((resolve, reject) => image.toBlob(value => value ? resolve(value) : reject(Error('PNG 生成失败，请重试')), 'image/png'));
        const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob);
        anchor.download = `${name}_商品展示_${BACKGROUND_NAMES[chosen.background]}${chosen.watermark ? '_带水印' : ''}.png`;
        try { anchor.click(); } finally { setTimeout(() => URL.revokeObjectURL(anchor.href), 1000); }
        status.textContent = `已下载 · ${image.width} × ${image.height} px`;
      } catch (error) { status.textContent = error.message || '下载失败，请重试'; }
      finally { downloading = false; download.disabled = !output; }
    }

    background.addEventListener('change', change); enabled.addEventListener('change', change);
    for (const input of [padding, text, opacity]) input.addEventListener('input', change);
    button.addEventListener('click', open); close.addEventListener('click', () => dialog.close());
    download.addEventListener('click', exportImage);
    dialog.addEventListener('close', () => {
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
      pendingFrame = 0; snapshot = null; output = null; content.replaceChildren();
      button.setAttribute('aria-expanded', 'false'); button.focus();
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
    return { open, close: () => dialog.close() };
  }

  globalThis.HeartStarProductPreview = { normalize, loadSettings, saveSettings, layout, compose, mount };
})();
