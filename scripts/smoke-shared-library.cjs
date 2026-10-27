// Optional browser smoke test: uses an already installed Playwright, no download.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PIC_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const values = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
}));

(async () => {
  // Fix the renderer for exact pixel checks: Chromium's adaptive GPU/CPU canvas
  // paths can rasterize the same cached background differently after a reload.
  const browser = await chromium.launch({ headless: true, args: ['--disable-accelerated-2d-canvas', '--disable-gpu'], ...(process.env.PIC_BROWSER_PATH ? { executablePath: process.env.PIC_BROWSER_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage(), errors = [], created = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = values.PIC_ORIGIN || 'http://127.0.0.1:5173';
  try {
    assert.equal((await context.request.get(origin + '/api/v1/projects')).status(), 401);
    await page.goto(origin + '/tools/heart-star');
    await page.locator('#heart-star-password').fill(values.PIC_TOOL_PASSWORD);
    await page.getByRole('button', { name: '解锁使用' }).click();
    await page.locator('iframe').waitFor();
    assert.equal((await context.request.get(origin + '/api/v1/session')).status(), 200);
    await page.goto(origin + '/embedded/heart-star/index.html');
    await page.waitForFunction(() => typeof states !== 'undefined' && states.length && base.complete && base.naturalWidth);
    await page.waitForFunction(() => document.querySelector('.cloud-save-state')?.textContent.includes('尚未保存'));
    assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), false);
    if (process.env.PIC_SMOKE_TEMPLATE) {
      await page.locator('#template').selectOption(process.env.PIC_SMOKE_TEMPLATE);
      await page.waitForFunction(() => selectionBoard().ready && !fontBusy);
    }
    const textTemplate = await page.evaluate(() => !!templates[sel.value].text);
    await page.locator('.cloud-entry').click();
    await page.locator('.cloud-content').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.cloud-login').isVisible(), false);
    await page.waitForFunction(() => !document.querySelector('.cloud-dialog [data-close]').disabled);
    await page.locator('[data-close]').click();
    if (!textTemplate) {
      await page.locator('#files').setInputFiles(path.join(root, 'web/public/embedded/heart-star/assets/pink-stripe-heart.png'));
      await page.waitForFunction(() => !replacementBusy && slotPhoto(0)?.naturalWidth);
      const chooser = page.waitForEvent('filechooser');
      await page.evaluate(() => document.getElementById('slotBackgroundUpload').click());
      await (await chooser).setFiles(path.join(root, 'web/public/embedded/heart-star/assets/pink-stripe-heart.png'));
      await page.waitForFunction(() => !slotBackgrounds.busy() && states[0].background?.image?.naturalWidth, null, { timeout: 5000 }).catch(async error => {
        console.error(await page.evaluate(() => ({ busy: slotBackgrounds.busy(), background: states[0].background?.type, imageWidth: states[0].background?.image?.naturalWidth,
          selected: [...selectedSlots], buttonDisabled: document.getElementById('slotBackgroundUpload').disabled, status: document.getElementById('status').textContent })));
        throw error;
      });
    }
    await page.evaluate(text => {
      states[0].dx = 7; states[0].dy = -9; states[0].imageScale = 1.2;
      if (!text) Object.assign(states[0].background, { scale: 1.7, dx: 13, dy: -6 });
      footerText.value = 'SMOKE-编号'; numberingEnabled.checked = true; draw();
    }, textTemplate);
    const inspect = () => {
      const images = new WeakMap();
      const snapshot = getCloudSnapshot(); delete snapshot.template.name;
      return JSON.parse(JSON.stringify(snapshot, (_, value) => {
        if (!(value instanceof HTMLImageElement) && !(value instanceof HTMLCanvasElement)) return value;
        if (!images.has(value)) {
          const surface = document.createElement('canvas');
          surface.width = value.naturalWidth || value.width; surface.height = value.naturalHeight || value.height;
          const paint = surface.getContext('2d', { willReadFrequently: true }); paint.drawImage(value, 0, 0);
          let hash = 0;
          for (const n of paint.getImageData(0, 0, surface.width, surface.height).data) hash = (hash * 31 + n) | 0;
          images.set(value, [surface.width, surface.height, hash]);
        }
        return images.get(value);
      }));
    };
    const originalSnapshot = await page.evaluate(inspect);
    assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), true);
    const before = await page.evaluate(() => ({ width: canvas.width, height: canvas.height, pixels: canvas.toDataURL(), dx: states[0].dx, count: states.length }));
    await page.locator('.cloud-entry').click();
    await page.waitForFunction(() => !document.querySelector('.cloud-dialog [data-save]').disabled);
    const name = '本地功能验证-' + Date.now();
    await page.locator('.cloud-name input').fill(name);
    await page.locator('[data-copy]').click();
    await page.waitForFunction(() => document.querySelector('.cloud-status').textContent.includes('保存成功') || document.querySelector('.cloud-status.error'), null, { timeout: 120000 });
    assert.ok(!(await page.locator('.cloud-status').getAttribute('class')).includes('error'), await page.locator('.cloud-status').textContent());
    let docs = await context.request.get(origin + '/api/v1/projects').then(r => r.json());
    const project = docs.data.find(doc => doc.name === name); assert.ok(project); created.push(project);
    const saved = await context.request.get(origin + '/api/v1/projects/' + project.id).then(r => r.json());
    assert.equal(saved.data.snapshot.settings.footerText, 'SMOKE-编号');
    assert.ok(project.resultId, '作品必须保存独立高清结果图');
    assert.notEqual(project.resultId, project.thumbnailId, '结果图不能使用缩略图冒充');
    const resultResponse = await context.request.get(origin + '/api/v1/assets/' + project.resultId);
    assert.equal(resultResponse.status(), 200);
    const resultPNG = await resultResponse.body();
    const dimensions = await page.evaluate(() => ({ width: outputConfig().pxW, height: outputConfig().pxH, dpi: outputConfig().dpi }));
    assert.equal(resultPNG.readUInt32BE(16), dimensions.width);
    assert.equal(resultPNG.readUInt32BE(20), dimensions.height);
    let physical = null;
    for (let at = 8; at + 12 <= resultPNG.length; at += 12 + resultPNG.readUInt32BE(at)) {
      if (resultPNG.toString('ascii', at + 4, at + 8) === 'pHYs') physical = [resultPNG.readUInt32BE(at + 8), resultPNG.readUInt32BE(at + 12), resultPNG[at + 16]];
    }
    assert.deepEqual(physical, [Math.round(dimensions.dpi / .0254), Math.round(dimensions.dpi / .0254), 1], '结果 PNG 需保留打印 DPI');
    const matchesResult = await page.evaluate(async id => {
      const image = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = '/api/v1/assets/' + id; });
      const actual = document.createElement('canvas'); actual.width = image.naturalWidth; actual.height = image.naturalHeight;
      const paint = actual.getContext('2d', { willReadFrequently: true }); paint.drawImage(image, 0, 0);
      const pixels = paint.getImageData(0, 0, actual.width, actual.height).data;
      try {
        draw(false, true);
        const expected = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.length === expected.length && pixels.every((n, i) => n === expected[i]);
      } finally { draw(); }
    }, project.resultId);
    assert.ok(matchesResult, '高清结果应与正式无水印、无选框的画板一致');
    if (!textTemplate) assert.ok(saved.data.snapshot.photos[0].fileId);
    assert.ok(project.thumbnailId); assert.equal(project.number, 'SMOKE-编号');
    assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), false);
    await page.locator('.cloud-search input').fill(name);
    await page.locator('.cloud-search button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('.cloud-status').textContent.includes('已按名称'));
    assert.equal(await page.locator('.cloud-file').count(), 1);
    await page.locator('.cloud-thumb img').waitFor();
    await page.waitForFunction(() => document.querySelector('.cloud-thumb img')?.naturalWidth > 0);
    await page.locator('.cloud-search input').fill('SMOKE-编号');
    await page.locator('.cloud-search button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('[data-refresh]').disabled);
    assert.equal(await page.locator('.cloud-file').filter({ hasText: name }).count(), 1);
    await page.locator('.cloud-search input').fill('无匹配-' + name);
    await page.locator('.cloud-search button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('.cloud-list').textContent.includes('没有匹配'));
    await page.locator('[data-clear-search]').click();
    await page.waitForFunction(() => !document.querySelector('[data-refresh]').disabled);
    await page.locator('[data-template]').click();
    await page.waitForFunction(() => document.querySelector('.cloud-status').textContent.includes('保存成功') && !document.querySelector('[data-template]').disabled, null, { timeout: 120000 });
    docs = await context.request.get(origin + '/api/v1/templates').then(r => r.json());
    const template = docs.data.find(doc => doc.name === name); assert.ok(template); created.push(template);
    const tpl = await context.request.get(origin + '/api/v1/templates/' + template.id).then(r => r.json());
    assert.ok(tpl.data.snapshot.photos.every(photo => photo === null));
    assert.ok(!template.resultId, '无照片模板不能携带客户成品图');
    if (!textTemplate) assert.ok(tpl.data.snapshot.states[0].background.image.fileId);
    const thumbnailMatches = await page.evaluate(async id => {
      const image = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = '/api/v1/assets/' + id; });
      // Independently remove the real photo layer: this catches a broken
      // includePhotos flag instead of comparing the same renderer to itself.
      const previousPhotos = photos, previousReplacements = [...replacedPhotos]; let expected;
      try { photos = []; replacedPhotos.clear(); expected = getCloudPreview('project'); }
      finally { photos = previousPhotos; for (const [key, value] of previousReplacements) replacedPhotos.set(key, value); draw(); }
      const actual = document.createElement('canvas');
      actual.width = image.naturalWidth; actual.height = image.naturalHeight;
      actual.getContext('2d').drawImage(image, 0, 0);
      return actual.toDataURL() === expected.toDataURL() && actual.width <= 320 && actual.height <= 320;
    }, template.thumbnailId);
    assert.ok(thumbnailMatches, '模板缩略图必须与不渲染客户照片的预览一致');
    assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), !textTemplate);
    const anonymous = await browser.newContext();
    assert.equal((await anonymous.request.get(origin + '/api/v1/assets/' + template.thumbnailId)).status(), 401);
    assert.equal((await anonymous.request.get(origin + '/api/v1/assets/' + project.resultId)).status(), 401);
    await anonymous.close();
    await page.locator('[data-close]').click();
    await page.evaluate(() => { states[0].dx = 99; clearReplacedPhotos(); draw(); });
    page.once('dialog', d => d.accept());
    await page.reload();
    await page.waitForFunction(() => states.length && base.complete && base.naturalWidth);
    await page.locator('.cloud-entry').click();
    await page.locator('.cloud-content').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('[data-refresh]').disabled);
    page.once('dialog', d => d.accept());
    const projectRow = page.locator('.cloud-file').filter({ hasText: name });
    const downloading = page.waitForEvent('download');
    await projectRow.getByRole('button', { name: '下载结果', exact: true }).click();
    const downloaded = await downloading;
    assert.ok(downloaded.suggestedFilename().endsWith('.png'));
    assert.deepEqual(fs.readFileSync(await downloaded.path()), resultPNG, '直接下载的必须是已保存高清结果而非当前画板');
    await page.waitForFunction(() => !document.querySelector('[data-refresh]').disabled);
    await projectRow.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.cloud-dialog').open, null, { timeout: 120000 });
    await page.waitForFunction(() => selectionBoard().ready && !fontBusy, null, { timeout: 120000 });
    assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), false);
    const after = await page.evaluate(() => ({ width: canvas.width, height: canvas.height, pixels: canvas.toDataURL(), dx: states[0].dx, count: states.length, photo: !!slotPhoto(0)?.naturalWidth, bg: states[0].background?.scale }));
    assert.equal(after.dx, 7); assert.equal(after.count, before.count);
    if (!textTemplate) { assert.equal(after.photo, true); assert.equal(after.bg, 1.7); }
    assert.equal(after.width, before.width); assert.equal(after.height, before.height);
    assert.deepEqual(await page.evaluate(inspect), originalSnapshot, '恢复后全部排版参数和图片像素应保持一致');
    // Chromium can switch between canvas raster paths even in software mode.
    // Require exact data/source pixels above; tolerate only small edge-rounding
    // differences in the composed preview (<=12/255, <=2% of pixels).
    const visual = await page.evaluate(async ([a, b]) => {
      const images = await Promise.all([a, b].map(src => new Promise(resolve => {
        const image = new Image(); image.onload = () => resolve(image); image.src = src;
      })));
      const surface = document.createElement('canvas'); surface.width = images[0].width; surface.height = images[0].height;
      const paint = surface.getContext('2d', { willReadFrequently: true });
      const pixels = images.map(image => { paint.clearRect(0, 0, surface.width, surface.height); paint.drawImage(image, 0, 0); return paint.getImageData(0, 0, surface.width, surface.height).data; });
      let changed = 0, maximum = 0;
      for (let i = 0; i < pixels[0].length; i += 4) {
        let differs = false;
        for (let j = 0; j < 4; j++) { const delta = Math.abs(pixels[0][i + j] - pixels[1][i + j]); maximum = Math.max(maximum, delta); differs ||= delta > 0; }
        if (differs) changed++;
      }
      return { maximum, ratio: changed / (surface.width * surface.height) };
    }, [before.pixels, after.pixels]);
    assert.ok(visual.maximum <= 12 && visual.ratio <= .02, '恢复后预览差异超出边缘抗锯齿容差：' + JSON.stringify(visual));
    await page.evaluate(() => { states[0].dx = 19; draw(); });
    await page.locator('.cloud-entry').click();
    await page.waitForFunction(() => !document.querySelector('[data-save]').disabled);
    await page.locator('[data-save]').click();
    await page.waitForFunction(() => document.querySelector('.cloud-status').textContent.includes('保存成功') && !document.querySelector('[data-save]').disabled, null, { timeout: 120000 });
    const updated = await context.request.get(origin + '/api/v1/projects/' + project.id).then(r => r.json());
    assert.equal(updated.data.version, 2);
    assert.equal(updated.data.snapshot.states[0].dx, 19);
    assert.ok(updated.data.resultId && updated.data.resultId !== project.resultId, '继续编辑后保存要同步更新结果图');
    created[created.findIndex(doc => doc.id === project.id)] = updated.data;
    assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), false);
    await page.locator('[data-close]').click();
    if (!process.env.PIC_SMOKE_TEMPLATE || process.env.PIC_SMOKE_TEMPLATE === '模板爱心.png') {
      await page.evaluate(() => { states[0].dx = 24; draw(); });
      const rejectResult = route => {
        const request = route.request(), body = request.postDataBuffer();
        if (request.method() === 'POST' && body?.includes(Buffer.from('filename="result.png"'))) {
          return route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ code: 413, message: '验证：高清结果上传失败', data: null }) });
        }
        return route.continue();
      };
      await page.route('**/api/v1/assets', rejectResult);
      await page.locator('.cloud-entry').click();
      await page.waitForFunction(() => !document.querySelector('[data-save]').disabled);
      await page.locator('[data-save]').click();
      await page.waitForFunction(() => document.querySelector('.cloud-status.error')?.textContent.includes('上传失败') && !document.querySelector('[data-save]').disabled, null, { timeout: 120000 });
      assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), true, '结果上传失败仍然应提醒未保存');
      assert.equal(await page.evaluate(() => states[0].dx), 24, '上传失败不能丢失编辑');
      const unchanged = await context.request.get(origin + '/api/v1/projects/' + project.id).then(r => r.json());
      assert.equal(unchanged.data.version, 2);
      assert.equal(unchanged.data.resultId, updated.data.resultId);
      assert.equal(unchanged.data.snapshot.states[0].dx, 19);
      await page.unroute('**/api/v1/assets', rejectResult);
      await page.locator('[data-save]').click();
      await page.waitForFunction(() => document.querySelector('.cloud-status').textContent.includes('保存成功') && !document.querySelector('[data-save]').disabled, null, { timeout: 120000 });
      const retried = await context.request.get(origin + '/api/v1/projects/' + project.id).then(r => r.json());
      assert.equal(retried.data.version, 3); assert.equal(retried.data.snapshot.states[0].dx, 24);
      assert.ok(retried.data.resultId !== updated.data.resultId);
      created[created.findIndex(doc => doc.id === project.id)] = retried.data;
      assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), false);
      await page.locator('[data-close]').click();
    }
    if (textTemplate) {
      await page.locator('#copyText').fill('尚未应用的新文案');
      assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), true, '未应用的文案也必须提醒离开');
      await page.waitForFunction(() => document.querySelector('.cloud-save-state').textContent.includes('未保存'));
      await page.locator('.cloud-entry').click();
      await page.waitForFunction(() => !document.querySelector('[data-save]').disabled);
      let writes = 0;
      page.on('request', request => { if (['POST', 'PUT'].includes(request.method()) && request.url().includes('/api/v1/')) writes++; });
      await page.locator('[data-save]').click();
      await page.waitForFunction(() => document.querySelector('.cloud-status.error')?.textContent.includes('应用'));
      assert.equal(writes, 0, '未应用文案时不应保存旧文案或上传缩略图');
      assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), true);
      await page.locator('[data-close]').click();
      await page.locator('#applyCopy').click();
      assert.equal(await page.evaluate(() => states[[...selectedSlots][0]].text), '尚未应用的新文案');
      assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), true, '应用之后仍需主动保存');
    }
    await page.locator('.cloud-entry').click();
    await page.waitForFunction(() => !document.querySelector('[data-refresh]').disabled);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.cloud-file').filter({ hasText: name }).getByRole('button', { name: '删除', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.cloud-status').textContent.includes('已移入'));
    created.splice(created.findIndex(doc => doc.id === project.id), 1);
    assert.equal(await page.evaluate(() => picHeartStar.hasUnsavedChanges()), true, '删除当前共享文件后不能继续显示已安全保存');
    assert.deepEqual(errors, []);
    console.log('PASS: ' + (process.env.PIC_SMOKE_TEMPLATE || '默认爱心') + ' 原图模板恢复、高清结果像素/DPI/下载、继续编辑同步结果、模板照片隔离、鉴权、搜索及保存保护' + (textTemplate ? '、未应用文案保护' : ''));
  } finally {
    // Only soft-delete documents created by this smoke run. Assets are retained
    // under the MVP retention policy and are never physically deleted here.
    for (const doc of created) await context.request.delete(origin + '/api/v1/' + doc.kind + 's/' + doc.id, { headers: { Origin: origin }, data: { version: doc.version } });
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
