// Christmas artwork sheet with calibrated rectangular photo areas.
(() => {
  'use strict';
  const name = '圣诞.png';
  const source = './assets/christmas-template.png?v=1';
  function build() {
    const rows = [
      [[[65, 89, 326, 329]], [[482, 89, 326, 329]], [[891, 89, 326, 329]], [[1316, 89, 326, 329]]],
      [[[73, 479, 339, 330]], [[484, 479, 339, 330]], [[897, 479, 339, 330]], [[1310, 479, 339, 330]]],
      [[[63, 877, 218, 221]], [[339, 877, 218, 221]], [[615, 877, 218, 221]], [[892, 877, 218, 221]], [[1168, 877, 218, 221]], [[1444, 877, 218, 221]]],
      [[[72, 1181, 211, 214]], [[348, 1181, 211, 214]], [[624, 1181, 211, 214]], [[899, 1181, 211, 214]], [[1175, 1181, 211, 214]], [[1451, 1181, 211, 214]]],
      [[[63, 1478, 225, 224]], [[340, 1478, 225, 224]], [[616, 1478, 225, 224]], [[893, 1478, 225, 224]], [[1169, 1478, 225, 224]], [[1446, 1478, 225, 224]]],
      [[[73, 1787, 274, 298]], [[361, 1787, 274, 298]], [[657, 1787, 274, 298]], [[956, 1787, 249, 298]], [[1219, 1787, 249, 298]], [[1485, 1787, 249, 298]]],
      [[[83, 2112, 242, 277]], [[371, 2112, 242, 277]], [[677, 2112, 242, 277]], [[957, 2112, 208, 277]], [[1209, 2112, 208, 277]], [[1477, 2112, 208, 277]]],
    ];
    const rowOffsets = [20.5, 12.5, 11.5, 7, 7, -29.5, -10];
    const originalW = 1748, w = 1701, h = 2480, widthMm = 144, heightMm = 210;
    const scaleY = .95, scaleX = scaleY * 148 / widthMm * w / originalW;
    const moveX = x => w / 2 + (x - originalW / 2) * scaleX;
    const moveY = y => h / 2 + (y - h / 2) * scaleY;
    const slots = [], placements = [];
    rows.forEach((entries, row) => entries.forEach(([box], column) => {
      const [originalX, originalY, originalWBox, originalHBox] = box;
      const x = moveX(originalX + rowOffsets[row]), y = moveY(originalY);
      const artworkW = originalWBox * scaleX, artworkH = originalHBox * scaleY;
      const photoW = artworkW * .62, photoH = artworkH * .62;
      const center = { x: x + artworkW / 2, y: y + artworkH / 2 };
      slots.push({ x: center.x, y: center.y, w: photoW / .62, h: photoH / .62,
        type: 'rect', row, column, photoArea: { x: center.x, y: center.y, w: photoW, h: photoH } });
      placements.push({ x, y, w: artworkW, h: artworkH });
    }));
    return { w, h, widthMm, heightMm, slots, placements, motifSlots: [] };
  }
  globalThis.HeartStarChristmas = { name, source, build };
  const select = document.getElementById('template');
  if (select && ![...select.options].some(option => option.value === name)) {
    const option = document.createElement('option'); option.value = name; option.textContent = 'A13 欢乐圣诞 · A5 竖版';
    select.insertBefore(option, select.querySelector('option[value="模板混合.png"]'));
  }
})();
