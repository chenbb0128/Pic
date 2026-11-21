(() => {
  'use strict';
  const maxPixels = 40000000;
  function validateSize(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > maxPixels)
      throw Error('照片尺寸无效或超过 4000 万像素，请缩小照片后再补光。');
  }
  function validateStrength(strength) {
    if (!Number.isFinite(strength) || strength < 0 || strength > 200) throw Error('补光强度须在 0% 到 200% 之间。');
  }
  function curve(pixels, strength) {
    const histogram = new Float64Array(256), step = Math.max(1, Math.floor(pixels.length / 4 / 65536));
    let total = 0;
    for (let i = 0; i < pixels.length; i += step * 4) {
      const alpha = pixels[i + 3] / 255;
      if (alpha < .1) continue;
      const light = Math.round(.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]);
      // White portrait backdrops must not hide an underexposed subject.
      if (light < 5 || light >= 245) continue;
      histogram[light] += alpha; total += alpha;
    }
    let middle = 0, count = 0;
    while (middle < 255 && count + histogram[middle] < total * .6) count += histogram[middle++];
    const gamma = total ? Math.max(.45, Math.min(.95, Math.log(.6) / Math.log(Math.min(.99, Math.max(.02, middle / 255))))) : 1;
    const gains = new Float64Array(256); gains[0] = 1;
    for (let i = 1; i < 256; i++) {
      const y = i / 255;
      // Preserve the black point and dark hair while lifting skin midtones;
      // taper near white and retain RGB proportions without channel clipping.
      const blackProtection = y * y / (y * y + .0256);
      const shadowBoost = 1 + .5 * (1 - y);
      const lifted = y + (Math.pow(y, gamma) - y) * blackProtection * (1 - y) * shadowBoost * strength / 100;
      gains[i] = Math.max(1, lifted / y);
    }
    return gains;
  }
  function shade(pixels, gains, start = 0, end = pixels.length) {
    for (let i = start; i < end; i += 4) {
      if (!pixels[i + 3]) continue;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], max = Math.max(r, g, b);
      if (!max) continue;
      const light = Math.round(.2126 * r + .7152 * g + .0722 * b);
      const gain = Math.min(gains[light], 255 / max);
      pixels[i] = Math.round(r * gain); pixels[i + 1] = Math.round(g * gain); pixels[i + 2] = Math.round(b * gain);
    }
  }
  function adjust(image, strength = 100) {
    validateSize(image.width, image.height); validateStrength(strength);
    if (image.data?.length !== image.width * image.height * 4) throw Error('无法读取照片像素，原图已保留。');
    const data = new Uint8ClampedArray(image.data);
    if (strength) shade(data, curve(data, strength));
    return { width: image.width, height: image.height, data };
  }
  function create() {
    // Slots keep their current render alive; obsolete slider results can be
    // collected. Repeated uses of the same photo/strength share one canvas.
    const images = new WeakMap(), slots = new WeakMap();
    function cached(image, strength) { return images.get(image)?.get(strength)?.deref(); }
    function remember(image, strength, canvas) {
      if (!images.has(image)) images.set(image, new Map());
      images.get(image).set(strength, new WeakRef(canvas));
      return canvas;
    }
    function read(image) {
      const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
      validateSize(width, height);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw Error('浏览器无法处理照片，原图已保留。');
      context.drawImage(image, 0, 0, width, height);
      return { canvas, context, pixels: context.getImageData(0, 0, width, height) };
    }
    function source(image, strength = 0, slot) {
      if (!image || !strength) { if (slot) slots.delete(slot); return image; }
      validateStrength(strength);
      const previous = slot && slots.get(slot);
      if (previous?.image === image && previous.strength === strength) return previous.canvas;
      let result = cached(image, strength);
      if (!result) {
        const { canvas, context, pixels } = read(image);
        shade(pixels.data, curve(pixels.data, strength)); context.putImageData(pixels, 0, 0);
        result = remember(image, strength, canvas);
      }
      if (slot) slots.set(slot, { image, strength, canvas: result });
      return result;
    }
    async function prepare(image, strength, cancelled = () => false) {
      validateStrength(strength);
      if (!strength) return image;
      const existing = cached(image, strength); if (existing) return existing;
      const { canvas, context, pixels } = read(image), gains = curve(pixels.data, strength);
      try {
        for (let start = 0; start < pixels.data.length; start += 1048576) {
          if (cancelled()) throw Error('照片或选择已变化，补光已取消。');
          shade(pixels.data, gains, start, Math.min(start + 1048576, pixels.data.length));
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (cancelled()) throw Error('照片或选择已变化，补光已取消。');
        context.putImageData(pixels, 0, 0);
        return remember(image, strength, canvas);
      } catch (error) { canvas.width = canvas.height = 0; throw error; }
    }
    return { source, prepare };
  }
  globalThis.HeartStarPhotoLighting = { adjust, create };
})();
