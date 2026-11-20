(() => {
  function register(assets) {
    const entries = {};
    for (const [pattern, label] of [['polka', '天蓝波点'], ['stripe', '天蓝竖条纹']]) {
      for (const suffix of ['-small', '']) {
        const original = assets[`rose-heart${suffix}`], id = `sky-blue-${pattern}-heart${suffix}`;
        entries[id] = { ...original, name: `${label}爱心 · ${original.variant}`, baseName: `${label}爱心`,
          group: '天蓝色款', src: `./assets/${id}.png` };
      }
      for (const [letters, text] of [['ime', 'I ♥ ME'], ['ive', 'I ♥ VE']]) {
        const original = assets[`${letters}-rose`], id = `${letters}-sky-blue-${pattern}`;
        entries[id] = { ...original, name: `${label} ${text} · 原款`, baseName: `${label} ${text}`,
          src: `./assets/${id}.png` };
      }
    }
    return entries;
  }
  globalThis.HeartStarSkyBlue = { register };
})();
