(() => {
  function register(assets) {
    const entries = {};
    for (const [type, source, label] of [['heart', 'rose-heart', '秋枫豹纹爱心'], ['star', 'mint-star', '秋枫豹纹星星']]) {
      for (const suffix of ['-small', '']) {
        const original = assets[`${source}${suffix}`], id = `autumn-maple-leopard-${type}${suffix}`;
        entries[id] = { ...original, name: `${label} · ${original.variant}`, baseName: label,
          group: '秋枫豹纹系列', src: `./assets/${id}.png` };
      }
    }
    for (const [letters, text] of [['ime', 'I ♥ ME'], ['ive', 'I ♥ VE']]) {
      const original = assets[`${letters}-rose`], id = `${letters}-autumn-maple-leopard`;
      entries[id] = { ...original, name: `秋枫豹纹 ${text} · 原款`, baseName: `秋枫豹纹 ${text}`,
        src: `./assets/${id}.png` };
    }
    return entries;
  }
  globalThis.HeartStarAutumnMapleLeopard = { register };
})();
