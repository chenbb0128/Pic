(() => {
  function register(assets) {
    const entries = {};
    for (const [type, source, label] of [['heart', 'rose-heart', '奶油粉豹纹爱心'], ['star', 'mint-star', '奶油粉豹纹星星']]) {
      for (const suffix of ['-small', '']) {
        const original = assets[`${source}${suffix}`], id = `cream-pink-leopard-${type}${suffix}`;
        entries[id] = { ...original, name: `${label} · ${original.variant}`, baseName: label,
          group: '奶油粉豹纹系列', src: `./assets/${id}.png?v=cream-pink-2` };
      }
    }
    for (const [letters, text] of [['ime', 'I ♥ ME'], ['ive', 'I ♥ VE']]) {
      const original = assets[`${letters}-rose`], id = `${letters}-cream-pink-leopard`;
      entries[id] = { ...original, name: `奶油粉豹纹 ${text} · 原款`, baseName: `奶油粉豹纹 ${text}`,
        src: `./assets/${id}.png?v=cream-pink-2` };
    }
    return entries;
  }
  globalThis.HeartStarCreamPinkLeopard = { register };
})();
