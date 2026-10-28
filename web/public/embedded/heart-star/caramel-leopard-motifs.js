(() => {
  function register(assets) {
    const entries = {};
    for (const [type, source, label] of [['heart', 'rose-heart', '经典焦糖豹纹爱心'], ['star', 'mint-star', '经典焦糖豹纹星星']]) {
      for (const suffix of ['-small', '']) {
        const original = assets[`${source}${suffix}`], id = `caramel-leopard-${type}${suffix}`;
        entries[id] = { ...original, name: `${label} · ${original.variant}`, baseName: label,
          group: '经典焦糖豹纹系列', src: `./assets/${id}.png?v=caramel-8` };
      }
    }
    for (const [letters, text] of [['ime', 'I ♥ ME'], ['ive', 'I ♥ VE']]) {
      const original = assets[`${letters}-rose`], id = `${letters}-caramel-leopard`;
      entries[id] = { ...original, name: `经典焦糖豹纹 ${text} · 原款`, baseName: `经典焦糖豹纹 ${text}`,
        src: `./assets/${id}.png?v=caramel-8` };
    }
    return entries;
  }
  globalThis.HeartStarCaramelLeopard = { register };
})();
