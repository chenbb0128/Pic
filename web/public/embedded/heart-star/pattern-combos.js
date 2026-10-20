(() => {
  function register(assets) {
    const entries = {};
    for (const [pattern, label] of [['brown-polka', '棕色波点'], ['brown-stripe', '棕色竖条纹'], ['pink-stripe', '粉色竖条纹']]) {
      for (const [letters, text] of [['ime', 'I ♥ ME'], ['ive', 'I ♥ VE']]) {
        const original = assets[`${letters}-rose`], id = `${letters}-${pattern}`;
        entries[id] = { ...original, name: `${label} ${text} · 原款`, baseName: `${label} ${text}`,
          src: `./assets/${id}.png` };
      }
    }
    return entries;
  }
  globalThis.HeartStarPatternCombos = { register };
})();
