(() => {
  'use strict';
  function mount({ root, processor, getBoard, apply, changed, report }) {
    const button = root.querySelector('[data-light-auto]'), reset = root.querySelector('[data-light-reset]'),
      range = root.querySelector('[data-light-strength]'), output = root.querySelector('[data-light-value]'),
      status = root.querySelector('[data-light-status]');
    let working = false, request = 0, active = null;
    const targets = board => board.ids.filter(id => board.states[id] && board.photoAt(id));
    const level = state => state.photoLight || 0;
    function update() {
      const board = getBoard(), ids = targets(board), enabled = board.ready && ids.length > 0;
      button.disabled = !enabled || working; range.disabled = !enabled;
      reset.disabled = !enabled || (!working && !ids.some(id => level(board.states[id])));
      button.textContent = working ? '正在补光…' : '一键补光';
      root.setAttribute('aria-busy', String(working));
      const sameTarget = working && active?.token === board.token && active.ids.length === ids.length &&
        active.ids.every(id => ids.includes(id));
      if (!sameTarget) {
        const values = ids.map(id => level(board.states[id])), same = values.every(value => value === values[0]);
        range.value = String(values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0);
        output.value = !ids.length ? '—' : !same ? '混合' : values[0] ? `${values[0]}%` : '未补光';
      }
      range.style.setProperty('--range-progress', `${Number(range.value) / 2}%`);
    }
    async function run(value) {
      const strength = Math.max(0, Math.min(200, Math.round(Number(value) || 0))), board = getBoard(), token = board.token;
      if (!board.ready) return;
      const ids = targets(board); if (!ids.length) return;
      const ticket = ++request, entries = ids.map(id => ({ id, image: board.photoAt(id), strength: level(board.states[id]) }));
      active = { token, ids }; working = true;
      range.value = String(strength); output.value = strength ? `${strength}%` : '未补光';
      status.textContent = strength ? '正在为所选人像补光…' : '正在恢复原亮度…';
      update(); changed();
      function valid() {
        const now = getBoard();
        return ticket === request && now.ready && now.token === token &&
          entries.every(item => now.photoAt(item.id) === item.image && level(now.states[item.id]) === item.strength);
      }
      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        const photos = [...new Set(entries.map(item => item.image))], rendered = [];
        for (let i = 0; i < photos.length; i++) {
          if (!valid()) throw Error('照片或模板已变化，补光已取消。');
          status.textContent = strength ? `正在补光 ${i + 1} / ${photos.length} 张照片…` : '正在恢复原亮度…';
          rendered.push(await processor.prepare(photos[i], strength, () => !valid()));
        }
        if (!valid()) throw Error('照片或模板已变化，补光已取消。');
        // Keep prepared canvases alive until the renderer binds them to slots.
        apply(ids, strength, rendered);
        status.textContent = strength ? `已为 ${ids.length} 处人像补光，可继续调整强度。` : '已恢复所选人像的原亮度。';
        report(status.textContent);
      } catch (error) {
        if (ticket === request) { status.textContent = error.message || '补光失败，原图已保留。'; report(status.textContent, true); }
      } finally {
        if (ticket === request) { working = false; active = null; update(); changed(); }
      }
    }
    button.addEventListener('click', () => run(100));
    reset.addEventListener('click', () => run(0));
    range.addEventListener('input', () => run(range.value));
    update();
    return { update, busy: () => working, setStrength: run };
  }
  globalThis.HeartStarPhotoLightingControls = { mount };
})();
