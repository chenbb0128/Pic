(() => {
  'use strict';

  function create({ getName, getTemplate, getStates, getSelection, getSource, assets, slots, loadImage, redraw, report }) {
    const active = () => getName() === '模板爱心.png';
    const selection = () => active() ? [...getSelection()].filter(id => slots[id] && getStates()[id]) : [];
    const allowed = (asset, variant) => !!asset && (variant === '原款' ?
      asset.group === 'I ♥ ME 组合' : asset.type === 'heart' && asset.variant === variant);
    let pending = null, request = 0, cached = null;
    const busy = () => !!pending && pending.states === getStates() && pending.source === getSource() && active();

    function placement(id, asset) {
      const [x, y, w, h] = slots[id].box, cfg = getTemplate();
      // Fit within the existing artwork box, never enlarge the chosen material.
      const factor = Math.min(1, w / cfg.w * 144 / asset.nativeW, h / cfg.h * 210 / asset.nativeH);
      const pw = asset.nativeW * factor / 144 * cfg.w, ph = asset.nativeH * factor / 210 * cfg.h;
      return { x: x + (w - pw) / 2, y: y + (h - ph) / 2, w: pw, h: ph };
    }

    async function replace(ids, assetId) {
      const asset = assets[assetId], unique = [...new Set(ids)];
      if (!active() || !unique.length || !unique.every(id => slots[id] && getStates()[id] && allowed(asset, slots[id].variant))) {
        report('请选择同规格的小款、大款或 I ♥ ME 组合后更换。', true); return;
      }
      const target = { states: getStates(), source: getSource(), request: ++request };
      pending = target; redraw();
      try {
        const image = await loadImage(assetId);
        if (pending !== target || request !== target.request || !busy()) return;
        for (const id of unique) {
          const p = placement(id, asset), frame = asset.frame;
          const photoFrame = slots[id].variant === '原款' ? {
            x: p.x + p.w * frame.x, y: p.y + p.h * frame.y, w: p.w * frame.w, h: p.h * frame.h,
          } : { ...getTemplate().slots[id] };
          target.states[id].motif = { assetId, image, placement: p, frame: photoFrame };
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
        if (!slots[id] || !getStates()[id]) continue;
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
        const [x, y, w, h] = slots[id].box, p = motif.placement;
        paint.clearRect(x, y, w, h);
        paint.drawImage(motif.image, p.x, p.y, p.w, p.h);
      });
      cached = { base, states, values, canvas };
      return canvas;
    }

    function rows(widthMm, heightMm) {
      if (!active()) return [];
      const cfg = getTemplate(), states = getStates();
      return slots.map((meta, id) => {
        const motif = states[id]?.motif, [x, y, w, h] = meta.box;
        const p = motif?.placement || { x, y, w, h };
        return { index: id, row: meta.row, column: meta.column, variant: meta.variant,
          name: motif ? assets[motif.assetId].baseName : meta.name,
          width: p.w / cfg.w * widthMm, height: p.h / cfg.h * heightMm };
      });
    }

    return { active, selection, allowed, placement, replace, restore, source, rows, busy };
  }

  globalThis.HeartStarMotifs = { create };
})();
