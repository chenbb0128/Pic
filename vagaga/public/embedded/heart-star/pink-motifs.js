(() => {
  function register(assets) {
    const entries = {};
    for (const suffix of ['-small', '']) {
      const original = assets[`rose-heart${suffix}`], id = `pink-stripe-heart${suffix}`;
      entries[id] = { ...original, name: `粉色条纹爱心 · ${original.variant}`, baseName: '粉色条纹爱心',
        group: '粉色款', src: `./assets/${id}.png` };
      const star = assets[`white-mint-star${suffix}`], starId = `white-pink-star${suffix}`;
      entries[starId] = { ...star, name: `白底粉星星 · ${star.variant}`, baseName: '白底粉星星',
        group: '粉色款', src: `./assets/${starId}.png` };
    }
    return entries;
  }
  globalThis.HeartStarPink = { register };
})();
