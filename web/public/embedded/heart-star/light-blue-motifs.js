(() => {
  function register(assets) {
    const entries = {};
    for (const [pattern, label] of [['solid', '浅蓝纯色'], ['stripe', '浅蓝竖条纹']]) {
      for (const [type, source, shape] of [['heart', 'rose-heart', '爱心'], ['star', 'mint-star', '星星']]) {
        for (const suffix of ['-small', '']) {
          const original = assets[`${source}${suffix}`], id = `light-blue-${pattern}-${type}${suffix}`;
          entries[id] = { ...original, name: `${label}${shape} · ${original.variant}`, baseName: `${label}${shape}`,
            group: '浅蓝色款', src: `./assets/${id}.png` };
        }
      }
    }
    return entries;
  }
  globalThis.HeartStarLightBlue = { register };
})();
