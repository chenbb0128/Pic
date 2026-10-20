(() => {
  function register(assets) {
    const entries = {};
    for (const [pattern, label] of [['polka', '棕色波点爱心'], ['stripe', '棕色条纹爱心']]) {
      for (const suffix of ['-small', '']) {
        const original = assets[`rose-heart${suffix}`], id = `brown-${pattern}-heart${suffix}`;
        entries[id] = { ...original, name: `${label} · ${original.variant}`, baseName: label,
          group: '棕色系列', src: `./assets/${id}.png${pattern === 'stripe' ? '?v=vertical-2' : ''}` };
      }
    }
    return entries;
  }
  globalThis.HeartStarBrown = { register };
})();
