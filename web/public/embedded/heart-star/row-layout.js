(() => {
  'use strict';
  function plan({ cfg, catalog, ids, assetId, asset, count, widthMm, heightMm, keyPrefix = 'row' }) {
    const selectedRows = new Set(ids.map(id => catalog[id]?.row));
    if (!ids.length || selectedRows.size !== 1 || selectedRows.has(undefined)) throw Error('请只选择同一排中的图案，再调整整排。');
    if (!Number.isInteger(count) || count < 1 || count > 12) throw Error('整排数量请输入 1–12 的整数。');
    if (!asset || ![asset.nativeW, asset.nativeH, widthMm, heightMm].every(v => Number.isFinite(v) && v > 0)) throw Error('请选择有效图案和纸张尺寸。');
    const row = [...selectedRows][0], old = catalog.filter(meta => meta.row === row), indices = old.map(meta => meta.index);
    const first = indices[0], last = indices.at(-1);
    if (last - first + 1 !== old.length) throw Error('这一排的位置数据不连续，暂时无法调整。');
    const left = Math.min(...old.map(meta => meta.box[0])), top = Math.min(...old.map(meta => meta.box[1]));
    const bounds = old[0].rowBounds || [left, top,
      Math.max(...old.map(meta => meta.box[0] + meta.box[2])) - left,
      Math.max(...old.map(meta => meta.box[1] + meta.box[3])) - top];
    const [x, y, w, h] = bounds, pw = asset.nativeW / widthMm * cfg.w, ph = asset.nativeH / heightMm * cfg.h;
    const minGap = 2 / widthMm * cfg.w;
    if (count * pw + (count - 1) * minGap > w + 1e-7 || ph > h + 1e-7) throw Error('该图案和数量放不下原来这一排，请减少数量或选择小款图案。');
    const gap = count > 1 ? (w - count * pw) / (count - 1) : 0;
    const placements = Array.from({ length: count }, (_, column) => ({ assetId, key: `${keyPrefix}:${column}`,
      x: count === 1 ? x + (w - pw) / 2 : x + column * (pw + gap), y: y + (h - ph) / 2, w: pw, h: ph, rowBounds: bounds }));
    const newSlots = placements.map((p, column) => ({ x: p.x + asset.frame.x * pw, y: p.y + asset.frame.y * ph,
      w: asset.frame.w * pw, h: asset.frame.h * ph, type: asset.type, assetId, key: p.key, row, column,
      ...(['I ♥ ME 组合', 'I ♥ VE 组合'].includes(asset.group) ? { backgroundPart: 'heart' } : {}) }));
    const entries = placements.map((p, column) => ({ row, column, assetId, name: asset.baseName, variant: asset.variant,
      type: asset.type, box: [p.x, p.y, pw, ph], rowBounds: bounds }));
    const splice = (original, inserted) => [...original.slice(0, first), ...inserted, ...original.slice(last + 1)];
    return { row, old, slots: splice(cfg.slots, newSlots), catalog: splice(catalog, entries).map((meta, index) => ({ ...meta, index })),
      ...(cfg.placements ? { placements: splice(cfg.placements, placements) } : {}),
      added: placements, selected: placements.map((_, column) => first + column),
      sourceIndices: splice(catalog.map(meta => meta.index), placements.map((_, column) => indices[column % indices.length])) };
  }
  function remapStates(states, result) {
    const changed = new Set(result.selected);
    return result.sourceIndices.map((source, index) => {
      if (!changed.has(index)) return states[source];
      const { motif, background, ...state } = states[source];
      return { ...state, size: .62, dx: 0, dy: 0, shape: 'template', imageScale: 1, imageDx: 0, imageDy: 0 };
    });
  }
  globalThis.HeartStarRowLayout = { plan, remapStates };
})();
