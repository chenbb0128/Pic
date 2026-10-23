// Replace the background completely, reusing only the template's outer silhouette.
(() => {
  const regionCache = new WeakMap();
  const layerCache = new WeakMap();
  const photoLayerCache = new WeakMap();
  const outlineCache = new WeakMap();
  const photoAreaCache = new WeakMap();
  const visiblePhotoCache = new WeakMap();
  const photoOnly = state => ['transparent', 'outline'].includes(state?.background?.type);
  function has(state) {
    const bg = state?.background;
    return photoOnly(state) || !!bg && (bg.type === 'color' ? /^#[0-9a-f]{6}$/i.test(bg.color) :
      bg.type === 'image' && bg.image?.naturalWidth > 0 && bg.image?.naturalHeight > 0);
  }

  function apply(states, ids, patch) {
    for (const id of ids) {
      const state = states[id];
      if (!state) continue;
      const background = { ...state.background, ...patch };
      // Start at the original artwork's full size without changing the saved
      // crop size; subsequent size/Alt-wheel adjustments still work normally.
      if (photoOnly({ background }) && !photoOnly(state)) background.photoBaseSize = state.size || 1;
      state.background = background;
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

  const heartOnly = (slot, state) => state?.motif?.backgroundPart ? state.motif.backgroundPart === 'heart' : slot.bottom || slot.backgroundPart === 'heart';

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

  function artworkRegions(cfg, pixels) {
    return cfg.custom ? cfg.placements.map(p => ({ x: p.x + p.w / 2, y: p.y + p.h / 2, w: p.w, h: p.h })) : measureRegions(cfg, pixels);
  }

  function measureBackgroundRegions(cfg, pixels, states = [], bounds = artworkRegions(cfg, pixels)) {
    if (!cfg.slots.some((slot, i) => heartOnly(slot, states[i]))) return bounds;
    const mask = outerMask(pixels, cfg.w, cfg.h);
    return bounds.map((region, index) => heartOnly(cfg.slots[index], states[index]) ?
      componentBounds(mask, cfg.w, cfg.h, region, states[index]?.motif?.frame || cfg.slots[index]) : region);
  }

  function regions(cfg, source, states = [], whole = false) {
    if (cfg.custom && (whole || !cfg.slots.some((slot, i) => heartOnly(slot, states[i])))) return artworkRegions(cfg);
    const frames = states.map(state => state.motif?.frame);
    let cached = regionCache.get(source);
    if (!cached || cached.cfg !== cfg || cached.frames.length !== frames.length || frames.some((frame, i) => frame !== cached.frames[i])) {
      const canvas = document.createElement('canvas');
      canvas.width = cfg.w; canvas.height = cfg.h;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(source, 0, 0, cfg.w, cfg.h);
      const pixels = context.getImageData(0, 0, cfg.w, cfg.h).data;
      const wholeBounds = artworkRegions(cfg, pixels);
      cached = { cfg, frames, wholeBounds, bounds: measureBackgroundRegions(cfg, pixels, states, wholeBounds) };
      regionCache.set(source, cached);
    }
    return whole ? cached.wholeBounds : cached.bounds;
  }

  function frame(cfg, source, states, index) {
    const state = states[index];
    if (photoOnly(state)) {
      const region = regions(cfg, source, states, state.background.type === 'transparent')[index];
      const size = state.background.photoBaseSize || state.size || 1;
      return { ...region, w: region.w / size, h: region.h / size };
    }
    return states[index]?.motif?.frame || cfg.slots[index];
  }

  function safePhotoArea(mask, width, height, region, center, choices, locateStarCenter = false) {
    const left = Math.max(0, Math.floor(region.x - region.w / 2)), right = Math.min(width, Math.ceil(region.x + region.w / 2));
    const top = Math.max(0, Math.floor(region.y - region.h / 2)), bottom = Math.min(height, Math.ceil(region.y + region.h / 2));
    const columns = right - left, heights = new Uint32Array(columns), stack = [];
    let best = null, area = 0;
    const candidates = choices ? new Map() : null;
    // Star centers are located once from their central body. All later fits,
    // and every non-star fit, stay symmetric around the chosen visual center.
    for (let y = top; y < bottom; y++) {
      for (let x = 0; x < columns; x++) heights[x] = mask[(y * width + left + x) * 4 + 3] >= 128 ? heights[x] + 1 : 0;
      stack.length = 0;
      for (let x = 0; x <= columns; x++) {
        const h = x === columns ? 0 : heights[x];
        while (stack.length && heights[stack[stack.length - 1]] > h) {
          const rectH = heights[stack.pop()], start = stack.length ? stack[stack.length - 1] + 1 : 0;
          let rectW = 2 * Math.min(center.x - left - start, left + x - center.x);
          let centeredH = 2 * Math.min(center.y - (y + 1 - rectH), y + 1 - center.y), centerY = center.y;
          if (locateStarCenter) {
            // Keep horizontal alignment, but allow the square's center to move
            // vertically into the star body instead of being held by its tips.
            rectW = centeredH = Math.min(rectW, rectH);
            centerY = Math.max(y + 1 - rectH + centeredH / 2, Math.min(center.y, y + 1 - centeredH / 2));
          }
          if (rectW <= 0 || centeredH <= 0) continue;
          if (candidates && centeredH > (candidates.get(rectW) || 0)) candidates.set(rectW, centeredH);
          const value = rectW * centeredH;
          if (value > area || (locateStarCenter && value === area && best && Math.abs(centerY - center.y) < Math.abs(best.y - center.y))) {
            // Inset each edge by 6 template pixels; keep tiny motifs usable.
            best = { x: center.x, y: centerY, w: rectW - 2 * Math.min(6, rectW * .03),
              h: centeredH - 2 * Math.min(6, centeredH * .03) }; area = value;
          }
        }
        stack.push(x);
      }
    }
    if (candidates) {
      // Keep only non-dominated centered rectangles. Cache this small frontier
      // once per template, not another pixel scan for every photo or draw.
      let tallest = 0, squareSide = 0;
      for (const [w, h] of [...candidates].sort((a, b) => b[0] - a[0])) {
        if (h <= tallest) continue;
        choices.push({ x: center.x, y: center.y, w: w - 2 * Math.min(6, w * .03), h: h - 2 * Math.min(6, h * .03) });
        const candidate = choices[choices.length - 1];
        squareSide = Math.max(squareSide, Math.min(candidate.w, candidate.h));
        tallest = h;
      }
      // Before upload, show the largest centered safe square rather than the
      // widest area-maximizing rectangle. Uploaded stars still use all choices.
      best = { x: center.x, y: center.y, w: squareSide, h: squareSide };
    }
    return best || { x: center.x, y: center.y, w: 0, h: 0 };
  }

  function photoAreas(cfg, source, states) {
    const frames = states.map(state => state.motif?.frame);
    let cached = photoAreaCache.get(source);
    if (!cached || cached.cfg !== cfg || cached.slots !== cfg.slots || cached.placements !== cfg.placements || cached.photoTypes !== cfg.photoTypes ||
        cached.frames.length !== frames.length || frames.some((frame, i) => frame !== cached.frames[i])) {
      const surface = document.createElement('canvas'); surface.width = cfg.w; surface.height = cfg.h;
      const paint = surface.getContext('2d', { willReadFrequently: true }); paint.drawImage(source, 0, 0, cfg.w, cfg.h);
      const pixels = paint.getImageData(0, 0, cfg.w, cfg.h).data, mask = outerMask(pixels, cfg.w, cfg.h);
      const bounds = measureBackgroundRegions(cfg, pixels, states);
      const choices = [], fitted = bounds.map(() => new WeakMap());
      cached = { cfg, slots: cfg.slots, placements: cfg.placements, photoTypes: cfg.photoTypes, frames, choices, fitted,
        areas: bounds.map((region, index) => {
          const type = states[index]?.motif?.type || cfg.photoTypes?.[index] || cfg.slots[index].type;
          const heart = type === 'heart' || heartOnly(cfg.slots[index], states[index]);
          // Hearts are top-heavy: lift photos by 4% of the heart alone, never
          // the I / ME / VE group. Recalculate safety around this visual center.
          let center = { x: region.x, y: region.y - (heart ? region.h * .04 : 0) };
          if (type === 'star' && !heart) {
            const body = safePhotoArea(mask, cfg.w, cfg.h, region, center, null, true);
            center = { x: body.x, y: body.y };
            choices[index] = [];
          }
          return safePhotoArea(mask, cfg.w, cfg.h, region, center, choices[index]);
        }) };
      photoAreaCache.set(source, cached);
    }
    return cached.areas;
  }

  function photoFrame(cfg, source, states, index, image) {
    let area = photoAreas(cfg, source, states)[index];
    const cached = photoAreaCache.get(source), choices = cached.choices[index];
    if (image && choices?.length) {
      if (cached.fitted[index].has(image)) return cached.fitted[index].get(image);
      const bounds = visiblePhotoBounds(image);
      if (bounds) {
        let scale = Math.min(area.w / bounds.w, area.h / bounds.h);
        for (const candidate of choices) {
          const value = Math.min(candidate.w / bounds.w, candidate.h / bounds.h);
          if (value > scale) { area = candidate; scale = value; }
        }
        // Use the visible photo's actual fitted extent for selection/hit frames,
        // not unused space in the enclosing safe candidate rectangle.
        area = { x: area.x, y: area.y, w: bounds.w * scale, h: bounds.h * scale };
      }
    }
    // Keep the existing 62% default and manual size controls as the baseline.
    const result = { x: area.x, y: area.y, w: area.w / .62, h: area.h / .62 };
    if (image && choices?.length) cached.fitted[index].set(image, result);
    return result;
  }

  function visiblePhotoBounds(image) {
    if (visiblePhotoCache.has(image)) return visiblePhotoCache.get(image);
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    let bounds = { x: 0, y: 0, w: width, h: height };
    try {
      const surface = document.createElement('canvas'); surface.width = width; surface.height = height;
      const paint = surface.getContext('2d', { willReadFrequently: true }); paint.drawImage(image, 0, 0);
      const pixels = paint.getImageData(0, 0, width, height).data;
      let left = width, top = height, right = -1, bottom = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3]) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
      bounds = right < 0 ? null : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
    } catch { /* Cross-origin images still fit using their complete dimensions. */ }
    visiblePhotoCache.set(image, bounds);
    return bounds;
  }

  function drawFittedPhoto(ctx, cfg, source, states, index, image) {
    const bounds = visiblePhotoBounds(image);
    if (!bounds) return;
    const f = photoFrame(cfg, source, states, index, image), state = states[index], size = state.size ?? .62;
    if (!f.w || !f.h) return;
    const ratio = Math.min(f.w * size / bounds.w, f.h * size / bounds.h) * (state.imageScale ?? 1);
    const x = f.x + (state.dx || 0) + (state.imageDx || 0), y = f.y + (state.dy || 0) + (state.imageDy || 0);
    // Draw the FULL image with its original alpha, never a cropped source rect.
    ctx.drawImage(image, x - (bounds.x + bounds.w / 2) * ratio, y - (bounds.y + bounds.h / 2) * ratio,
      (image.naturalWidth || image.width) * ratio, (image.naturalHeight || image.height) * ratio);
  }

  function drawTemplate(ctx, cfg, source, states) {
    if (!states.some(has)) { ctx.drawImage(source, 0, 0, cfg.w, cfg.h); return; }
    const bounds = regions(cfg, source, states);
    const complete = states.some(photoOnly) ? regions(cfg, source, states, true) : bounds;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cfg.w, cfg.h);
    states.forEach((state, index) => {
      if (!has(state) || !bounds[index]) return;
      // Photo-only modes remove the whole group, not just its central heart.
      const p = photoOnly(state) ? complete[index] : bounds[index];
      ctx.rect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
    });
    ctx.clip('evenodd');
    ctx.drawImage(source, 0, 0, cfg.w, cfg.h);
    ctx.restore();
  }

  function draw(ctx, state, x, y, w, h, source) {
    if (!has(state) || photoOnly(state)) return;
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

  function drawPhoto(ctx, cfg, source, states, index, image) {
    const state = states[index];
    if (!photoOnly(state) || !image) return;
    const bg = state.background, mask = bg.type === 'outline';
    const region = regions(cfg, source, states, !mask)[index];
    const size = (state.size || 1) / (bg.photoBaseSize || state.size || 1);
    const w = region.w * size, h = region.h * size;
    const x = region.x + (state.dx || 0), y = region.y + (state.dy || 0);
    const ratio = (mask ? Math.max : Math.min)(w / image.width, h / image.height) * (state.imageScale ?? 1);
    const dw = image.width * ratio, dh = image.height * ratio;
    const dx = state.imageDx || 0, dy = state.imageDy || 0;
    if (!mask) {
      // Draw the original alpha directly: no silhouette, fill, or forced crop.
      ctx.drawImage(image, x + dx - dw / 2, y + dy - dh / 2, dw, dh);
      return;
    }
    const transform = ctx.getTransform(), density = Math.max(.1, Math.abs(transform.a), Math.abs(transform.d));
    const pixelW = Math.ceil(w * density), pixelH = Math.ceil(h * density);
    const key = [source, image, region.x, region.y, region.w, region.h, w, h, pixelW, pixelH, dw, dh, dx, dy];
    let cached = photoLayerCache.get(state);
    if (!cached || !key.every((value, i) => value === cached.key[i])) {
      const layer = cached?.layer || document.createElement('canvas');
      layer.width = pixelW; layer.height = pixelH;
      const paint = layer.getContext('2d');
      paint.scale(pixelW / w, pixelH / h);
      paint.drawImage(image, w / 2 + dx - dw / 2, h / 2 + dy - dh / 2, dw, dh);
      paint.globalCompositeOperation = 'destination-in';
      paint.drawImage(outline(source), region.x - region.w / 2, region.y - region.h / 2, region.w, region.h, 0, 0, w, h);
      cached = { layer, key };
      photoLayerCache.set(state, cached);
    }
    ctx.drawImage(cached.layer, x - w / 2, y - h / 2, w, h);
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
      const onlyPhotos = selected.length > 0 && selected.every(id => photoOnly(states[id]));
      el('slotSizeLabel').textContent = text ? '文案大小' : onlyPhotos ? '图片占位大小' : '裁剪形状大小';
      el('slotPositionLabel').textContent = text ? '文案位置' : onlyPhotos ? '图片占位位置' : '裁剪形状位置';
      el('clipShape').disabled = disabled || onlyPhotos;
      upload.hidden = ['transparent', 'outline'].includes(mode.value);
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
        mode.value === 'transparent' ? '已移除所选整组底图和字母，只保留原占位大小与位置。请从上方“上传照片”放入抠图，等比完整显示并保留透明边缘，不受“启用裁剪”影响；可缩放、移动。' :
        mode.value === 'outline' ? '已移除所选原花纹和字母，仅复用爱心、星星等外轮廓裁剪照片，不画边框。请从上方“上传照片”放入图片，可缩放、移动；不受其他裁剪形状影响。' :
        mode.value === 'image' ? (first.image?.naturalWidth ? '新背景默认等比例铺满整个外轮廓，不保留旧花纹或内部镂空。可调整花纹大小和 X / Y，超出轮廓自动裁掉，照片保持不变；I ♥ ME / I ♥ VE 仅替换爱心，字母保持原色。' : '上传图片作为全新背景，仅复用原来的爱心、星星等外轮廓；I ♥ ME / I ♥ VE 的字母保持原色。') :
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
    return { update, busy, hasAny: () => getStates().some(state => has(state) && !photoOnly(state)) };
  }

  function createDrag({ canvas, mode, photoMode, getBoard, redraw, onModeChange }) {
    let drag = null, ownsCursor = false;
    const imageIds = board => [...board.selected].filter(id => {
      const bg = board.states[id]?.background;
      return bg?.type === 'image' && bg.image?.naturalWidth;
    });
    function finish(event) {
      if (!drag || (event && event.pointerId !== drag.pointer)) return;
      const pointer = drag.pointer;
      drag = null;
      if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
      if (mode.checked) canvas.style.cursor = 'grab';
    }
    function valid(board) {
      return mode.checked && board.ready && board.token === drag.token &&
        drag.selection.length === board.selected.size && drag.selection.every(id => board.selected.has(id)) &&
        drag.items.every(item => board.states[item.id]?.background === item.background);
    }
    function update() {
      const board = getBoard();
      mode.disabled = !board.ready || !imageIds(board).length;
      if (mode.disabled) mode.checked = false;
      if (drag && !valid(board)) finish();
      if (mode.checked) {
        ownsCursor = true;
        canvas.style.cursor = drag ? 'grabbing' : 'grab';
        canvas.style.touchAction = 'none';
      } else if (ownsCursor) {
        ownsCursor = false;
        if (!photoMode.checked) { canvas.style.cursor = 'pointer'; canvas.style.touchAction = ''; }
      }
    }
    mode.addEventListener('change', () => {
      finish();
      if (mode.checked) photoMode.checked = false;
      onModeChange();
      update();
    });
    photoMode.addEventListener('change', () => {
      if (photoMode.checked) { mode.checked = false; finish(); }
      update();
    });
    canvas.addEventListener('pointerdown', event => {
      if (drag || !mode.checked || event.button !== 0 || event.isPrimary === false) return;
      const board = getBoard();
      if (!board.ready) return;
      const bounds = canvas.getBoundingClientRect(), height = bounds.height * board.contentRatio;
      const width = bounds.width * (board.contentWidthRatio ?? 1);
      if (!width || !height || event.clientX < bounds.left || event.clientX >= bounds.left + width ||
          event.clientY < bounds.top || event.clientY >= bounds.top + height) return;
      const x = (event.clientX - bounds.left) / width * board.width - (board.offsetX || 0);
      const y = (event.clientY - bounds.top) / height * board.height;
      const ids = imageIds(board);
      if (!ids.some(id => {
        const slot = board.slots[id];
        return slot && Math.abs(x - slot.x) <= slot.w / 2 && Math.abs(y - slot.y) <= slot.h / 2;
      })) return;
      drag = { pointer: event.pointerId, token: board.token, selection: [...board.selected],
        x: event.clientX, y: event.clientY, ratioX: board.width / width, ratioY: board.height / height,
        items: ids.map(id => ({ id, background: board.states[id].background,
          dx: board.states[id].background.dx || 0, dy: board.states[id].background.dy || 0 })) };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      update();
    });
    canvas.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointer) return;
      if (!valid(getBoard())) { finish(); return; }
      const dx = (event.clientX - drag.x) * drag.ratioX, dy = (event.clientY - drag.y) * drag.ratioY;
      for (const item of drag.items) {
        item.background.dx = Math.max(-10000, Math.min(10000, Math.round(item.dx + dx)));
        item.background.dy = Math.max(-10000, Math.min(10000, Math.round(item.dy + dy)));
      }
      event.preventDefault();
      redraw();
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, finish);
    // Drag-mode clicks must not toggle the selected pattern after releasing the pointer.
    canvas.addEventListener('click', event => { if (mode.checked) event.stopImmediatePropagation(); }, true);
    return { update, dragging: () => !!drag };
  }

  globalThis.HeartStarBackground = { has, photoOnly, apply, draw, drawPhoto, drawFittedPhoto, photoFrame, photoAreas, drawTemplate, measureRegions, measureBackgroundRegions, regions, frame, create, createDrag, outerMask };
})();
