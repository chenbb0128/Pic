(() => {
  function register(assets) {
    const entries = {};
    for (const [type, source, label] of [['heart', 'rose-heart', '黑粉豹纹爱心'], ['star', 'mint-star', '黑粉豹纹星星']]) {
      for (const suffix of ['-small', '']) {
        const original = assets[`${source}${suffix}`], id = `black-pink-leopard-${type}${suffix}`;
        entries[id] = { ...original, name: `${label} · ${original.variant}`, baseName: label,
          group: '黑粉豹纹系列', src: `./assets/${id}.png?v=black-pink-7` };
      }
    }
    for (const [letters, text] of [['ime', 'I ♥ ME'], ['ive', 'I ♥ VE']]) {
      const original = assets[`${letters}-rose`], id = `${letters}-black-pink-leopard`;
      entries[id] = { ...original, name: `黑粉豹纹 ${text} · 原款`, baseName: `黑粉豹纹 ${text}`,
        src: `./assets/${id}.png?v=black-pink-7` };
    }
    return entries;
  }
  globalThis.HeartStarBlackPinkLeopard = { register };
})();
