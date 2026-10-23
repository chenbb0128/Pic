(() => {
  'use strict';
  function capture({ name, cfg, base, states, photoAt, catalog, settings, customRows, copy }) {
    const keys = ['w', 'h', 'slots', 'placements', 'widthMm', 'heightMm', 'contentOffsetX', 'photoTypes', 'text', 'custom'];
    const template = Object.fromEntries(keys.filter(k => cfg[k] !== undefined).map(k => [k, cfg[k]]));
    template.motifSlots = catalog; template.name = name;
    if (!cfg.text) template.image = cfg.custom ? cfg.background : base;
    return { template, states, photos: states.map((_, i) => cfg.text ? null : photoAt(i)), settings,
      ...(cfg.custom ? { customRows } : {}), ...(cfg.text ? { copy } : {}) };
  }
  function validate(data, assets) {
    const cfg = data.template, settings = data.settings;
    const bad = () => { throw Error('保存的排版数据或素材不兼容，当前编辑已保留，请勿覆盖原文件'); };
    const finite = v => typeof v === 'number' && Number.isFinite(v);
    if (!cfg || !finite(cfg.w) || !finite(cfg.h) || cfg.w < 1 || cfg.h < 1 || cfg.w * cfg.h > 40e6 ||
        !Array.isArray(cfg.slots) || !cfg.slots.length || cfg.slots.length > 1000 ||
        !Array.isArray(data.states) || data.states.length !== cfg.slots.length || data.photos?.length !== cfg.slots.length ||
        !settings || ![150, 300, 500, 600].includes(settings.dpi) ||
        ![settings.width, settings.height].every(v => finite(v) && v >= 20 && v <= 1000)) bad();
    if (!cfg.text && (!cfg.image?.naturalWidth || !cfg.image?.naturalHeight)) bad();
    for (let i = 0; i < cfg.slots.length; i++) {
      const p = cfg.slots[i], st = data.states[i];
      if (!p || !['x', 'y', 'w', 'h'].every(k => finite(p[k])) || p.w <= 0 || p.h <= 0 || !st || typeof st !== 'object') bad();
      for (const key of ['size', 'dx', 'dy', 'imageScale', 'imageDx', 'imageDy']) if (st[key] !== undefined && !finite(st[key])) bad();
      if (st.motif && (!assets[st.motif.assetId] || !st.motif.image?.naturalWidth || !st.motif.frame || !st.motif.placement)) bad();
      if (st.background?.type === 'image' && !st.background.image?.naturalWidth) bad();
      if (data.photos[i] && !data.photos[i].naturalWidth) bad();
    }
    if (cfg.motifSlots?.some(meta => !Array.isArray(meta.box) || meta.box.length !== 4 || !meta.box.every(finite))) bad();
    if (cfg.custom && (!Array.isArray(data.customRows) || data.customRows.length > 20 || data.customRows.some(row =>
      !Array.isArray(row.groups) || !row.groups.length || row.groups.some(group => !assets[group.assetId] || !Number.isInteger(group.count) || group.count < 1 || group.count > 12)))) bad();
    if (cfg.text && (!data.copy?.style || !Array.isArray(data.copy.jobs) || !data.copy.layout || data.states.some(st => typeof st.text !== 'string'))) bad();
    return data;
  }
  globalThis.HeartStarCloudEditor = { capture, validate };
})();
