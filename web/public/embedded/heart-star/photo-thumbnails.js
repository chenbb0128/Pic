(() => {
  'use strict';
  function create({ container, getBoard, isProcessed, canRestore, process, restore }) {
    let previous = [], previousToken, buttons = [];
    function update() {
      const board = getBoard(), entries = [], byImage = new Map();
      for (const id of board.ids) {
        const image = board.photoAt(id); if (!image) continue;
        if (!byImage.has(image)) {
          const item = { image, ids: [], processed: false };
          entries.push(item); byImage.set(image, item);
        }
        const item = byImage.get(image); item.ids.push(id);
        item.processed ||= isProcessed(image) || !!board.processedAt?.(id);
      }
      const unchanged = previousToken === board.token && previous.length === entries.length &&
        container.children.length === entries.length && entries.every((item, i) => {
          const old = previous[i];
          return old.image === item.image && old.processed === item.processed &&
            old.ids.length === item.ids.length && old.ids.every((id, j) => id === item.ids[j]);
        });
      if (unchanged) { buttons.forEach(({ button, unavailable }) => { button.disabled = !board.ready || unavailable; }); return; }
      container.replaceChildren(); buttons = []; previous = entries; previousToken = board.token;
      entries.forEach((item, index) => {
        const card = document.createElement('div'); card.className = 'photo-thumb-card';
        const surface = document.createElement('canvas'); surface.className = 'photo-thumb-image';
        surface.width = surface.height = 112;
        const w = item.image.naturalWidth || item.image.width, h = item.image.naturalHeight || item.image.height;
        if (w > 0 && h > 0) {
          const scale = Math.min(112 / w, 112 / h), width = w * scale, height = h * scale;
          surface.getContext('2d').drawImage(item.image, (112 - width) / 2, (112 - height) / 2, width, height);
        }
        surface.setAttribute('aria-label', `照片 ${index + 1}${item.processed ? '，已处理' : ''}`);
        card.append(surface);
        if (item.processed) {
          const badge = document.createElement('span'); badge.className = 'photo-thumb-badge';
          badge.textContent = '已处理'; card.append(badge);
        }
        const action = document.createElement('button'); action.type = 'button'; action.className = 'photo-thumb-action';
        const restorable = canRestore(item.image), unavailable = item.processed && !restorable;
        action.textContent = item.processed ? restorable ? '恢复原图' : '已处理' : '一键去底';
        action.disabled = !board.ready || unavailable;
        action.title = unavailable ? '重新加载的作品已保留去底结果，如需恢复请重新上传原图。' : '仅处理这张照片，不改变排版位置';
        action.setAttribute('aria-label', `照片 ${index + 1}：${action.textContent}，${item.ids.length} 处使用`);
        const token = board.token;
        action.addEventListener('click', () => {
          const current = getBoard();
          if (unavailable || !current.ready || current.token !== token || !item.ids.every(id => current.photoAt(id) === item.image)) return;
          // Capture all current uses of this exact photo, not the canvas selection.
          const ids = current.ids.filter(id => current.photoAt(id) === item.image);
          if (item.processed) restore(ids); else process(ids);
        });
        card.append(action); container.append(card); buttons.push({ button: action, unavailable });
      });
    }
    return { update };
  }
  globalThis.HeartStarPhotoThumbnails = { create };
})();
