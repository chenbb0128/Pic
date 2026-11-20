(() => {
  'use strict';
  function mount({ button, store, getBoard, report, changed }) {
    let working = false;
    function update() {
      const board = getBoard();
      button.disabled = working || !board.ready || !board.ids.some(id => board.photoAt(id));
      button.textContent = working ? '正在去底…' : '一键去底（所选照片）';
    }
    async function run(ids, restoring) {
      if (working) return;
      let session;
      try { session = store.begin(ids); }
      catch (error) { report(error.message || '照片尚未准备好。', true); return; }
      working = true; update(); changed();
      try {
        report(restoring ? '正在恢复原图…' : '正在自动识别纯色背景并去底…');
        // Let the busy state paint before processing full-resolution pixels.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (restoring) {
          store.restore(session); report('已恢复原图并取消已处理标记，排版位置保持不变。');
        } else {
          const count = await store.apply(session, (image, options, cancelled) =>
            globalThis.HeartStarSolidBackground.processImage(image, { ...options, requireColor: true }, cancelled),
            (current, total) => report(`正在去底 ${current} / ${total} 张照片…`));
          report(`已去除 ${count} 处照片的纯色背景，已标记为已处理。`);
        }
      } catch (error) { report(error.message || '去底失败，原图已保留。', true); }
      finally { store.cancel(session); working = false; update(); changed(); }
    }
    button.addEventListener('click', () => run());
    update();
    return { update, process: ids => run(ids), restore: ids => run(ids, true), busy: () => working };
  }
  globalThis.HeartStarSolidBackgroundQuick = { mount };
})();
