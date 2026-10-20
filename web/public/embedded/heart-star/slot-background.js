// Replace the background completely, reusing only the template's outer silhouette.
(() => {
  const regionCache = new WeakMap();
  const layerCache = new WeakMap();
  const outlineCache = new WeakMap();
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

  function outerMask(pixels, w, h) {
    const count = w * h, outside = new Uint8Array(count), queue = new Uint32Array(count);
    let head = 0, tail = 0;
    const visit = i => {
      if (!outside[i] && !pixels[i * 4 + 3]) { outside[i] = 1; queue[tail++] = i; }
    };
    // Only transparency connected to the image border is outside the silhouette.
    // Enclosed holes and translucent texture belong to the new, solid background.
    for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
    while (head < tail) {
      const i = queue[head++], x = i % w;
      if (x) visit(i - 1);
      if (x + 1 < w) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i + w < count) visit(i + w);
    }
    const mask = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
      if (outside[i]) continue;
      const x = i % w, alpha = pixels[i * 4 + 3];
      const edge = !x || x === w - 1 || i < w || i >= count - w ||
        outside[i - 1] || outside[i + 1] || outside[i - w] || outside[i + w];
      // Preserve antialiasing at the original exterior, not the old interior texture.
      mask[i * 4 + 3] = edge && alpha ? alpha : 255;
    }
    return mask;
  }

  function outline(source) {
    let mask = outlineCache.get(source);
    if (!mask) {
      mask = document.createElement('canvas');
      mask.width = source.naturalWidth || source.width;
      mask.height = source.naturalHeight || source.height;
      const paint = mask.getContext('2d', { willReadFrequently: true });
      paint.drawImage(source, 0, 0, mask.width, mask.height);
      const image = paint.getImageData(0, 0, mask.width, mask.height);
      image.data.set(outerMask(image.data, mask.width, mask.height));
      paint.putImageData(image, 0, 0);
      outlineCache.set(source, mask);
    }
    return mask;
  }

  function measureRegions(cfg, pixels) {
    // Photo openings are not the centers of the complete artwork. Prefer real
    // transparent gutters so a larger neighbor cannot spill into another cell.
    function gap(occupied, a, b) {
      const middle = Math.round((a + b) / 2);
      const min = Math.max(0, Math.ceil(a)), max = Math.min(occupied.length - 1, Math.floor(b));
      for (let distance = 0; distance <= Math.max(middle - min, max - middle); distance++) {
        const before = middle - distance, after = middle + distance;
        if (before >= min && before <= max && !occupied[before]) return before;
        if (after >= min && after <= max && !occupied[after]) return after;
      }
      return middle;
    }
    const rows = [];
    cfg.slots.map((slot, index) => ({ ...slot, index })).sort((a, b) => a.y - b.y).forEach(slot => {
      let row = rows[rows.length - 1];
      if (!row || Math.abs(slot.y - row[0].y) > Math.min(slot.h, row[0].h) * .2) rows.push(row = []);
      row.push(slot);
    });
    const centers = rows.map(row => row.reduce((sum, p) => sum + p.y + (p.bottom ? p.h / 2 : 0), 0) / row.length);
    const occupiedRows = new Uint8Array(cfg.h);
    for (let y = 0; y < cfg.h; y++) for (let x = 0; x < cfg.w; x++) {
      if (pixels[(y * cfg.w + x) * 4 + 3]) { occupiedRows[y] = 1; break; }
    }
    const rowCuts = [0, ...centers.slice(1).map((center, i) => gap(occupiedRows, centers[i], center)), cfg.h];
    const bounds = [];
    rows.forEach((row, r) => {
      row.sort((a, b) => a.x - b.x);
      const xs = row.map(p => p.x - (p.bottom ? p.w / 2 : 0));
      const top = rowCuts[r], bottom = rowCuts[r + 1];
      const occupiedColumns = new Uint8Array(cfg.w);
      for (let y = top; y < bottom; y++) for (let x = 0; x < cfg.w; x++) {
        if (pixels[(y * cfg.w + x) * 4 + 3]) occupiedColumns[x] = 1;
      }
      const columnCuts = [0, ...xs.slice(1).map((x, i) => gap(occupiedColumns, xs[i], x)), cfg.w];
      row.forEach((p, column) => {
        const left = columnCuts[column], right = columnCuts[column + 1];
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

  const heartOnly = slot => slot.bottom || slot.backgroundPart === 'heart';

  function componentBounds(mask, w, h, region, center) {
    const left = Math.max(0, Math.floor(region.x - region.w / 2));
    const top = Math.max(0, Math.floor(region.y - region.h / 2));
    const right = Math.min(w, Math.ceil(region.x + region.w / 2));
    const bottom = Math.min(h, Math.ceil(region.y + region.h / 2));
    let seed = -1, distance = Infinity;
    // The filled silhouette includes the photo opening. Select its component,
    // not the disconnected I / ME lettering in the same artwork cell.
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      if (!mask[(y * w + x) * 4 + 3]) continue;
      const d = (x + .5 - center.x) ** 2 + (y + .5 - center.y) ** 2;
      if (d < distance) { distance = d; seed = y * w + x; }
    }
    if (seed < 0) return region;
    const width = right - left, count = width * (bottom - top);
    const visited = new Uint8Array(count), queue = new Uint32Array(count);
    let head = 0, tail = 0, minX = right, minY = bottom, maxX = left, maxY = top;
    function visit(x, y) {
      if (x < left || x >= right || y < top || y >= bottom) return;
      const local = (y - top) * width + x - left;
      if (visited[local] || !mask[(y * w + x) * 4 + 3]) return;
      visited[local] = 1; queue[tail++] = y * w + x;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    visit(seed % w, Math.floor(seed / w));
    while (head < tail) {
      const i = queue[head++], x = i % w, y = Math.floor(i / w);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx || dy) visit(x + dx, y + dy);
      }
    }
    return { x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function measureBackgroundRegions(cfg, pixels, states = []) {
    const bounds = cfg.custom ? cfg.placements.map(p => ({ x: p.x + p.w / 2, y: p.y + p.h / 2, w: p.w, h: p.h })) :
      measureRegions(cfg, pixels);
    if (!cfg.slots.some(heartOnly)) return bounds;
    const mask = outerMask(pixels, cfg.w, cfg.h);
    return bounds.map((region, index) => heartOnly(cfg.slots[index]) ?
      componentBounds(mask, cfg.w, cfg.h, region, states[index]?.motif?.frame || cfg.slots[index]) : region);
  }

  function regions(cfg, source, states = []) {
    if (cfg.custom && !cfg.slots.some(heartOnly)) return cfg.placements.map(p => ({ x: p.x + p.w / 2, y: p.y + p.h / 2, w: p.w, h: p.h }));
    const frames = states.map(state => state.motif?.frame);
    let cached = regionCache.get(source);
    if (!cached || cached.cfg !== cfg || cached.frames.length !== frames.length || frames.some((frame, i) => frame !== cached.frames[i])) {
      const canvas = document.createElement('canvas');
      canvas.width = cfg.w; canvas.height = cfg.h;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(source, 0, 0, cfg.w, cfg.h);
      cached = { cfg, frames, bounds: measureBackgroundRegions(cfg, context.getImageData(0, 0, cfg.w, cfg.h).data, states) };
      regionCache.set(source, cached);
    }
    return cached.bounds;
  }

  function frame(cfg, source, states, index) {
    return states[index]?.motif?.frame || cfg.slots[index];
  }

  function drawTemplate(ctx, cfg, source, states) {
    if (!states.some(has)) { ctx.drawImage(source, 0, 0, cfg.w, cfg.h); return; }
    const bounds = regions(cfg, source, states);
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
    const transform = ctx.getTransform(), density = Math.max(.1, Math.abs(transform.a), Math.abs(transform.d));
    const pixelW = Math.ceil(w * density), pixelH = Math.ceil(h * density);
    const key = [source, x, y, w, h, pixelW, pixelH, bg.type, bg.color, bg.image, bg.scale ?? 1, bg.dx || 0, bg.dy || 0];
    const cached = layerCache.get(state);
    if (cached && key.every((value, i) => value === cached.key[i])) {
      ctx.drawImage(cached.layer, x - w / 2, y - h / 2, w, h);
      return;
    }
    const layer = cached?.layer || document.createElement('canvas');
    // Resize/reset only when the background or target resolution has changed.
    layer.width = pixelW;
    layer.height = pixelH;
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
    // Reuse the exterior only; the old pattern's holes/opacity must not cut the new background.
    paint.globalCompositeOperation = 'destination-in';
    paint.drawImage(outline(source), x - w / 2, y - h / 2, w, h, 0, 0, w, h);
    layerCache.set(state, { layer, key });
    ctx.drawImage(layer, x - w / 2, y - h / 2, w, h);
  }

  function create({ getStates, getSelection, getTemplate, redraw, report }) {
    const el = id => document.getElementById(id);
    const field = el('slotBackgroundField'), mode = el('slotBackgroundMode'), color = el('slotBackgroundColor');
    const upload = el('slotBackgroundUpload'), file = el('slotBackgroundFile'), clear = el('slotBackgroundClear');
    const scale = el('slotBackgroundScale'), dx = el('slotBackgroundX'), dy = el('slotBackgroundY');
    const scaleRange = el('slotBackgroundScaleRange');
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
      [scale, scaleRange, dx, dy, reset].forEach(control => { control.disabled = imageDisabled; });
      for (const [control, key, fallback, factor] of [[scale, 'scale', 1, 100], [dx, 'dx', 0, 1], [dy, 'dy', 0, 1]]) {
        const value = (first[key] ?? fallback) * factor;
        const same = values.every(bg => (bg[key] ?? fallback) * factor === value);
        control.value = same ? String(value) : '';
        control.placeholder = same ? '' : '混合';
      }
      scaleRange.value = String((first.scale ?? 1) * 100);
      note.textContent = busy() ? '正在读取背景图片，完成后可导出…' :
        !selected.length ? '请先选择图案。' : mode.value === 'mixed' ? '所选图案背景不同，修改将批量应用。' :
        mode.value === 'image' ? (first.image?.naturalWidth ? '新背景默认等比例铺满整个外轮廓，不保留旧花纹或内部镂空。可调整花纹大小和 X / Y，超出轮廓自动裁掉，照片保持不变；I ♥ ME 仅替换爱心，字母保持原色。' : '上传图片作为全新背景，仅复用原来的爱心、星星等外轮廓；I ♥ ME 的字母保持原色。') :
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
          report(`已为 ${selected.length} 个图案设置全新背景，仅复用外轮廓，照片保持不变。`);
        } else report('背景图片读取失败，请重新选择。', true);
        update();
        redraw();
      };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
    });
    scaleRange.addEventListener('input', () => change({ scale: Math.max(25, Math.min(1000, Number(scaleRange.value))) / 100 }));
    scale.addEventListener('input', () => {
      const value = Number(scale.value);
      // Allow an incomplete number while typing; normalize it only on commit.
      if (scale.value.trim() && Number.isFinite(value) && value >= 25 && value <= 1000) change({ scale: value / 100 });
    });
    for (const [control, key, min, max, factor] of [[scale, 'scale', 25, 1000, 100], [dx, 'dx', -10000, 10000, 1], [dy, 'dy', -10000, 10000, 1]]) {
      control.addEventListener('change', () => {
        const value = Number(control.value);
        if (!control.value.trim() || !Number.isFinite(value)) { update(); return; }
        change({ [key]: Math.max(min, Math.min(max, value)) / factor });
      });
    }
    reset.addEventListener('click', () => change({ scale: 1, dx: 0, dy: 0 }));
    return { update, busy, hasAny: () => getStates().some(has) };
  }

  globalThis.HeartStarBackground = { has, apply, draw, drawTemplate, measureRegions, measureBackgroundRegions, regions, frame, create, outerMask };
})();
