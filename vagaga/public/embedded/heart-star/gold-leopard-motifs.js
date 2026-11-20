(() => {
  function register(assets) {
    const entries = {};
    for (const [type, source, label] of [['heart', 'rose-heart', '棕金豹纹爱心'], ['star', 'mint-star', '棕金豹纹星星']]) {
      for (const suffix of ['-small', '']) {
        const original = assets[`${source}${suffix}`], id = `gold-leopard-${type}${suffix}`;
        entries[id] = { ...original, name: `${label} · ${original.variant}`, baseName: label,
          group: '棕金豹纹系列', src: `./assets/${id}.png` };
      }
    }
    return entries;
  }
  globalThis.HeartStarGoldLeopard = { register };
})();
