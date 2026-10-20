(() => {
  function register(assets) {
    const entries = {};
    for (const suffix of ['-small', '']) {
      const original = assets[`rose-heart${suffix}`], id = `pink-stripe-heart${suffix}`;
      entries[id] = { ...original, name: `粉色条纹爱心 · ${original.variant}`, baseName: '粉色条纹爱心',
        group: '粉色款', src: `./assets/${id}.png` };
    }
    return entries;
  }
  globalThis.HeartStarPink = { register };
})();
