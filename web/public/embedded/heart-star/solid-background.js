(() => {
  'use strict';
  const maxPixels = 16000000;
  const distance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  function validate(image) {
    const { width, height, data } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > maxPixels)
      throw Error('图片过大或尺寸无效，去底暂支持 1600 万像素以内的图片，请先缩小原图。');
    if (data?.length !== width * height * 4) throw Error('图片像素读取失败，原图已保留。');
  }
  function detect(image) {
    validate(image);
    const { width: w, height: h, data } = image, colors = [];
    for (const index of [0, w - 1, (h - 1) * w, w * h - 1]) {
      const p = index * 4;
      if (data[p + 3] > 200) colors.push([data[p], data[p + 1], data[p + 2]]);
    }
    if (!colors.length) return null;
    let best = [];
    for (const color of colors) {
      const group = colors.filter(other => distance(color, other) <= 24);
      if (group.length > best.length) best = group;
    }
    if (best.length < 2) return null;
    return [0, 1, 2].map(c => Math.round(best.reduce((sum, color) => sum + color[c], 0) / best.length));
  }
  async function remove(image, options = {}) {
    validate(image);
    const { width, height, data } = image, result = new Uint8ClampedArray(data);
    const color = options.color || detect(image), tolerance = Math.max(0, Math.min(120, Number(options.tolerance ?? 24))),
      feather = Math.max(0, Math.min(60, Number(options.feather ?? 12)));
    if (!Number.isFinite(tolerance) || !Number.isFinite(feather) || (color &&
        (color.length !== 3 || !color.every(c => Number.isFinite(c) && c >= 0 && c <= 255)))) throw Error('去底参数无效。');
    const check = () => { if (options.shouldCancel?.()) throw Error('处理已取消，原图已保留。'); };
    check();
    if (!color) return { width, height, data: result };
    const count = width * height, visited = new Uint8Array(count), queue = new Uint32Array(count);
    let head = 0, tail = 0;
    function visit(index) {
      if (visited[index]) return;
      visited[index] = 1;
      const p = index * 4;
      const d = Math.max(Math.abs(data[p] - color[0]), Math.abs(data[p + 1] - color[1]), Math.abs(data[p + 2] - color[2]));
      if (data[p + 3] && (feather ? d >= tolerance + feather : d > tolerance)) return;
      if (data[p + 3]) result[p + 3] = d <= tolerance ? 0 : Math.round(data[p + 3] * (d - tolerance) / feather);
      queue[tail++] = index;
    }
    for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
    for (let y = 1; y < height - 1; y++) { visit(y * width); visit(y * width + width - 1); }
    const yieldControl = options.yieldControl || (() => new Promise(resolve => setTimeout(resolve, 0)));
    while (head < tail) {
      const index = queue[head++], x = index % width;
      if (x > 0) visit(index - 1);
      if (x < width - 1) visit(index + 1);
      if (index >= width) visit(index - width);
      if (index < count - width) visit(index + width);
      if (head % 65536 === 0) { await yieldControl(); check(); }
    }
    check();
    return { width, height, data: result };
  }
  async function processImage(image, options, shouldCancel) {
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    if (width * height > maxPixels) throw Error('图片超过 1600 万像素，请先缩小原图后再去底。');
    const surface = document.createElement('canvas'); surface.width = width; surface.height = height;
    const paint = surface.getContext('2d', { willReadFrequently: true });
    paint.drawImage(image, 0, 0, width, height);
    const pixels = paint.getImageData(0, 0, width, height);
    if (options?.requireColor && !options.color && !detect(pixels))
      throw Error('未识别到一致的纯色背景（图片可能已透明），原图已保留。');
    const output = await remove(pixels, { ...options, shouldCancel });
    paint.putImageData(new ImageData(output.data, width, height), 0, 0);
    return surface;
  }
  function createStore({ getBoard, apply }) {
    const originals = new WeakMap();
    function begin(ids) {
      const board = getBoard();
      if (!board.ready) throw Error('请等待模板和图片准备完成后再处理。');
      const entries = [], byImage = new Map();
      for (const id of ids || board.ids) {
        const image = board.photoAt(id); if (!image) continue;
        if (!byImage.has(image)) {
          const saved = originals.get(image), entry = { image, original: saved?.original || image,
            options: { tolerance: 24, feather: 12, ...saved?.options }, ids: [] };
          entries.push(entry); byImage.set(image, entry);
        }
        byImage.get(image).ids.push(id);
      }
      if (!entries.length) throw Error('请先上传照片，并选中要去底的照片。');
      return { token: board.token, entries, cancelled: false };
    }
    function valid(session) {
      const board = getBoard();
      return !session.cancelled && board.ready && board.token === session.token &&
        session.entries.every(entry => entry.ids.every(id => board.photoAt(id) === entry.image));
    }
    function check(session) { if (!valid(session)) throw Error('照片或模板已变化，处理已取消，请重新选择。'); }
    async function commit(session, processor = processImage, progress = () => {}) {
      check(session);
      const items = [];
      for (let i = 0; i < session.entries.length; i++) {
        const entry = session.entries[i]; progress(i + 1, session.entries.length);
        const image = await processor(entry.original, entry.options, () => !valid(session));
        check(session);
        originals.set(image, { original: entry.original, options: { ...entry.options } });
        entry.ids.forEach(id => items.push({ id, image, processed: true }));
      }
      check(session); apply(items); session.cancelled = true;
      return items.length;
    }
    function restore(session) {
      check(session);
      apply(session.entries.flatMap(entry => entry.ids.map(id => ({ id, image: entry.original, processed: false }))));
      session.cancelled = true;
    }
    return { begin, apply: commit, restore, valid, isProcessed: image => originals.has(image),
      cancel: session => { if (session) session.cancelled = true; } };
  }
  globalThis.HeartStarSolidBackground = { detect, remove, processImage, createStore };
})();
