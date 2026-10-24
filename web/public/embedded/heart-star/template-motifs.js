(() => {
  'use strict';

  const smallHeart = asset => asset?.type === 'heart' && asset.variant === '小款';
  const smallHeartWidth = 19.5;
  const iMe = asset => asset?.group === 'I ♥ ME 组合';
  const sizeLimit = asset => iMe(asset) ? 30 : Infinity;
  function limitSmallHearts(assets) {
    for (const [id, asset] of Object.entries(assets)) {
      if (!smallHeart(asset)) continue;
      const factor = smallHeartWidth / asset.nativeW;
      assets[id] = { ...asset, nativeW: smallHeartWidth, nativeH: asset.nativeH * factor };
    }
  }
  function limitIMe(assets) {
    for (const [id, asset] of Object.entries(assets)) {
      if (!iMe(asset)) continue;
      const factor = Math.min(1, 30 / asset.nativeW, 30 / asset.nativeH);
      if (factor < 1) assets[id] = { ...asset, nativeW: asset.nativeW * factor, nativeH: asset.nativeH * factor };
    }
  }

  const repeat = (id, count) => Array(count).fill(id);
  const pair = (a, b, count) => [...repeat(a, count), ...repeat(b, count)];
  function colorRows(square, star, heartA, heartB, comboA, comboB) {
    return [pair(`${square}-small`, `${star}-small`, 3), pair(`${heartA}-small`, `${heartB}-small`, 3),
      pair(square, star, 2), pair(heartA, heartB, 2), pair(comboA, comboB, 2), pair(comboA, comboB, 2)];
  }
  const originalRows = {
    '模板混合.png': [pair('mint-star-small', 'white-mint-star-small', 3), pair('mint-star-small', 'white-mint-star-small', 3),
      pair('mint-plaid-heart-small', 'purple-plaid-heart-small', 3), pair('mint-plaid-heart-small', 'purple-plaid-heart-small', 3),
      ['spiral-heart', 'pink-star-heart', 'mint-star', 'white-mint-star'], ['spiral-heart', 'pink-star-heart', 'mint-star', 'white-mint-star'],
      ['ime-purple', 'ime-spiral', 'ime-rainbow', 'ime-pink-star'], ['ime-purple', 'ime-spiral', 'ime-rainbow', 'ime-pink-star']],
    '模板粉色.png': colorRows('pink-plaid-square', 'pink-stripe-star', 'pink-glow-heart', 'pink-dot-heart', 'ime-pink-glow', 'ime-pink-dot'),
    '模板蓝色.png': colorRows('blue-square', 'blue-star', 'blue-grid-heart', 'blue-yellow-heart', 'ime-blue-grid', 'ime-blue-yellow'),
    '模板黄色.png': colorRows('yellow-square', 'yellow-star', 'yellow-glow-heart', 'yellow-grid-heart', 'ime-yellow-glow', 'ime-yellow-grid'),
    '豹纹星星.png': [...Array.from({ length: 5 }, () => repeat('leopard-star-small', 6)), ...Array.from({ length: 3 }, () => repeat('leopard-star', 4))],
    '波点爱心.png': [...Array.from({ length: 5 }, () => repeat('polka-heart-small', 6)), ...Array.from({ length: 3 }, () => repeat('polka-heart', 4))],
    '波点圆形.png': [...Array.from({ length: 5 }, () => repeat('polka-circle-small', 6)), ...Array.from({ length: 3 }, () => repeat('polka-circle', 4))],
  };

  function create({ getName, getTemplate, getStates, getSelection, getSource, measureRegions, assets, slots, loadImage, redraw, report }) {
    const catalogs = new WeakMap();
    function catalog() {
      const cfg = getTemplate();
      if (cfg.text) return [];
      // Custom layouts can change rows and paper size after a shared restore.
      // Their saved catalog is only a snapshot; current placements are authoritative.
      if (cfg.motifSlots && !cfg.custom) return cfg.motifSlots;
      if (getName() === '模板爱心.png') return slots;
      const base = getSource(), cached = catalogs.get(cfg);
      if (cached && cached.source === base && cached.slots === cfg.slots && cached.placements === cfg.placements) return cached.entries;
      let entries;
      if (cfg.placements?.length) {
        entries = cfg.placements.map((p, i) => ({ index: i, row: cfg.slots[i].row, column: cfg.slots[i].column,
          assetId: p.assetId, name: assets[p.assetId].baseName, variant: assets[p.assetId].variant,
          type: assets[p.assetId].type, box: [p.x, p.y, p.w, p.h] }));
      } else {
        const rows = originalRows[getName()];
        if (!rows || rows.flat().length !== cfg.slots.length || !measureRegions || !base?.complete || !base.naturalWidth) return [];
        // Measure complete artwork once, including lettering outside the photo openings.
        const surface = document.createElement('canvas'); surface.width = cfg.w; surface.height = cfg.h;
        const paint = surface.getContext('2d', { willReadFrequently: true }); paint.drawImage(base, 0, 0, cfg.w, cfg.h);
        const bounds = measureRegions(cfg, paint.getImageData(0, 0, cfg.w, cfg.h).data);
        let index = 0;
        entries = rows.flatMap((row, r) => row.map((assetId, column) => {
          const i = index++, b = bounds[i], asset = assets[assetId];
          return { index: i, row: r, column, assetId, name: asset.baseName, variant: asset.variant, type: asset.type,
            box: [b.x - b.w / 2, b.y - b.h / 2, b.w, b.h] };
        }));
      }
      catalogs.set(cfg, { source: base, slots: cfg.slots, placements: cfg.placements, entries });
      return entries;
    }
    const active = () => !getTemplate().text && catalog().length > 0;
    const selection = () => active() ? [...getSelection()].filter(id => catalog()[id] && getStates()[id]) : [];
    function allowed(asset, ids = selection()) {
      if (!active() || !asset || !ids.length) return false;
      return ids.every(id => catalog()[id] && getStates()[id]);
    }
    let pending = null, request = 0, cached = null;
    const busy = () => !!pending && pending.states === getStates() && pending.source === getSource() && active();

    function placement(id, asset) {
      const [x, y, w, h] = catalog()[id].box, cfg = getTemplate(), width = cfg.widthMm || (cfg.custom ? cfg.w / 10 : 144), height = cfg.heightMm || (cfg.custom ? cfg.h / 10 : 210);
      // Every replacement fits its original position, without enlarging smaller artwork.
      const factor = Math.min(1, w / cfg.w * width / asset.nativeW, h / cfg.h * height / asset.nativeH,
        smallHeart(asset) ? smallHeartWidth / asset.nativeW : 1,
        sizeLimit(asset) / asset.nativeW, sizeLimit(asset) / asset.nativeH);
      const pw = asset.nativeW * factor / width * cfg.w, ph = asset.nativeH * factor / height * cfg.h;
      return { x: x + (w - pw) / 2, y: y + (h - ph) / 2, w: pw, h: ph };
    }

    function replacement(id, assetId, image) {
      const asset = assets[assetId], p = placement(id, asset), frame = asset.frame, meta = catalog()[id];
      const [x, y, w, h] = meta.box, originalFrame = getTemplate().slots[id];
      const photoFrame = getName() === '模板爱心.png' && meta.variant !== '原款' &&
        (meta.type || 'heart') === 'heart' && smallHeart(asset) ? {
        x: p.x + (originalFrame.x - x) * p.w / w, y: p.y + (originalFrame.y - y) * p.h / h,
        w: originalFrame.w * p.w / w, h: originalFrame.h * p.h / h,
      } : { x: p.x + p.w * frame.x, y: p.y + p.h * frame.y, w: p.w * frame.w, h: p.h * frame.h };
      return { assetId, image, placement: p, frame: photoFrame, type: asset.type, originalAssetId: meta.assetId, fitToSlot: true,
        backgroundPart: ['I ♥ ME 组合', 'I ♥ VE 组合'].includes(asset.group) ? 'heart' : 'whole' };
    }

    function reflow() {
      if (!getTemplate().custom) return;
      const entries = catalog();
      getStates().forEach((state, id) => {
        const motif = state.motif;
        if (!motif) return;
        if (motif.originalAssetId !== entries[id]?.assetId || !allowed(assets[motif.assetId], [id])) delete state.motif;
        else state.motif = replacement(id, motif.assetId, motif.image);
      });
    }

    async function replace(ids, assetId) {
      const asset = assets[assetId], unique = [...new Set(ids)];
      if (!allowed(asset, unique)) {
        report('请先选中要更换的图案，再选择有效素材。', true); return;
      }
      const target = { states: getStates(), source: getSource(), request: ++request };
      pending = target; redraw();
      try {
        const image = await loadImage(assetId);
        if (pending !== target || request !== target.request || !busy()) return;
        if (!allowed(asset, unique)) { report('所选位置已变化，请重新选择素材。', true); return; }
        for (const id of unique) {
          target.states[id].motif = replacement(id, assetId, image);
          // A whole-motif replacement supersedes a previously uploaded texture.
          delete target.states[id].background;
        }
        report(`已更换 ${unique.length} 个完整图案，保留原位置和照片。`);
      } catch (error) {
        if (pending === target && busy()) report(error.message || '图案更换失败，请重试。', true);
      } finally {
        if (pending === target) { pending = null; redraw(); }
      }
    }

    function restore(ids) {
      if (!active()) return;
      request++; pending = null;
      for (const id of ids) {
        if (!catalog()[id] || !getStates()[id]) continue;
        delete getStates()[id].motif;
        delete getStates()[id].background;
      }
      redraw();
    }

    function fitLimitedMotifs(base) {
      if (!base || !(base.naturalWidth || base.width)) return;
      const cfg = getTemplate(), states = getStates(), width = cfg.widthMm || (cfg.custom ? cfg.w / 10 : 144), height = cfg.heightMm || (cfg.custom ? cfg.h / 10 : 210);
      // Custom layout placements and replacements are already fitted. Never regrow them on render.
      if (cfg.custom) return;
      catalog().forEach((meta, id) => {
        const state = states[id];if (!state) return;
        // New replacements retain their fitted size across preview, export and saved-work restore.
        if (state.motif?.fitToSlot) return;
        const current = state.motif, assetId = current?.assetId || meta.assetId ||
          Object.keys(assets).find(key => assets[key].baseName === meta.name && assets[key].variant === meta.variant);
        const asset = assets[assetId], limit = sizeLimit(asset);
        const fixedWidth = smallHeart(asset);
        if (!fixedWidth && !Number.isFinite(limit)) return;
        const [x, y, w, h] = meta.box, p = current?.placement || { x, y, w, h };
        if (fixedWidth ? Math.abs(p.w / cfg.w * width - smallHeartWidth) < 1e-10 :
            p.w / cfg.w * width < limit - 1e-10 && p.h / cfg.h * height < limit - 1e-10) return;
        // Fixed-width hearts keep their exact proportion; capped letter groups leave raster edge room.
        const factor = fixedWidth ? smallHeartWidth / width * cfg.w / p.w : Math.min(1, Math.max(1, Math.floor(limit / width * cfg.w) - 2) / p.w,
          Math.max(1, Math.floor(limit / height * cfg.h) - 2) / p.h);
        let image = current?.image;
        if (!image) {
          // Crop the actual template artwork so its original texture is preserved.
          image = document.createElement('canvas');image.width = Math.ceil(w);image.height = Math.ceil(h);
          const sx = (base.naturalWidth || base.width) / cfg.w, sy = (base.naturalHeight || base.height) / cfg.h;
          image.getContext('2d').drawImage(base, x * sx, y * sy, w * sx, h * sy, 0, 0, image.width, image.height);
        }
        const placement = { x: p.x + p.w * (1 - factor) / 2, y: p.y + p.h * (1 - factor) / 2, w: p.w * factor, h: p.h * factor };
        const frame = current?.frame || cfg.slots[id];
        state.motif = { ...current, assetId, image, placement, type: asset.type, originalAssetId: meta.assetId,
          backgroundPart: iMe(asset) ? 'heart' : 'whole',
          frame: { x: placement.x + (frame.x - p.x) * factor, y: placement.y + (frame.y - p.y) * factor, w: frame.w * factor, h: frame.h * factor } };
      });
    }

    function source(base) {
      if (!active()) return base;
      fitLimitedMotifs(base);
      const states = getStates(), values = states.map(state => state.motif);
      if (!values.some(Boolean)) { cached = null; return base; }
      if (cached?.base === base && cached.states === states &&
          cached.values.length === values.length && values.every((value, i) => value === cached.values[i])) return cached.canvas;
      const cfg = getTemplate(), canvas = document.createElement('canvas');
      canvas.width = cfg.w; canvas.height = cfg.h;
      const paint = canvas.getContext('2d');
      paint.drawImage(base, 0, 0, cfg.w, cfg.h);
      values.forEach((motif, id) => {
        if (!motif) return;
        const [x, y, w, h] = catalog()[id].box, p = motif.placement;
        paint.clearRect(x, y, w, h);
        paint.drawImage(motif.image, p.x, p.y, p.w, p.h);
      });
      cached = { base, states, values, canvas };
      return canvas;
    }

    function rows(widthMm, heightMm) {
      if (!active()) return [];
      fitLimitedMotifs(getSource());
      const cfg = getTemplate(), states = getStates();
      return catalog().map((meta, id) => {
        const motif = states[id]?.motif, [x, y, w, h] = meta.box;
        const p = motif?.placement || { x, y, w, h };
        return { index: id, row: meta.row, column: meta.column, variant: meta.variant,
          name: motif ? assets[motif.assetId].baseName : meta.name,
          width: p.w / cfg.w * widthMm, height: p.h / cfg.h * heightMm };
      });
    }

    return { active, selection, allowed, placement, replace, restore, source, rows, busy, catalog, reflow };
  }

  // Crop slots historically label some squares as hearts. Keep those legacy
  // slots intact and expose the real artwork types for uncropped photo fitting.
  const photoTypes = (name, assets) => originalRows[name]?.flat().map(id => assets[id].type);
  globalThis.HeartStarMotifs = { create, photoTypes, limitSmallHearts, limitIMe };
})();
