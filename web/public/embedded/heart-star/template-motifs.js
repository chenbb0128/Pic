(() => {
  'use strict';

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
      if (cfg.motifSlots) return cfg.motifSlots;
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
      return ids.every(id => {
        if (!catalog()[id] || !getStates()[id]) return false;
        const meta = catalog()[id], variant = meta.variant, type = meta.type || getTemplate().slots[id].type || 'heart';
        return variant === '原款' ? ['I ♥ ME 组合', 'I ♥ VE 组合'].includes(asset.group) :
          asset.variant === variant && (['heart', 'star'].includes(asset.type) || asset.type === type);
      });
    }
    let pending = null, request = 0, cached = null;
    const busy = () => !!pending && pending.states === getStates() && pending.source === getSource() && active();

    function placement(id, asset) {
      const [x, y, w, h] = catalog()[id].box, cfg = getTemplate(), width = cfg.widthMm || (cfg.custom ? cfg.w / 10 : 144), height = cfg.heightMm || (cfg.custom ? cfg.h / 10 : 210);
      // Keep the original slot and fit same-variant artwork without enlarging it.
      const factor = Math.min(1, w / cfg.w * width / asset.nativeW, h / cfg.h * height / asset.nativeH);
      const pw = asset.nativeW * factor / width * cfg.w, ph = asset.nativeH * factor / height * cfg.h;
      return { x: x + (w - pw) / 2, y: y + (h - ph) / 2, w: pw, h: ph };
    }

    function replacement(id, assetId, image) {
      const asset = assets[assetId], p = placement(id, asset), frame = asset.frame, meta = catalog()[id];
      const photoFrame = getName() !== '模板爱心.png' || meta.variant === '原款' || asset.type === 'star' ? {
        x: p.x + p.w * frame.x, y: p.y + p.h * frame.y, w: p.w * frame.w, h: p.h * frame.h,
      } : { ...getTemplate().slots[id] };
      return { assetId, image, placement: p, frame: photoFrame, type: asset.type, originalAssetId: meta.assetId,
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
        report('请选择同规格图案；圆形、方块也可换成爱心或星星，字母组合仅整组替换。', true); return;
      }
      const target = { states: getStates(), source: getSource(), request: ++request };
      pending = target; redraw();
      try {
        const image = await loadImage(assetId);
        if (pending !== target || request !== target.request || !busy()) return;
        if (!allowed(asset, unique)) { report('图案规格已变化，请重新选择素材。', true); return; }
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

    function source(base) {
      if (!active()) return base;
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
  globalThis.HeartStarMotifs = { create, photoTypes };
})();
