(() => {
  'use strict';
  // One shared zoom dialog shows any photo large on a checkerboard so
  // transparent cutout results can be inspected before downloading.
  let zoomDialog = null;
  function ensureZoomDialog() {
    if (zoomDialog) return zoomDialog;
    const dialog = document.createElement('dialog'); dialog.className = 'photo-zoom-dialog';
    const head = document.createElement('div'); head.className = 'photo-zoom-head';
    const title = document.createElement('span'); title.className = 'photo-zoom-title';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'photo-thumb-action';
    close.textContent = '✕ 关闭'; close.setAttribute('aria-label', '关闭大图');
    const body = document.createElement('div'); body.className = 'photo-zoom-body';
    const canvas = document.createElement('canvas');
    head.append(title, close); body.append(canvas); dialog.append(head, body);
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    (document.body || document.documentElement).append(dialog);
    zoomDialog = { dialog, title, canvas };
    return zoomDialog;
  }
  function openZoom(item, index) {
    const zoom = ensureZoomDialog();
    const width = item.image.naturalWidth || item.image.width || 0, height = item.image.naturalHeight || item.image.height || 0;
    const cap = width > 0 && height > 0 ? Math.min(1, 2048 / Math.max(width, height)) : 1;
    zoom.canvas.width = Math.max(1, Math.round((width || 1) * cap));
    zoom.canvas.height = Math.max(1, Math.round((height || 1) * cap));
    zoom.canvas.getContext('2d').drawImage(item.image, 0, 0, zoom.canvas.width, zoom.canvas.height);
    zoom.title.textContent = `照片 ${index + 1} · ${item.processed ? '已处理' : '原图'}${width > 0 ? ` · ${width} × ${height} px` : ''}`;
    if (zoom.dialog.open !== true) zoom.dialog.showModal();
  }
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
        const surface = document.createElement('canvas'); surface.className = 'photo-thumb-image photo-thumb-zoom';
        surface.width = surface.height = 112;
        const w = item.image.naturalWidth || item.image.width, h = item.image.naturalHeight || item.image.height;
        if (w > 0 && h > 0) {
          const scale = Math.min(112 / w, 112 / h), width = w * scale, height = h * scale;
          surface.getContext('2d').drawImage(item.image, (112 - width) / 2, (112 - height) / 2, width, height);
        }
        surface.setAttribute('aria-label', `照片 ${index + 1}${item.processed ? '，已处理' : ''}，点击查看大图`);
        surface.addEventListener('click', () => openZoom(item, index));
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
