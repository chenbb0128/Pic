(() => {
  function register(assets) {
    return {
      'white-pink-dot-heart-small': { ...assets['pink-star-heart-small'],
        name: '白底粉点爱心 · 小款', baseName: '白底粉点爱心', group: '甜心派对',
        src: './assets/white-pink-dot-heart-small.png' },
      'ime-hot-pink': { ...assets['ime-rose'],
        name: '纯玫红 I ♥ ME · 原款', baseName: '纯玫红 I ♥ ME',
        src: './assets/ime-hot-pink.png' },
    };
  }
  globalThis.HeartStarParty = { register };
})();
