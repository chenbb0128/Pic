// Clean artwork and calibrated photo positions are kept separate so
// same-size artwork updates can reuse the saved coordinates.
(() => {
  'use strict';
  const name = '草莓.png';
  const source = './assets/strawberry-template.png?v=3';
  function build() {
    // Each entry: artwork [left, top, width, height], photo [cx, cy, width, height].
    // Centers use the filled artwork silhouette, rounded to half a pixel.
    // This keeps hearts above their pointed tips and excludes texture holes.
    const rows = [
      [
        [[65, 91, 326, 326], [228, 254, 216, 232]],
        [[457, 91, 326, 326], [620, 254, 216, 232]],
        [[872, 78, 333, 333], [1038.5, 244.5, 216, 232]],
        [[1312, 78, 333, 333], [1478.5, 244.5, 216, 232]],
      ],
      [
        [[71, 480, 344, 330], [242.5, 661.5, 136, 144]],
        [[480, 480, 344, 330], [651.5, 661.5, 136, 144]],
        [[888, 481, 344, 329], [1059.5, 662.5, 136, 144]],
        [[1295, 481, 344, 329], [1466.5, 662.5, 136, 144]],
      ],
      [
        [[55, 856, 233, 229], [172, 971, 126, 134]],
        [[332, 856, 234, 229], [449, 971, 126, 134]],
        [[610, 856, 233, 229], [727, 971, 126, 134]],
        [[887, 856, 234, 229], [1004, 971, 126, 134]],
        [[1165, 856, 233, 229], [1282, 971, 126, 134]],
        [[1442, 856, 234, 229], [1559, 971, 126, 134]],
      ],
      [
        [[63, 1169, 225, 225], [176, 1264.5, 126, 134]],
        [[341, 1169, 226, 225], [454, 1264.5, 126, 134]],
        [[619, 1169, 226, 225], [732, 1264.5, 126, 134]],
        [[898, 1169, 226, 225], [1011, 1264.5, 126, 134]],
        [[1176, 1169, 226, 225], [1289, 1264.5, 126, 134]],
        [[1454, 1169, 226, 225], [1567, 1264.5, 126, 134]],
      ],
      [
        [[63, 1478, 225, 224], [176, 1573.5, 126, 134]],
        [[341, 1478, 226, 224], [454, 1573.5, 126, 134]],
        [[619, 1478, 226, 224], [732, 1573.5, 126, 134]],
        [[898, 1478, 226, 224], [1011, 1573.5, 126, 134]],
        [[1176, 1478, 226, 224], [1289, 1573.5, 126, 134]],
        [[1454, 1478, 226, 224], [1567, 1573.5, 126, 134]],
      ],
      [
        [[114, 1796, 260, 260], [244, 1925.5, 224, 230]],
        [[455, 1796, 260, 260], [585, 1925.5, 224, 230]],
        [[843, 1808, 229, 236], [968.5, 1934, 126, 134]],
        [[1132, 1808, 229, 236], [1257.5, 1934, 126, 134]],
        [[1420, 1808, 229, 236], [1545.5, 1934, 126, 134]],
      ],
      [
        [[103, 2104, 278, 281], [242, 2244.5, 192, 202]],
        [[445, 2104, 278, 281], [584, 2244.5, 192, 202]],
        [[846, 2138, 223, 213], [958.5, 2256, 126, 134]],
        [[1135, 2138, 223, 213], [1247.5, 2256, 126, 134]],
        [[1423, 2138, 223, 213], [1535.5, 2256, 126, 134]],
      ],
    ];
    // Match the per-row translations baked into the centered PNG. Keep photos
    // and artwork together without changing their sizes or internal spacing.
    const rowOffsets = [19, 19, 9, 2.5, 2.5, -7.5, -.5];
    const slots = [], placements = [];
    rows.forEach((entries, row) => entries.forEach(([box, photo], column) => {
      const [originalX, y, w, h] = photo, x = originalX + rowOffsets[row];
      slots.push({ x, y, w: w / .62, h: h / .62, type: 'rect', row, column, photoArea: { x, y, w, h } });
      placements.push({ x: box[0] + rowOffsets[row], y: box[1], w: box[2], h: box[3] });
    }));
    return { w: 1748, h: 2480, widthMm: 148, heightMm: 210, slots, placements, motifSlots: [] };
  }
  globalThis.HeartStarStrawberry = { name, source, build };
})();
