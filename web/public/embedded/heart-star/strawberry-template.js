// Clean artwork and calibrated photo positions are kept separate so
// same-size artwork updates can reuse the saved coordinates.
(() => {
  'use strict';
  const name = '草莓.png';
  const source = './assets/strawberry-template.png?v=6';
  function build() {
    // Each entry: artwork [left, top, width, height], photo [cx, cy, width, height].
    // Centers use the filled artwork silhouette, rounded to half a pixel.
    // This keeps hearts above their pointed tips and excludes texture holes.
    // Sizes are the largest that keep the editor's dashed selection frame (6% larger
    // than the photo area, stroke included) on the painted motif;
    // heartStarStrawberry.test.ts checks both against the base image.
    const rows = [
      [
        [[65, 91, 326, 326], [228, 254, 205, 219.5]],
        [[457, 91, 326, 326], [620, 254, 205, 219.5]],
        [[872, 78, 333, 333], [1038.5, 244.5, 216, 232]],
        [[1312, 78, 333, 333], [1478.5, 244.5, 216, 232]],
      ],
      [
        [[71, 480, 344, 330], [242.5, 661.5, 109.5, 115.5]],
        [[480, 480, 344, 330], [651.5, 661.5, 109.5, 115.5]],
        [[888, 481, 344, 329], [1059.5, 662.5, 109.5, 115.5]],
        [[1295, 481, 344, 329], [1466.5, 662.5, 109.5, 115.5]],
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
        [[63, 1169, 225, 225], [176, 1264.5, 103.5, 110.5]],
        [[341, 1169, 226, 225], [454, 1264.5, 103.5, 110.5]],
        [[619, 1169, 226, 225], [732, 1264.5, 103.5, 110.5]],
        [[898, 1169, 226, 225], [1011, 1264.5, 103.5, 110.5]],
        [[1176, 1169, 226, 225], [1289, 1264.5, 103.5, 110.5]],
        [[1454, 1169, 226, 225], [1567, 1264.5, 103.5, 110.5]],
      ],
      [
        [[63, 1478, 225, 224], [176.5, 1571, 103.5, 110.5]],
        [[341, 1478, 226, 224], [454, 1573.5, 103.5, 110.5]],
        [[619, 1478, 226, 224], [732, 1573.5, 103.5, 110.5]],
        [[898, 1478, 226, 224], [1011, 1573.5, 103.5, 110.5]],
        [[1176, 1478, 226, 224], [1289, 1573.5, 103.5, 110.5]],
        [[1454, 1478, 226, 224], [1567, 1573.5, 103.5, 110.5]],
      ],
      [
        [[114, 1796, 260, 260], [244, 1925.5, 224, 230]],
        [[455, 1796, 260, 260], [585, 1925.5, 224, 230]],
        [[843, 1808, 229, 236], [968.5, 1934, 126, 134]],
        [[1132, 1808, 229, 236], [1257.5, 1934, 126, 134]],
        [[1420, 1808, 229, 236], [1545.5, 1934, 126, 134]],
      ],
      [
        [[103, 2104, 278, 281], [242, 2244.5, 175.5, 184.5]],
        [[445, 2104, 278, 281], [584, 2244.5, 175.5, 184.5]],
        [[846, 2138, 223, 213], [958.5, 2256, 112, 119.5]],
        [[1135, 2138, 223, 213], [1247.5, 2256, 112, 119.5]],
        [[1423, 2138, 223, 213], [1535.5, 2256, 112, 119.5]],
      ],
    ];
    // The PNG includes both the row centering and the following sheet transform.
    // Shrink the original 148 x 210 mm layout by 5% in physical units, then center
    // it on a 144 x 210 mm sheet. Use the matching 300 DPI canvas proportions so
    // dynamically uploaded photos also retain their proportions on export.
    const rowOffsets = [19, 19, 9, 2.5, 2.5, -7.5, -.5];
    const originalW = 1748, w = 1701, h = 2480, widthMm = 144, heightMm = 210;
    const scaleY = .95, scaleX = scaleY * 148 / widthMm * w / originalW;
    const moveX = x => w / 2 + (x - originalW / 2) * scaleX;
    const moveY = y => h / 2 + (y - h / 2) * scaleY;
    const slots = [], placements = [];
    rows.forEach((entries, row) => entries.forEach(([box, photo], column) => {
      const x = moveX(photo[0] + rowOffsets[row]), y = moveY(photo[1]);
      const photoW = photo[2] * scaleX, photoH = photo[3] * scaleY;
      slots.push({ x, y, w: photoW / .62, h: photoH / .62, type: 'rect', row, column,
        photoArea: { x, y, w: photoW, h: photoH } });
      placements.push({ x: moveX(box[0] + rowOffsets[row]), y: moveY(box[1]), w: box[2] * scaleX, h: box[3] * scaleY });
    }));
    return { w, h, widthMm, heightMm, slots, placements, motifSlots: [] };
  }
  globalThis.HeartStarStrawberry = { name, source, build };
})();
