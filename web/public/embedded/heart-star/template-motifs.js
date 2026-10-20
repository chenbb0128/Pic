(() => {
  'use strict';

  function create({ getName, getTemplate, getStates, getSelection, getSource, assets, slots, loadImage, redraw, report }) {
    const catalog = () => getTemplate().motifSlots || slots;
    const active = () => getName() === '模板爱心.png' || !!getTemplate().motifSlots;
    const selection = () => active() ? [...getSelection()].filter(id => catalog()[id] && getStates()[id]) : [];
    function allowed(asset, ids = selection()) {
      if (!active() || !asset || !ids.length) return false;
      return ids.every(id => {
        if (!catalog()[id] || !getStates()[id]) return false;
        const variant = catalog()[id].variant;
        return variant === '原款' ? ['I ♥ ME 组合', 'I ♥ VE 组合'].includes(asset.group) :
          ['heart', 'star'].includes(asset.type) && asset.variant === variant;
      });
    }
    let pending = null, request = 0, cached = null;
    const busy = () => !!pending && pending.states === getStates() && pending.source === getSource() && active();

    function placement(id, asset) {
      const [x, y, w, h] = catalog()[id].box, cfg = getTemplate(), width = cfg.widthMm || 144, height = cfg.heightMm || 210;
      // Keep the original slot and fit same-variant artwork without enlarging it.
      const factor = Math.min(1, w / cfg.w * width / asset.nativeW, h / cfg.h * height / asset.nativeH);
      const pw = asset.nativeW * factor / width * cfg.w, ph = asset.nativeH * factor / height * cfg.h;
      return { x: x + (w - pw) / 2, y: y + (h - ph) / 2, w: pw, h: ph };
    }

    async function replace(ids, assetId) {
      const asset = assets[assetId], unique = [...new Set(ids)];
      if (!allowed(asset, unique)) {
        report('请选择同规格的爱心、星星或字母组合后更换。', true); return;
      }
      const target = { states: getStates(), source: getSource(), request: ++request };
      pending = target; redraw();
      try {
        const image = await loadImage(assetId);
        if (pending !== target || request !== target.request || !busy()) return;
        if (!allowed(asset, unique)) { report('图案规格已变化，请重新选择素材。', true); return; }
        for (const id of unique) {
          const p = placement(id, asset), frame = asset.frame;
          const photoFrame = catalog()[id].variant === '原款' || asset.type === 'star' ? {
            x: p.x + p.w * frame.x, y: p.y + p.h * frame.y, w: p.w * frame.w, h: p.h * frame.h,
          } : { ...getTemplate().slots[id] };
          target.states[id].motif = { assetId, image, placement: p, frame: photoFrame, type: asset.type,
            backgroundPart: ['I ♥ ME 组合', 'I ♥ VE 组合'].includes(asset.group) ? 'heart' : 'whole' };
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

    return { active, selection, allowed, placement, replace, restore, source, rows, busy, catalog };
  }

  globalThis.HeartStarMotifs = { create };
})();
