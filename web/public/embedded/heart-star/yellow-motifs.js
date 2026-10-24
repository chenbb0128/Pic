(() => {
  function register(assets) {
    const entries = {};
    for (const suffix of ['-small', '']) {
      const original = assets[`rose-heart${suffix}`], id = `yellow-polka-heart${suffix}`;
      entries[id] = { ...original, name: `黄色波点爱心 · ${original.variant}`, baseName: '黄色波点爱心',
        group: '黄色款', src: `./assets/${id}.png` };
    }
    for (const [letters, text] of [['ime', 'I ♥ ME'], ['ive', 'I ♥ VE']]) {
      const original = assets[`${letters}-yellow-glow`], id = `${letters}-yellow-polka`;
      entries[id] = { ...original, name: `黄色波点 ${text} · 原款`, baseName: `黄色波点 ${text}`,
        src: `./assets/${id}.png` };
    }
    return entries;
  }
  globalThis.HeartStarYellow = { register };
})();
