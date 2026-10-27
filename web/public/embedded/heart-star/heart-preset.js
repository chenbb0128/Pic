// Independent upright artwork arranged on a 210 × 144 mm sheet.
(() => {
  const name = '爱心横版.png', sources = new WeakMap();
  const portraitName = 'I-ME横版大头.png';
  let previousSize = null;
  function build(assets, arrange) {
    const repeat = (id, count) => Array(count).fill(id);
    const rows = [
      [...repeat('ime-rose', 3), ...repeat('ime-teal', 3)],
      [...repeat('ime-mint', 3), ...repeat('ive-spiral', 3)],
      [...repeat('rose-heart-small', 3), 'rose-dot-star-small', 'teal-dot-star-small', ...repeat('teal-heart-small', 3)],
      [...repeat('pink-stripe-heart-small', 3), 'mint-star-small', 'white-mint-star-small', ...repeat('mint-plaid-heart-small', 3)],
      [...repeat('purple-white-polka-heart-small', 4), ...repeat('polka-heart-small', 4)],
    ];
    return buildRows(rows, assets, arrange);
  }
  function buildRows(patterns, assets, arrange) {
    const rows = patterns.map((ids, row) => ({
      id: `preset-${row}`, groups: ids.map((assetId, column) => ({ id: String(column), assetId, count: 1 })),
    }));
    const layout = arrange(rows, assets, 210, 144);
    const motifSlots = layout.placements.map((p, i) => ({
      index: i, row: layout.slots[i].row, column: layout.slots[i].column,
      name: assets[p.assetId].baseName, variant: assets[p.assetId].variant, box: [p.x, p.y, p.w, p.h],
    }));
    return { ...layout, preset: true, widthMm: 210, heightMm: 144, motifSlots };
  }
  function buildPortrait(assets, arrange) {
    const cfg = buildRows([
      ['ime-pink-stripe', 'ime-red-polka', 'ime-brown-polka', 'ime-rose', 'ime-rose', 'ime-brown-stripe'],
      ['ime-rose', 'ime-pink-dot', 'ime-light-blue-stripe', 'ive-rose', 'ive-rose', 'ive-rose'],
      ['pink-dot-heart-small', 'brown-polka-heart-small', 'brown-stripe-heart-small', 'rose-dot-star-small', 'rose-dot-star-small', 'rose-heart-small', 'rose-heart-small', 'pink-dot-heart-small'],
      ['pink-dot-heart-small', 'light-blue-stripe-heart-small', 'light-blue-stripe-heart-small', 'teal-dot-star-small', 'teal-dot-star-small', 'pink-stripe-heart-small', 'red-polka-heart-small', 'rose-heart-small'],
      ['rose-heart-small', 'rose-heart-small', 'teal-heart-small', 'teal-heart-small', 'polka-heart-small', 'rose-heart-small', 'purple-white-polka-heart-small', 'purple-white-polka-heart-small'],
    ], assets, arrange);
    cfg.photoOnlySlots = [10, 11, 17, 18, 33];
    cfg.largePortraitSlots = [10, 11];
    return cfg;
  }
  function initialState(cfg, index) {
    const state = { size: .62, dx: 0, dy: 0, shape: 'template', imageScale: 1, imageDx: 0, imageDy: 0 };
    if (cfg.photoOnlySlots?.includes(index)) {
      state.background = { type: 'transparent', photoBaseSize: .62 };
      if (cfg.largePortraitSlots?.includes(index)) {
        state.imageScale = 1.2;
        state.background.keepLetters = true;
      }
    }
    return state;
  }
  function source(cfg, loadImage) {
    if (!sources.has(cfg)) sources.set(cfg, (async () => {
      const ids = [...new Set(cfg.placements.map(p => p.assetId))];
      const images = new Map(await Promise.all(ids.map(async id => [id, await loadImage(id)])));
      const sheet = document.createElement('canvas');sheet.width = cfg.w;sheet.height = cfg.h;
      const paint = sheet.getContext('2d');
      cfg.placements.forEach(p => paint.drawImage(images.get(p.assetId), p.x, p.y, p.w, p.h));
      return sheet.toDataURL('image/png');
    })().catch(error => { sources.delete(cfg); throw error; }));
    return sources.get(cfg);
  }
  function selectSize(cfg, width, height) {
    if (cfg.preset) {
      if (!previousSize) previousSize = [width.value, height.value];
      width.value = String(cfg.widthMm);height.value = String(cfg.heightMm);
    } else if (previousSize) {
      [width.value, height.value] = previousSize;previousSize = null;
    }
  }
  globalThis.HeartStarPreset = { name, portraitName, build, buildPortrait, initialState, source, selectSize };
})();
