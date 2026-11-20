// Independent artwork presets with explicit paper dimensions.
(() => {
  const name = '爱心横版.png', sources = new WeakMap();
  const portraitName = 'I-ME横版大头.png', macaronName = '爱心心动马卡龙.png';
  const classicLeopardName = '经典豹纹混合.png';
  const blackPinkCreamLeopardName = '黑粉奶油混合豹纹.png';
  const candyName = '缤纷糖果.png';
  const partyName = '甜心派对.png';
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
  function buildRows(patterns, assets, arrange, widthMm = 210, heightMm = 144, minGap = 20) {
    const rows = patterns.map((ids, row) => ({
      id: `preset-${row}`, groups: ids.map((assetId, column) => ({ id: String(column), assetId, count: 1 })),
    }));
    const layout = arrange(rows, assets, widthMm, heightMm, minGap);
    const motifSlots = layout.placements.map((p, i) => ({
      index: i, row: layout.slots[i].row, column: layout.slots[i].column,
      name: assets[p.assetId].baseName, variant: assets[p.assetId].variant, box: [p.x, p.y, p.w, p.h],
    }));
    return { ...layout, preset: true, widthMm, heightMm, motifSlots };
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
  function buildClassicLeopard(assets, arrange) {
    return buildLeopardMix(assets, arrange, 'caramel-leopard', 'autumn-maple-leopard');
  }
  function buildBlackPinkCreamLeopard(assets, arrange) {
    return buildLeopardMix(assets, arrange, 'black-pink-leopard', 'cream-pink-leopard');
  }
  function buildLeopardMix(assets, arrange, first, second) {
    const repeat = (id, count) => Array(count).fill(id);
    const pair = (a, b, count) => [...repeat(a, count), ...repeat(b, count)];
    const rows = [
      pair(`${first}-star-small`, `${second}-star-small`, 3),
      pair(`${first}-star-small`, `${second}-star-small`, 3),
      pair(`${first}-heart-small`, `${second}-heart-small`, 3),
      pair(`${first}-heart-small`, `${second}-heart-small`, 3),
      [`${first}-heart`, `${second}-heart`, `${first}-star`, `${second}-star`],
      [`${first}-heart`, `${second}-heart`, `${first}-star`, `${second}-star`],
      pair(`ime-${first}`, `ime-${second}`, 2),
      pair(`ime-${first}`, `ime-${second}`, 2),
    ];
    const fittedAssets = { ...assets };
    // Keep small motifs unchanged and reserve at least 2 mm between all eight rows.
    for (const id of new Set(rows.slice(4).flat())) {
      const asset = assets[id], factor = Math.min(1, 27.5 / Math.max(asset.nativeW, asset.nativeH));
      fittedAssets[id] = { ...asset, nativeW: asset.nativeW * factor, nativeH: asset.nativeH * factor };
    }
    const cfg = buildRows(rows, fittedAssets, arrange, 144, 210);
    cfg.motifSlots.forEach((meta, i) => { if (cfg.slots[i].row >= 4) meta.maxSizeMm = 27.5; });
    return cfg;
  }
  function buildMacaron(assets, arrange) {
    const repeat = (id, count) => Array(count).fill(id);
    const fittedAssets = { ...assets }, miniOriginals = new Map();
    const miniIds = ['pink-dot-heart-small', 'polka-heart-small', 'yellow-glow-heart-small'].map(id => {
      const miniId = `macaron-mini-${id}`, asset = assets[id], factor = 10 / Math.max(asset.nativeW, asset.nativeH);
      fittedAssets[miniId] = { ...asset, variant: '迷你款', nativeW: asset.nativeW * factor, nativeH: asset.nativeH * factor };
      miniOriginals.set(miniId, id);
      return miniId;
    });
    const rows = [
      repeat('pink-dot-heart-small', 6),
      repeat('yellow-grid-heart-small', 6),
      [...repeat('pink-glow-heart-small', 2), ...repeat('polka-heart-small', 2), ...repeat('pink-glow-heart-small', 2)],
      [...repeat('yellow-glow-heart-small', 2), ...repeat('polka-heart-small', 2), ...repeat('yellow-glow-heart-small', 2)],
      miniIds.flatMap(id => repeat(id, 3)),
      [...repeat('pink-dot-heart', 2), 'polka-heart', 'pink-dot-heart'],
      [...repeat('yellow-grid-heart', 2), 'polka-heart', 'yellow-grid-heart'],
      ['ime-pink-glow', 'ime-pink-dot', 'ime-polka', 'ime-yellow-grid'],
    ];
    for (const id of new Set(rows.slice(5, 7).flat())) {
      const asset = assets[id], factor = Math.min(1, 30 / Math.max(asset.nativeW, asset.nativeH));
      fittedAssets[id] = { ...asset, nativeW: asset.nativeW * factor, nativeH: asset.nativeH * factor };
    }
    const cfg = buildRows(rows, fittedAssets, arrange, 144, 210);
    cfg.placements.forEach((placement, index) => {
      if ([5, 6].includes(cfg.slots[index].row)) cfg.motifSlots[index].maxSizeMm = 30;
      const assetId = miniOriginals.get(placement.assetId);
      if (!assetId) return;
      placement.assetId = assetId;
      cfg.slots[index].assetId = assetId;
      Object.assign(cfg.motifSlots[index], { assetId, maxSizeMm: 10 });
    });
    return cfg;
  }
  function buildParty(assets, arrange) {
    const repeat = (id, count) => Array(count).fill(id);
    const smallA = [...repeat('pink-dot-heart-small', 3), ...repeat('white-pink-dot-heart-small', 3)];
    const smallB = [...repeat('rose-heart-small', 3), ...repeat('polka-heart-small', 3)];
    const large = ['rose-heart', 'pink-glow-heart', 'yellow-grid-heart', 'blue-grid-heart'];
    const letters = ['ime-rose', 'ime-pink-star', 'ime-polka', 'ime-hot-pink'];
    const rows = [smallA, smallA, smallB, smallB, large, large, letters, letters];
    const fittedAssets = { ...assets };
    for (const id of new Set(rows.slice(4).flat())) {
      const asset = assets[id], factor = Math.min(1, 27.5 / Math.max(asset.nativeW, asset.nativeH));
      fittedAssets[id] = { ...asset, nativeW: asset.nativeW * factor, nativeH: asset.nativeH * factor };
    }
    const cfg = buildRows(rows, fittedAssets, arrange, 144, 210);
    cfg.motifSlots.forEach((meta, i) => Object.assign(meta, {
      assetId: cfg.placements[i].assetId, type: cfg.slots[i].type,
      ...(cfg.slots[i].row >= 4 ? { maxSizeMm: 27.5 } : {}),
    }));
    return cfg;
  }
  function buildCandy(assets, arrange) {
    const ids = (keys, type, size) => keys.map(key => `candy-${key}-${type}-${size}`);
    const circles = ids(['cream-pink-dot', 'pink-picnic', 'lavender', 'matcha', 'cream-pink-dot', 'pink-picnic'], 'circle', 20);
    const hearts = ids(['blue-cocoa', 'strawberry-milk', 'lemon-soda', 'grape-checker', 'peach-heart', 'cream-pink-dot'], 'heart', 20);
    const large = ['strawberry-star', 'grape-dot', 'peach-sorbet', 'daisy'];
    const rows = [circles, circles, hearts, hearts, ids(large, 'heart', 30), ids(large, 'star', 30),
      ids(['pink-flower', 'blue-letter', 'night-stars', 'purple-heart'], 'flower', 30),
      ids(['cherry-letter', 'cream-garden', 'lavender', 'sunflower'], 'scallop', 30)];
    const fittedAssets = { ...assets };
    // Eight rows fit the existing A5 sheet at 29.5 mm with 2 mm gaps and 3 mm margins.
    // Scale only this preset's large artwork; reusable 30 mm assets stay unchanged.
    for (const id of new Set(rows.slice(4).flat())) {
      const asset = assets[id], factor = Math.min(1, 29.5 / Math.max(asset.nativeW, asset.nativeH));
      fittedAssets[id] = { ...asset, nativeW: asset.nativeW * factor, nativeH: asset.nativeH * factor };
    }
    const cfg = buildRows(rows, fittedAssets, arrange, 144, 210);
    cfg.motifSlots.forEach((meta, i) => Object.assign(meta, {
      assetId: cfg.placements[i].assetId, type: cfg.slots[i].type, maxSizeMm: cfg.slots[i].row < 4 ? 20 : 29.5,
    }));
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
  globalThis.HeartStarPreset = { name, portraitName, macaronName, classicLeopardName, blackPinkCreamLeopardName, candyName, partyName, build, buildPortrait, buildMacaron, buildClassicLeopard, buildBlackPinkCreamLeopard, buildCandy, buildParty, initialState, source, selectSize };
})();
