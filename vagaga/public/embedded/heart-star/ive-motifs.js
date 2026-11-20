(() => {
  function register(assets) {
    const variants = {};
    for (const [id, asset] of Object.entries(assets)) {
      if (asset.group !== 'I ♥ ME 组合') continue;
      const variantId = id.replace(/^ime-/, 'ive-');
      variants[variantId] = { ...asset,
        name: asset.name.replace('I ♥ ME', 'I ♥ VE'),
        baseName: asset.baseName.replace('I ♥ ME', 'I ♥ VE'),
        group: 'I ♥ VE 组合', src: `./assets/${variantId}.png`,
      };
    }
    return variants;
  }
  globalThis.HeartStarIVE = { register };
})();
