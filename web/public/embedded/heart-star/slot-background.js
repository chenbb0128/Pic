// Optional per-pattern layer. The existing template and photo layers stay unchanged.
(() => {
  function has(state) {
    const bg = state?.background;
    return !!bg && (bg.type === 'color' ? /^#[0-9a-f]{6}$/i.test(bg.color) :
      bg.type === 'image' && bg.image?.naturalWidth > 0 && bg.image?.naturalHeight > 0);
  }

  function apply(states, ids, patch) {
    for (const id of ids) {
      if (states[id]) states[id].background = { ...states[id].background, ...patch };
    }
  }

  function draw(ctx, state, x, y, w, h, path) {
    if (!has(state)) return;
    const bg = state.background;
    ctx.save();
    path();
    ctx.clip();
    if (bg.type === 'color') {
      ctx.fillStyle = bg.color;
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
    } else {
      const ratio = Math.max(w / bg.image.naturalWidth, h / bg.image.naturalHeight) * (bg.scale ?? 1);
      const dw = bg.image.naturalWidth * ratio, dh = bg.image.naturalHeight * ratio;
      ctx.drawImage(bg.image, x + (bg.dx || 0) - dw / 2, y + (bg.dy || 0) - dh / 2, dw, dh);
    }
    ctx.restore();
  }

  function create({ getStates, getSelection, getTemplate, redraw, report }) {
    const el = id => document.getElementById(id);
    const field = el('slotBackgroundField'), mode = el('slotBackgroundMode'), color = el('slotBackgroundColor');
    const upload = el('slotBackgroundUpload'), file = el('slotBackgroundFile'), clear = el('slotBackgroundClear');
    const scale = el('slotBackgroundScale'), dx = el('slotBackgroundX'), dy = el('slotBackgroundY');
    const note = el('slotBackgroundNote'), reset = el('slotBackgroundReset');
    let request = 0, pending = null;
    const ids = () => [...getSelection()].filter(id => getStates()[id]);
    const busy = () => pending?.states === getStates();

    function update() {
      const states = getStates(), selected = ids(), text = !!getTemplate().text;
      field.hidden = text;
      const disabled = text || !selected.length;
      [mode, color, clear].forEach(control => { control.disabled = disabled; });
      upload.disabled = disabled || busy();
      const values = selected.map(id => states[id].background || { type: 'none' });
      const first = values[0] || { type: 'none' };
      mode.value = values.every(bg => bg.type === first.type) ? first.type : 'mixed';
      el('slotBackgroundColorRow').hidden = mode.value !== 'color';
      el('slotBackgroundImageRow').hidden = mode.value !== 'image';
      color.value = first.color || '#fff0f5';
      const imageDisabled = disabled || mode.value !== 'image' || !values.some(bg => bg.image?.naturalWidth);
      [scale, dx, dy, reset].forEach(control => { control.disabled = imageDisabled; });
      for (const [control, key, fallback, factor] of [[scale, 'scale', 1, 100], [dx, 'dx', 0, 1], [dy, 'dy', 0, 1]]) {
        const value = (first[key] ?? fallback) * factor;
        const same = values.every(bg => (bg[key] ?? fallback) * factor === value);
        control.value = same ? String(value) : '';
        control.placeholder = same ? '' : '混合';
      }
      note.textContent = busy() ? '正在读取背景图片，完成后可导出…' :
        !selected.length ? '请先选择图案。' : mode.value === 'mixed' ? '所选图案背景不同，修改将批量应用。' :
        mode.value === 'image' ? (first.image?.naturalWidth ? '已设置背景图片；不透明照片会遮住下方背景。' : '请上传背景图片；不会替换原来的照片。') :
        mode.value === 'color' ? `纯色背景仅应用于所选 ${selected.length} 个图案。` : '未启用，保留原有效果。可多选后批量设置。';
    }

    function change(patch) {
      if (getTemplate().text) return;
      request++;
      pending = null;
      apply(getStates(), ids(), patch);
      update();
      redraw();
    }

    mode.addEventListener('change', () => {
      if (mode.value !== 'mixed') change({ type: mode.value, color: color.value });
    });
    color.addEventListener('input', () => change({ type: 'color', color: color.value }));
    clear.addEventListener('click', () => {
      if (getTemplate().text) return;
      request++;
      pending = null;
      for (const id of ids()) delete getStates()[id].background;
      file.value = '';
      update();
      redraw();
    });
    upload.addEventListener('click', () => { file.value = ''; file.click(); });
    file.addEventListener('change', () => {
      const picked = file.files?.[0], selected = ids();
      if (!picked || !selected.length || getTemplate().text) return;
      if (!picked.type.startsWith('image/')) { report('请选择有效的背景图片。', true); return; }
      const target = getStates(), token = ++request, image = new Image(), url = URL.createObjectURL(picked);
      pending = { states: target };
      update();
      redraw();
      const finish = success => {
        URL.revokeObjectURL(url);
        if (token !== request) return;
        pending = null;
        if (target !== getStates()) return;
        if (success) {
          apply(target, selected, { type: 'image', image, scale: 1, dx: 0, dy: 0 });
          report(`背景已应用于 ${selected.length} 个图案，原照片保持不变。`);
        } else report('背景图片读取失败，请重新选择。', true);
        update();
        redraw();
      };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
    });
    for (const [control, key, min, max, factor] of [[scale, 'scale', 25, 400, 100], [dx, 'dx', -10000, 10000, 1], [dy, 'dy', -10000, 10000, 1]]) {
      control.addEventListener('change', () => {
        const value = Number(control.value);
        if (!control.value.trim() || !Number.isFinite(value)) { update(); return; }
        change({ [key]: Math.max(min, Math.min(max, value)) / factor });
      });
    }
    reset.addEventListener('click', () => change({ scale: 1, dx: 0, dy: 0 }));
    return { update, busy, hasAny: () => getStates().some(has) };
  }

  globalThis.HeartStarBackground = { has, apply, draw, create };
})();
