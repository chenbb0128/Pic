(() => {
  function register(assets) {
    const entries = {};
    for (const [type, source, label] of [['heart', 'rose-heart', '大红波点爱心'], ['star', 'mint-star', '大红波点星星']]) {
      for (const suffix of ['-small', '']) {
        const original = assets[`${source}${suffix}`], id = `red-polka-${type}${suffix}`;
        entries[id] = { ...original, name: `${label} · ${original.variant}`, baseName: label,
          group: '大红系列', src: `./assets/${id}.png` };
      }
    }
    for (const [letters, label] of [['ime', '大红波点 I ♥ ME'], ['ive', '大红波点 I ♥ VE']]) {
      const original = assets[`${letters}-rose`], id = `${letters}-red-polka`;
      entries[id] = { ...original, name: `${label} · ${original.variant}`, baseName: label,
        src: `./assets/${id}.png` };
    }
    return entries;
  }
  globalThis.HeartStarRed = { register };
})();
