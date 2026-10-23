(() => {
  'use strict';
  function createClient(fetcher = (...args) => fetch(...args)) {
    async function request(path, options = {}) {
      let response, body;
      try {
        response = await fetcher('/api/v1' + path, { credentials: 'same-origin',
          signal: AbortSignal.timeout(120000), ...options });
        body = await response.json();
      } catch { throw Error('共享服务暂不可用，请确认后端已启动；本地编辑和导出不受影响'); }
      if (!response.ok) { const error = Error(body.message || '共享服务请求失败'); error.status = response.status; throw error; }
      if (!Object.hasOwn(body, 'data')) throw Error('共享服务返回了无效数据');
      return body.data;
    }
    function json(path, method, body) {
      return request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    function save(kind, current, name, snapshot, thumbnailId, resultId) {
      const path = '/' + kind + 's' + (current ? '/' + encodeURIComponent(current.id) : '');
      return json(path, current ? 'PUT' : 'POST', { name, version: current?.version || 0, snapshot, thumbnailId, resultId });
    }
    async function asset(id) {
      let response;
      try { response = await fetcher('/api/v1/assets/' + encodeURIComponent(id), { credentials: 'same-origin', signal: AbortSignal.timeout(120000) }); }
      catch { throw Error('结果图下载失败，请检查网络后重试'); }
      if (!response.ok) {
        const body = await response.json().catch(() => ({})), error = Error(body.message || '结果图暂时无法读取');
        error.status = response.status; throw error;
      }
      const blob = await response.blob();
      if (blob.type !== 'image/png') throw Error('结果图格式无效，请重新登录或稍后重试');
      return blob;
    }
    const list = (kind, offset, query = '') => request('/' + kind + 's?offset=' + offset + '&q=' + encodeURIComponent(query));
    return { request, json, save, list, asset };
  }

  function mount({ getSnapshot, applySnapshot, getPreview, getResult, canSave, pendingEdit = () => '', setBusy, report }) {
    const client = createClient();
    let busy = false, active = null, offset = 0, files = [], query = '', stateReady = false, stateTimer = 0;
    const state = HeartStarCloudState.create({ getSnapshot });
    const saveStatus = document.createElement('span'); saveStatus.className = 'cloud-save-state';
    saveStatus.setAttribute('role', 'status'); saveStatus.setAttribute('aria-live', 'polite');
    const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'btn cloud-entry';
    entry.textContent = '共享模板／作品'; entry.setAttribute('aria-haspopup', 'dialog'); document.querySelector('.preview-tools').append(saveStatus, entry);
    function updateSaveState() {
      if (!stateReady && !canSave()) { saveStatus.textContent = '正在准备排版…'; return { dirty: false, saving: false }; }
      stateReady = true;
      const result = state.check(); result.dirty ||= !!pendingEdit();
      saveStatus.classList.toggle('dirty', result.dirty);
      saveStatus.textContent = result.saving ? '正在保存…' : result.dirty ? '有未保存修改' : result.savedAt ?
        '已保存 · ' + new Date(result.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '尚未保存到共享空间';
      saveStatus.title = result.savedAt ? '上次保存：' + new Date(result.savedAt).toLocaleString() : '本地编辑不会自动上传，请主动保存';
      return result;
    }
    function changed() { if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = 0; updateSaveState(); }, 250); }
    const shouldWarn = () => { const result = updateSaveState(); return busy || result.dirty || result.saving; };
    globalThis.picHeartStar = { hasUnsavedChanges: shouldWarn };
    if (window.parent === window) window.addEventListener('beforeunload', event => {
      if (shouldWarn()) { event.preventDefault(); event.returnValue = ''; }
    });
    document.querySelector('.app').addEventListener('input', changed);
    document.querySelector('.app').addEventListener('change', changed);
    changed();
    const dialog = document.createElement('dialog'); dialog.className = 'cloud-dialog'; dialog.setAttribute('aria-labelledby', 'cloudTitle');
    dialog.innerHTML = `<div class="cloud-head"><h2 id="cloudTitle">门店共享空间</h2><button type="button" class="btn" data-close aria-label="关闭共享空间">×</button></div>
      <p class="cloud-note">门店成员共享查看、编辑。作品保存原图、模板、可编辑排版及当前 DPI 高清结果 PNG；模板仅保留图案、背景和位置，不带客户照片。</p>
      <p class="cloud-status" role="status" aria-live="polite"></p>
      <form class="cloud-login" hidden><label>门店账号<input name="username" required autocomplete="username" value="staff"></label><label>密码<input name="password" type="password" required autocomplete="current-password"></label><button class="btn primary" type="submit">登录共享空间</button><p class="cloud-note">登录记住 30 天；密码更改后需重新登录。此账号与工具访问密码独立。</p></form>
      <section class="cloud-content" hidden><p class="cloud-current"></p><label class="cloud-name">名称<input maxlength="100" placeholder="例如：客户名／订单号／模板名"></label>
      <div class="cloud-actions"><button type="button" class="btn primary" data-save>保存作品</button><button type="button" class="btn" data-copy>另存作品</button><button type="button" class="btn" data-template>存为模板</button></div>
      <p class="cloud-note">作品结果图不含预览水印和选框，保留编号。保存需上传原图并生成高清图片，请等候完成。若提示版本冲突，可“另存作品”保留当前编辑。</p>
      <div class="cloud-list-head"><select aria-label="共享内容类型"><option value="project">共享作品</option><option value="template">共享模板库</option></select><button type="button" class="btn" data-refresh>刷新</button><button type="button" class="btn" data-logout>退出登录</button></div>
      <form class="cloud-search" role="search"><input type="search" maxlength="200" aria-label="搜索共享排版名称或编号" placeholder="搜索名称／订单号／排版编号"><button type="submit" class="btn">搜索</button><button type="button" class="btn" data-clear-search>清空</button></form>
      <div class="cloud-list"></div><div class="cloud-pagination"><button type="button" class="btn" data-prev>上一页</button><span></span><button type="button" class="btn" data-next>下一页</button></div></section>`;
    document.body.append(dialog);
    const el = selector => dialog.querySelector(selector), login = el('form'), content = el('.cloud-content'), name = el('.cloud-name input'), select = el('select'), list = el('.cloud-list');
    const status = (message, error = false) => { el('.cloud-status').textContent = message; el('.cloud-status').classList.toggle('error', error); };
    const current = () => {
      el('.cloud-current').textContent = active ? `当前：${active.name} · ${active.kind === 'template' ? '模板' : '作品'} · v${active.version}` : '当前尚未保存到共享空间';
      el('[data-save]').textContent = active?.kind === 'template' ? '保存当前模板' : '保存作品';
    };
    async function perform(action) {
      if (busy) return;
      busy = true; setBusy(true); dialog.querySelectorAll('button,input,select').forEach(e => e.disabled = true);
      status('正在处理，请稍候…');
      try { await action(); }
      catch (error) { status(error.message || '操作失败，当前编辑已保留', true); if (error.status === 401) { login.hidden = false; content.hidden = true; } }
      finally {
        busy = false; setBusy(false); dialog.querySelectorAll('button,input,select').forEach(e => e.disabled = false); updateSaveState();
        el('[data-prev]').disabled = offset === 0; el('[data-next]').disabled = files.length < 50;
      }
    }
    async function refresh() {
      files = await client.list(select.value, offset, query); list.replaceChildren();
      if (!files.length) { const empty = document.createElement('p'); empty.textContent = query ? '没有匹配的名称或编号，试试其他关键词。' : '暂无保存内容'; list.append(empty); }
      for (const file of files) {
        const row = document.createElement('div'); row.className = 'cloud-file';
        const thumb = document.createElement('div'); thumb.className = 'cloud-thumb';
        if (/^[0-9a-f]{32}$/i.test(file.thumbnailId || '')) {
          const image = document.createElement('img'); image.loading = 'lazy'; image.alt = file.name + '排版缩略图';
          image.src = '/api/v1/assets/' + file.thumbnailId;
          image.addEventListener('error', () => { thumb.replaceChildren(); thumb.textContent = '预览暂不可用'; }, { once: true });
          thumb.append(image);
        } else thumb.textContent = '暂无预览';
        const label = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('small');
        title.textContent = file.name; detail.textContent = `${file.number ? '编号 ' + file.number + ' · ' : ''}v${file.version} · ${new Date(file.updatedAt).toLocaleString()}`; label.append(title, detail);
        if (file.kind === 'project' && !file.resultId) {
          const missing = document.createElement('small'); missing.textContent = '旧作品：继续编辑并保存后生成高清结果'; label.append(missing);
        }
        const actions = document.createElement('div'); actions.className = 'cloud-file-actions';
        const open = document.createElement('button'); open.type = 'button'; open.className = 'btn'; open.textContent = file.kind === 'project' ? '继续编辑' : '使用模板';
        open.addEventListener('click', () => {
          if (!confirm('打开将替换当前编辑内容。未保存的内容不会保留，确定打开？')) return;
          perform(async () => {
            const doc = await client.request('/' + file.kind + 's/' + file.id);
            const restored = await codec.restore(doc.snapshot);
            applySnapshot(restored); stateReady = true; state.reset(doc.updatedAt); active = { id: doc.id, version: doc.version, name: doc.name, kind: doc.kind };
            name.value = doc.name; current(); status('已恢复全部图片和排版，不会重新自动排版'); report('已打开：' + doc.name); dialog.close();
          });
        });
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn'; remove.textContent = '删除';
        remove.addEventListener('click', () => { if (confirm(`所有成员都将不再看到“${file.name}”，确定删除？`)) perform(async () => {
          await client.json('/' + file.kind + 's/' + file.id, 'DELETE', { version: file.version });
          if (active?.id === file.id) { active = null; state.forgotten(); current(); } await refresh(); status('已移入服务端软删除记录；不会删除其他项目引用的图片');
        }); });
        actions.append(open);
        if (file.kind === 'project' && /^[0-9a-f]{32}$/i.test(file.resultId || '')) {
          const result = document.createElement('button'); result.type = 'button'; result.className = 'btn'; result.textContent = '下载结果';
          result.addEventListener('click', () => perform(async () => {
            const blob = await client.asset(file.resultId), link = document.createElement('a');
            const safe = (file.number || file.name).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').slice(0, 80).replace(/[. ]+$/g, '') || '排版作品';
            link.href = URL.createObjectURL(blob); link.download = safe + '_结果.png'; link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000); status('已下载保存时的高清结果：' + file.name);
          }));
          actions.append(result);
        }
        actions.append(remove); row.append(thumb, label, actions); list.append(row);
      }
      el('.cloud-pagination span').textContent = `第 ${offset / 50 + 1} 页`;
    }
    async function imageBlob(image) {
      if (image.picSourceBlob && ['image/png', 'image/jpeg', 'image/gif'].includes(image.picSourceBlob.type)) return image.picSourceBlob;
      if (image instanceof HTMLCanvasElement) return new Promise((resolve, reject) => image.toBlob(blob => blob ? resolve(blob) : reject(Error('模板图像读取失败')), 'image/png'));
      const response = image.picSourceBlob ? null : await fetch(image.src, { credentials: 'same-origin' });
      if (response && !response.ok) throw Error('原始图片已失效，请重新上传后保存');
      const blob = image.picSourceBlob || await response.blob();
      if (['image/png', 'image/jpeg', 'image/gif'].includes(blob.type)) return blob;
      // Other browser-supported formats (e.g. WebP) are normalized locally.
      const surface = document.createElement('canvas'); surface.width = image.naturalWidth; surface.height = image.naturalHeight;
      surface.getContext('2d').drawImage(image, 0, 0); return imageBlob(surface);
    }
    const codec = HeartStarCloudSnapshot.create({
      upload: async image => {
        if (image.picFileId) return { fileId: image.picFileId };
        const form = new FormData(); form.append('file', await imageBlob(image), 'image.png');
        const file = await client.request('/assets', { method: 'POST', body: form }); return { fileId: file.id };
      },
      loadImage: id => new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => { image.picFileId = id; resolve(image); };
        image.onerror = () => reject(Error('图片载入失败，请重新登录或检查原文件是否完整；当前编辑已保留'));
        image.src = '/api/v1/assets/' + id;
      }),
    });
    function save(kind, copy) {
      const pending = pendingEdit();
      if (pending) { status(pending, true); return; }
      if (!canSave()) { status('请等待模板、照片、背景或字体载入完成，自定义排版请先点击生成', true); return; }
      if (!name.value.trim()) { status('请填写保存名称', true); name.focus(); return; }
      perform(async () => {
        const token = state.begin(kind); updateSaveState();
        let doc;
        try {
          const preview = getPreview(kind);
          // Both capture their inputs before the first await, so the editable
          // document and result always represent the same saved version.
          const [snapshot, result] = await Promise.all([codec.capture(getSnapshot(), kind), kind === 'project' ? getResult() : null]);
          const form = new FormData(); form.append('file', await imageBlob(preview), 'preview.png');
          const thumbnail = await client.request('/assets', { method: 'POST', body: form });
          let resultId;
          if (result) {
            const output = new FormData(); output.append('file', result, 'result.png');
            resultId = (await client.request('/assets', { method: 'POST', body: output })).id;
          }
          doc = await client.save(kind, !copy && active?.kind === kind ? active : null, name.value.trim(), snapshot, thumbnail.id, resultId);
          state.saved(token, doc.updatedAt);
        } catch (error) { state.failed(); throw error; }
        active = { id: doc.id, version: doc.version, name: doc.name, kind: doc.kind }; current(); select.value = kind; offset = 0;
        status(kind === 'template' && state.check().dirty ? '保存成功：模板不含客户照片，照片仍未保存；请另存作品。' : '保存成功'); report('已保存到门店共享空间：' + doc.name);
        // A listing failure after saving must not misreport a successful save as failed.
        try { await refresh(); } catch { status('保存成功，列表刷新失败，可稍后手动刷新'); }
      });
    }
    entry.addEventListener('click', () => {
      dialog.showModal(); current(); perform(async () => { await client.request('/session'); login.hidden = true; content.hidden = false; await refresh(); status('已连接门店共享空间'); });
    });
    login.addEventListener('submit', event => { event.preventDefault(); perform(async () => {
      await client.json('/session', 'POST', { username: login.elements.username.value, password: login.elements.password.value });
      login.elements.password.value = ''; login.hidden = true; content.hidden = false; offset = 0; await refresh(); status('登录成功');
    }); });
    el('[data-save]').addEventListener('click', () => save(active?.kind || 'project', false));
    el('[data-copy]').addEventListener('click', () => save('project', true));
    el('[data-template]').addEventListener('click', () => save('template', true));
    el('[data-refresh]').addEventListener('click', () => perform(async () => { await refresh(); status('列表已刷新'); }));
    el('.cloud-search').addEventListener('submit', event => {
      event.preventDefault(); if (busy) return;
      query = el('.cloud-search input').value.trim(); offset = 0;
      perform(async () => { await refresh(); status(query ? '已按名称和编号搜索' : '已显示全部内容'); });
    });
    el('[data-clear-search]').addEventListener('click', () => {
      if (busy) return; query = ''; offset = 0; el('.cloud-search input').value = '';
      perform(async () => { await refresh(); status('已显示全部内容'); });
    });
    select.addEventListener('change', () => { offset = 0; perform(async () => { await refresh(); status(''); }); });
    for (const [attr, delta] of [['prev', -50], ['next', 50]]) el(`[data-${attr}]`).addEventListener('click', () => perform(async () => { offset = Math.max(0, offset + delta); await refresh(); status(''); }));
    el('[data-logout]').addEventListener('click', () => perform(async () => { await client.json('/session', 'DELETE'); login.hidden = false; content.hidden = true; files = []; list.replaceChildren(); status('已退出共享空间，本地编辑仍然保留'); }));
    el('[data-close]').addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    return { client, changed, hasUnsavedChanges: shouldWarn };
  }
  globalThis.HeartStarCloud = { createClient, mount };
})();
