// Replace pattern colors while preserving the original template's alpha outline.
(() => {
  const regionCache = new WeakMap();
  const layerCache = new WeakMap();
  function has(state) {
    const bg = state?.background;
    return !!bg && (bg.type === 'color' ? /^#[0-9a-f]{6}$/i.test(bg.color) :
      bg.type === 'image' && bg.image?.naturalWidth > 0 && bg.image?.naturalHeight > 0);
  }

  function apply(states, ids, patch) {
    for (const id of ids) {
      if (states[id]) states[id].background = { ...states[id].background, ...patch };
    }
  }

  function measureRegions(cfg, pixels) {
    const rows = [];
    cfg.slots.map((slot, index) => ({ ...slot, index })).sort((a, b) => a.y - b.y).forEach(slot => {
      let row = rows[rows.length - 1];
      if (!row || Math.abs(slot.y - row[0].y) > Math.min(slot.h, row[0].h) * .2) rows.push(row = []);
      row.push(slot);
    });
    const centers = rows.map(row => row.reduce((sum, p) => sum + p.y + (p.bottom ? p.h / 2 : 0), 0) / row.length);
    const bounds = [];
    rows.forEach((row, r) => {
      row.sort((a, b) => a.x - b.x);
      const xs = row.map(p => p.x - (p.bottom ? p.w / 2 : 0));
      const top = r ? Math.round((centers[r - 1] + centers[r]) / 2) : 0;
      const bottom = r + 1 < rows.length ? Math.round((centers[r] + centers[r + 1]) / 2) : cfg.h;
      row.forEach((p, column) => {
        const left = column ? Math.round((xs[column - 1] + xs[column]) / 2) : 0;
        const right = column + 1 < row.length ? Math.round((xs[column] + xs[column + 1]) / 2) : cfg.w;
        let minX = right, minY = bottom, maxX = -1, maxY = -1;
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
          if (pixels[(y * cfg.w + x) * 4 + 3]) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
        bounds[p.index] = maxX < 0 ? { x: p.x, y: p.y, w: p.w, h: p.h } :
          { x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2, w: maxX - minX + 1, h: maxY - minY + 1 };
      });
    });
    return bounds;
  }

  function regions(cfg, source) {
    if (cfg.custom) return cfg.placements.map(p => ({ x: p.x + p.w / 2, y: p.y + p.h / 2, w: p.w, h: p.h }));
    let cached = regionCache.get(source);
    if (!cached || cached.cfg !== cfg) {
      const canvas = document.createElement('canvas');
      canvas.width = cfg.w; canvas.height = cfg.h;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(source, 0, 0, cfg.w, cfg.h);
      cached = { cfg, bounds: measureRegions(cfg, context.getImageData(0, 0, cfg.w, cfg.h).data) };
      regionCache.set(source, cached);
    }
    return cached.bounds;
  }

  function frame(cfg, source, states, index) {
    return cfg.slots[index];
  }

  function drawTemplate(ctx, cfg, source, states) {
    if (!states.some(has)) { ctx.drawImage(source, 0, 0, cfg.w, cfg.h); return; }
    const bounds = regions(cfg, source);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cfg.w, cfg.h);
    states.forEach((state, index) => {
      if (!has(state) || !bounds[index]) return;
      const p = bounds[index];
      ctx.rect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
    });
    ctx.clip('evenodd');
    ctx.drawImage(source, 0, 0, cfg.w, cfg.h);
    ctx.restore();
  }

  function draw(ctx, state, x, y, w, h, source) {
    if (!has(state)) return;
    const bg = state.background;
    let layer = layerCache.get(state);
    if (!layer) { layer = document.createElement('canvas'); layerCache.set(state, layer); }
    const transform = ctx.getTransform(), density = Math.max(1, Math.abs(transform.a), Math.abs(transform.d));
    // Reset the offscreen layer each time, including its previous composite mode.
    layer.width = Math.ceil(w * density);
    layer.height = Math.ceil(h * density);
    const paint = layer.getContext('2d');
    paint.scale(layer.width / w, layer.height / h);
    if (bg.type === 'color') {
      paint.fillStyle = bg.color;
      paint.fillRect(0, 0, w, h);
    } else {
      const ratio = Math.max(w / bg.image.naturalWidth, h / bg.image.naturalHeight) * (bg.scale ?? 1);
      const dw = bg.image.naturalWidth * ratio, dh = bg.image.naturalHeight * ratio;
      paint.drawImage(bg.image, w / 2 + (bg.dx || 0) - dw / 2, h / 2 + (bg.dy || 0) - dh / 2, dw, dh);
    }
    // Use only the template's alpha, never its old colors or a generic heart path.
    paint.globalCompositeOperation = 'destination-in';
    paint.drawImage(source, x - w / 2, y - h / 2, w, h, 0, 0, w, h);
    ctx.drawImage(layer, x - w / 2, y - h / 2, w, h);
  }

  function create({ getStates, getSelection, getTemplate, redraw, report }) {
    const el = id => document.getElementById(id);
    const field = el('slotBackgroundField'), mode = el('slotBackgroundMode'), color = el('slotBackgroundColor');
    const upload = el('slotBackgroundUpload'), file = el('slotBackgroundFile'), clear = el('slotBackgroundClear');
    const scale = el('slotBackgroundScale'), dx = el('slotBackgroundX'), dy = el('slotBackgroundY');
    const note = el('slotBackgroundNote'), reset = el('slotBackgroundReset');
    let request = 0, pending = null, uploadTarget = null;
    const ids = () => [...getSelection()].filter(id => getStates()[id]);
    const busy = () => pending?.states === getStates();

    function update() {
      const states = getStates(), selected = ids(), text = !!getTemplate().text;
      field.hidden = text;
      const disabled = text || !selected.length;
      [mode, color, clear].forEach(control => { control.disabled = disabled; });
      upload.disabled = disabled || busy();
      const values = selected.map(id => states[id].background || { type: 'none' });
      const first = values[0] || { type: 'none' };
      mode.value = values.every(bg => bg.type === first.type) ? first.type : 'mixed';
      el('slotBackgroundColorRow').hidden = mode.value !== 'color';
      el('slotBackgroundImageRow').hidden = mode.value !== 'image';
      color.value = first.color || '#fff0f5';
      const imageDisabled = disabled || mode.value !== 'image' || !values.some(bg => bg.image?.naturalWidth);
      [scale, dx, dy, reset].forEach(control => { control.disabled = imageDisabled; });
      for (const [control, key, fallback, factor] of [[scale, 'scale', 1, 100], [dx, 'dx', 0, 1], [dy, 'dy', 0, 1]]) {
        const value = (first[key] ?? fallback) * factor;
        const same = values.every(bg => (bg[key] ?? fallback) * factor === value);
        control.value = same ? String(value) : '';
        control.placeholder = same ? '' : '混合';
      }
      note.textContent = busy() ? '正在读取背景图片，完成后可导出…' :
        !selected.length ? '请先选择图案。' : mode.value === 'mixed' ? '所选图案背景不同，修改将批量应用。' :
        mode.value === 'image' ? (first.image?.naturalWidth ? '已替换内部花纹，保留原模板轮廓；背景等比例铺满，超出轮廓的部分裁掉。照片保持不变。' : '上传背景图片，只替换内部花纹，保留原来的爱心、星星等轮廓。') :
        mode.value === 'color' ? `所选 ${selected.length} 个图案已换为纯色，原轮廓不变。` : '未启用，保留原图案。可多选后批量替换。';
    }

    function change(patch) {
      if (getTemplate().text) return;
      request++;
      pending = null;
      apply(getStates(), ids(), patch);
      update();
      redraw();
    }

    mode.addEventListener('change', () => {
      if (mode.value !== 'mixed') change({ type: mode.value, color: color.value });
    });
    color.addEventListener('input', () => change({ type: 'color', color: color.value }));
    clear.addEventListener('click', () => {
      if (getTemplate().text) return;
      request++;
      pending = null;
      for (const id of ids()) delete getStates()[id].background;
      file.value = '';
      update();
      redraw();
    });
    upload.addEventListener('click', () => {
      const selected = ids();
      if (!selected.length) { report('请先选择要替换背景的图案。', true); return; }
      uploadTarget = { states: getStates(), selected };
      file.value = '';
      file.click();
    });
    file.addEventListener('cancel', () => { uploadTarget = null; file.value = ''; });
    file.addEventListener('change', () => {
      const picked = file.files?.[0], selection = uploadTarget;
      uploadTarget = null;
      if (!picked || !selection || selection.states !== getStates() || getTemplate().text) return;
      const selected = selection.selected;
      if (!picked.type.startsWith('image/')) { report('请选择有效的背景图片。', true); return; }
      const target = getStates(), token = ++request, image = new Image(), url = URL.createObjectURL(picked);
      pending = { states: target };
      update();
      redraw();
      const finish = success => {
        URL.revokeObjectURL(url);
        if (token !== request) return;
        pending = null;
        if (target !== getStates()) return;
        if (success) {
          apply(target, selected, { type: 'image', image, scale: 1, dx: 0, dy: 0 });
          report(`已替换 ${selected.length} 个图案的背景花纹，原轮廓和照片保持不变。`);
        } else report('背景图片读取失败，请重新选择。', true);
        update();
        redraw();
      };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
    });
    for (const [control, key, min, max, factor] of [[scale, 'scale', 25, 400, 100], [dx, 'dx', -10000, 10000, 1], [dy, 'dy', -10000, 10000, 1]]) {
      control.addEventListener('change', () => {
        const value = Number(control.value);
        if (!control.value.trim() || !Number.isFinite(value)) { update(); return; }
        change({ [key]: Math.max(min, Math.min(max, value)) / factor });
      });
    }
    reset.addEventListener('click', () => change({ scale: 1, dx: 0, dy: 0 }));
    return { update, busy, hasAny: () => getStates().some(has) };
  }

  globalThis.HeartStarBackground = { has, apply, draw, drawTemplate, measureRegions, regions, frame, create };
})();
