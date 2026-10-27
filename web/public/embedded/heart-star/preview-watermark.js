(function () {
  'use strict';
  const DEFAULT_TEXT = '仅供确认 · 禁止盗用';
  let settings = { text: DEFAULT_TEXT, opacity: 0.4 };

  function tile() {
    const width = Math.max(160, settings.text.length * 14 + 16);
    return { width, height: Math.max(72, Math.ceil(width * 0.42)) };
  }

  function create({ surface, enabled, text, opacity, value }) {
    const overlay = document.createElement('div');
    overlay.className = 'preview-watermark';
    overlay.setAttribute('aria-hidden', 'true');
    surface.append(overlay);
    function update() {
      const amount = Number(opacity.value);
      settings = {
        text: text.value.trim().slice(0, 40) || DEFAULT_TEXT,
        opacity: Math.max(8, Math.min(50, Number.isFinite(amount) ? amount : 40)) / 100,
      };
      const escaped = settings.text.replace(/[&<>"']/g, character => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]
      ));
      const { width, height } = tile();
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle" transform="rotate(-25 ${width / 2} ${height / 2})" font-family="sans-serif" font-size="14" font-weight="600" fill="#667085" fill-opacity="${settings.opacity}">${escaped}</text></svg>`;
      overlay.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
      overlay.hidden = !enabled.checked;
      text.disabled = opacity.disabled = !enabled.checked;
      value.textContent = `${Math.round(settings.opacity * 100)}%`;
    }
    enabled.addEventListener('change', update);
    text.addEventListener('input', update);
    opacity.addEventListener('input', update);
    update();
  }

  // Flatten proofs on white so the artwork cannot be separated from the
  // watermark by transparency. Never change the original print canvas.
  function preview(source, withWatermark = true) {
    const result = document.createElement('canvas');
    const ratio = Math.min(1, 1600 / Math.max(source.width, source.height));
    result.width = Math.max(1, Math.round(source.width * ratio));
    result.height = Math.max(1, Math.round(source.height * ratio));
    const ctx = result.getContext('2d');
    if (!ctx) throw new Error('无法生成水印预览图，请重试。');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, result.width, result.height);
    ctx.drawImage(source, 0, 0, result.width, result.height);
    if (!withWatermark) return result;
    const scale = Math.max(0.5, result.width / 600), size = tile();
    const stepX = size.width * scale, stepY = size.height * scale;
    ctx.fillStyle = `rgba(102,112,133,${settings.opacity})`;
    ctx.font = `600 ${14 * scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = -stepY / 2; y < result.height + stepY; y += stepY) {
      for (let x = -stepX / 2; x < result.width + stepX; x += stepX) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-25 * Math.PI / 180);
        ctx.fillText(settings.text, 0, 0);
        ctx.restore();
      }
    }
    return result;
  }

  function createDialog({ button, dialog, close, content, render, onError }) {
    button.addEventListener('click', () => {
      if (dialog.open) return;
      try {
        content.replaceChildren(render());
        dialog.showModal();
        button.setAttribute('aria-expanded', 'true');
        close.focus();
      } catch (error) {
        content.replaceChildren();
        onError(error.message || '预览图生成失败，请重试。');
      }
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      content.replaceChildren();
      button.setAttribute('aria-expanded', 'false');
      button.focus();
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
  }

  globalThis.HeartStarWatermark = { create, preview, createDialog };
})();
