(() => {
  'use strict';
  function create({ getSnapshot, isImage = value => value instanceof HTMLImageElement || value instanceof HTMLCanvasElement }) {
    const imageIDs = new WeakMap(); let nextImage = 0, baseline = null, savedAt = null, saving = false;
    function fingerprint(kind) {
      const snapshot = getSnapshot();
      function stable(value, path = '') {
        if (!value || typeof value !== 'object') return value;
        if (isImage(value)) {
          if (!imageIDs.has(value)) imageIDs.set(value, ++nextImage);
          return { image: imageIDs.get(value) };
        }
        if (Array.isArray(value)) return value.map(item => stable(item, path + '[]'));
        return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined &&
          !(path === 'settings' && key === 'selected') &&
          !(path === 'copy' && ['selected', 'selectedSlot', 'multiMode'].includes(key)))
          .map(key => [key, stable(value[key], path ? path + '.' + key : key)]));
      }
      return JSON.stringify(stable(kind === 'template' ? { ...snapshot, photos: snapshot.photos.map(() => null) } : snapshot));
    }
    function check() {
      const current = fingerprint();
      if (baseline === null) baseline = current;
      return { dirty: current !== baseline, saving, savedAt };
    }
    return { check,
      reset(at = null) { baseline = fingerprint(); savedAt = at; saving = false; return check(); },
      begin(kind) { saving = true; return fingerprint(kind); },
      saved(token, at) { baseline = token; savedAt = at; saving = false; return check(); },
      failed() { saving = false; return check(); },
      forgotten() { baseline = ''; savedAt = null; return check(); },
    };
  }
  globalThis.HeartStarCloudState = { create };
})();
