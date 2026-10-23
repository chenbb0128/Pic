(() => {
  'use strict';
  const validID = id => typeof id === 'string' && /^[0-9a-f]{32}$/i.test(id);
  function create({ upload, loadImage, isImage = v =>
    (typeof HTMLImageElement !== 'undefined' && v instanceof HTMLImageElement) ||
    (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) }) {
    const uploaded = new WeakMap();
    async function capture(input, kind) {
      // Clone synchronously before the first network await: editing during a save
      // must not produce a mixture of old and new layout parameters.
      const sources = [], indices = new Map();
      function clone(value) {
        if (value == null || typeof value !== 'object') return value;
        if (isImage(value)) {
          if (!indices.has(value)) { indices.set(value, sources.length); sources.push(value); }
          return { uploadIndex: indices.get(value) };
        }
        if (Array.isArray(value)) return value.map(clone);
        return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, clone(v)]));
      }
      const data = clone({ ...input, schemaVersion: 1, editor: 'heart-star',
        photos: kind === 'template' ? input.states.map(() => null) : input.photos });
      const refs = [];
      // Sequential uploads bound memory usage for full-resolution customer images.
      for (const image of sources) {
        let pending = uploaded.get(image);
        if (!pending) {
          pending = Promise.resolve().then(() => upload(image)); uploaded.set(image, pending);
          pending.catch(() => uploaded.delete(image));
        }
        const ref = await pending;
        if (!validID(ref?.fileId)) throw Error('图片保存返回了无效引用');
        refs.push({ fileId: ref.fileId });
      }
      function replace(value) {
        if (!value || typeof value !== 'object') return value;
        if (Object.hasOwn(value, 'uploadIndex')) return refs[value.uploadIndex];
        if (Array.isArray(value)) return value.map(replace);
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
      }
      return replace(data);
    }
    async function restore(snapshot) {
      if (snapshot?.schemaVersion !== 1 || snapshot.editor !== 'heart-star' || !snapshot.template ||
          !Array.isArray(snapshot.states) || snapshot.states.length !== snapshot.template.slots?.length ||
          snapshot.photos?.length !== snapshot.states.length) throw Error('不支持此排版格式，请勿覆盖原项目');
      const ids = new Set();
      function check(v, depth = 0) {
        if (depth > 32) throw Error('排版数据过深');
        if (!v || typeof v !== 'object') return;
        if (Object.hasOwn(v, 'fileId')) {
          if (!validID(v.fileId)) throw Error('无效的图片引用');
          ids.add(v.fileId);
        }
        for (const child of Object.values(v)) check(child, depth + 1);
      }
      check(snapshot);
      const images = new Map();
      for (const id of ids) images.set(id, await loadImage(id));
      function decode(v) {
        if (!v || typeof v !== 'object') return v;
        if (Object.hasOwn(v, 'fileId')) return images.get(v.fileId);
        if (Array.isArray(v)) return v.map(decode);
        return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, decode(child)]));
      }
      // Nothing in the editor is changed until every referenced image has loaded.
      return decode(snapshot);
    }
    return { capture, restore };
  }
  globalThis.HeartStarCloudSnapshot = { create };
})();
