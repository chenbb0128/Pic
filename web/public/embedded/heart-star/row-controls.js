(() => {
  'use strict';
  function mount({ field, assets, getBoard, pickAsset, replaceRow }) {
    const button = document.createElement('button'); button.type = 'button'; button.id = 'editMotifRow'; button.className = 'btn';
    button.textContent = '整排调整款式与数量'; button.style.cssText = 'width:100%;height:36px;font-size:12px';
    const note = document.createElement('p'); note.className = 'small'; note.style.lineHeight = '1.6';
    field.querySelector('details').before(button, note);
    const dialog = document.createElement('dialog'); dialog.className = 'custom-picker'; dialog.id = 'motifRowDialog';
    dialog.style.width = 'min(440px,calc(100% - 24px))'; dialog.setAttribute('aria-labelledby', 'motifRowTitle');
    dialog.innerHTML = '<div class="custom-picker-head"><strong id="motifRowTitle">整排调整</strong><button type="button" class="preview-tool" data-close aria-label="关闭整排调整">✕</button></div>' +
      '<p class="small" data-summary></p><button type="button" class="btn" data-pattern style="width:100%;height:auto;min-height:56px;display:flex;align-items:center;gap:10px;padding:8px;text-align:left"><img alt="" style="width:42px;height:42px;object-fit:contain"><span></span></button>' +
      '<label class="size-entry" style="margin-top:14px">整排数量 <input id="motifRowCount" type="number" min="1" max="12" step="1" aria-label="整排图案数量"> 个</label>' +
      '<p class="small" style="line-height:1.7">在原来这一排内等间距、居中排列，其他排不动。图案保持原比例和尺寸，放不下会提示。照片按原顺序循环带入，并重新适配新图案。</p>' +
      '<p class="status" data-status role="status" aria-live="polite"></p><button type="button" class="btn primary" data-apply style="width:100%">应用整排调整</button>';
    document.body.append(dialog);
    const el = query => dialog.querySelector(query), count = el('input'), status = el('[data-status]'), apply = el('[data-apply]');
    let target = null, assetId = null, working = false;
    const rowFor = board => {
      const rows = new Set(board.ids.map(id => board.catalog[id]?.row));
      return board.ids.length && rows.size === 1 && !rows.has(undefined) ? [...rows][0] : null;
    };
    const current = () => { const board = getBoard(); return board.ready && target && board.cfg === target.cfg && board.states === target.states &&
      board.source === target.source && board.width === target.width && board.height === target.height; };
    function update() {
      const board = getBoard(), row = rowFor(board); button.disabled = !board.ready || row === null || working;
      note.textContent = row === null ? '选中同一排中的任意图案，可调整整排款式和数量。' : `将调整第 ${row + 1} 排的全部图案；其他排保持不变。`;
    }
    function showPattern() {
      const asset = assets[assetId]; el('[data-pattern] img').src = asset?.src || ''; el('[data-pattern] span').textContent = asset ? `${asset.name}（点击换款）` : '点击选择整排图案';
    }
    button.addEventListener('click', () => {
      const board = getBoard(), row = rowFor(board); if (!board.ready || row === null) return;
      const entries = board.catalog.filter(meta => meta.row === row), first = entries[0];
      target = { ...board, ids: entries.map(meta => meta.index) };
      assetId = board.states[first.index]?.motif?.assetId || first.assetId ||
        Object.keys(assets).find(id => assets[id].baseName === first.name && assets[id].variant === first.variant) || null;
      count.value = String(entries.length); status.textContent = ''; status.classList.remove('error');
      el('[data-summary]').textContent = `第 ${row + 1} 排 · 当前 ${entries.length} 个图案`; showPattern(); dialog.showModal();
    });
    el('[data-pattern]').addEventListener('click', () => { if (!working) pickAsset(id => { assetId = id; showPattern(); }, el('[data-pattern]')); });
    apply.addEventListener('click', async () => {
      if (working) return;
      status.classList.add('error');
      if (!current()) { status.textContent = '排版或纸张尺寸已变化，请关闭后重新选择这一排。'; return; }
      if (!assets[assetId]) { status.textContent = '请先选择整排图案。'; return; }
      if (!count.checkValidity() || !count.value) { count.reportValidity(); return; }
      try { globalThis.HeartStarRowLayout.plan({ cfg: target.cfg, catalog: target.catalog, ids: target.ids, assetId, asset: assets[assetId],
        count: Number(count.value), widthMm: target.width, heightMm: target.height }); }
      catch (error) { status.textContent = error.message; return; }
      working = true; dialog.querySelectorAll('button,input').forEach(control => control.disabled = true); status.textContent = '正在调整整排…';
      try {
        const result = await replaceRow(target.ids, assetId, Number(count.value));
        if (result) dialog.close();
        else status.textContent = '未应用：请减少数量、选择尺寸更小的图案，或关闭后重新选择这一排。';
      } catch (error) {
        status.textContent = error.message || '整排调整失败，原排版已保留，请重试。';
      } finally { working = false; dialog.querySelectorAll('button,input').forEach(control => control.disabled = false); update(); }
    });
    el('[data-close]').addEventListener('click', () => { if (!working) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
    dialog.addEventListener('close', () => { target = null; button.focus(); });
    update(); return { update };
  }
  globalThis.HeartStarRowControls = { mount };
})();
