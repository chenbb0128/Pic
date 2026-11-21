// Browser-only verification with a generated portrait fixture; no backend uploads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PIC_PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PIC_BROWSER_PATH ? { executablePath: process.env.PIC_BROWSER_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [], uploads = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/**', route => {
      if (route.request().method() === 'POST') uploads.push(route.request().url());
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });
    await page.goto('http://127.0.0.1:5173/embedded/heart-star/index.html?template=' + encodeURIComponent('草莓.png'));
    await page.waitForFunction(() => selectionBoard().ready);
    assert.equal(await page.locator('[data-light-auto]').isDisabled(), true);
    const fixture = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 320;
      const p = c.getContext('2d');
      p.fillStyle = '#243448'; p.beginPath(); p.ellipse(128, 300, 92, 70, 0, 0, Math.PI * 2); p.fill();
      p.fillStyle = '#513c30'; p.fillRect(107, 204, 42, 45);
      p.fillStyle = '#17131a'; p.beginPath(); p.ellipse(128, 142, 83, 113, 0, 0, Math.PI * 2); p.fill();
      const skin = p.createRadialGradient(106, 122, 2, 130, 150, 90);
      skin.addColorStop(0, '#765644'); skin.addColorStop(1, '#503b32');
      p.fillStyle = skin; p.beginPath(); p.ellipse(128, 151, 65, 88, 0, 0, Math.PI * 2); p.fill();
      p.fillStyle = '#17131a'; p.beginPath(); p.moveTo(61, 135); p.bezierCurveTo(46, 20, 203, 10, 197, 133);
      p.bezierCurveTo(151, 114, 138, 81, 119, 76); p.bezierCurveTo(98, 105, 84, 121, 61, 135); p.fill();
      p.fillStyle = '#120f13'; for (const x of [102, 153]) { p.beginPath(); p.ellipse(x, 144, 5, 4, 0, 0, Math.PI * 2); p.fill(); }
      p.strokeStyle = '#82473f'; p.lineWidth = 4; p.beginPath(); p.moveTo(110, 185); p.quadraticCurveTo(128, 195, 146, 184); p.stroke();
      p.fillStyle = '#f2efed'; p.beginPath(); p.moveTo(95, 236); p.lineTo(128, 261); p.lineTo(161, 236); p.lineTo(140, 271); p.lineTo(116, 271); p.fill();
      return c.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#selectAll').click();
    await page.locator('#files').setInputFiles({ name: 'portrait-fixture.png', mimeType: 'image/png', buffer: Buffer.from(fixture, 'base64') });
    await page.waitForFunction(() => hasSlotPhotos() && !replacementBusy);
    await page.evaluate(() => {
      selectedSlots = new Set([0, 1]); selectedSlot = 0; multiMode = true;
      window.lightingOriginal = slotPhoto(0);
      window.lightingGeometry = JSON.stringify(templates[sel.value]);
      updateControls(); draw();
    });
    await page.locator('[data-light-auto]').click();
    await page.waitForFunction(() => !photoLightingEditor.busy() && states[0].photoLight === 100);
    const result = await page.evaluate(() => {
      const image = slotPhoto(0), lit = photoLighting.source(image, states[0].photoLight, states[0]);
      const original = document.createElement('canvas'); original.width = 256; original.height = 320;
      original.getContext('2d').drawImage(image, 0, 0);
      const a = original.getContext('2d').getImageData(0, 0, 256, 320).data;
      const b = lit.getContext('2d').getImageData(0, 0, 256, 320).data;
      const index = (160 * 256 + 128) * 4;
      window.lightingFirstResult = lit;
      return { originalPreserved: image === window.lightingOriginal, selected: states.slice(0, 3).map(st => st.photoLight || 0),
        geometryUnchanged: JSON.stringify(templates[sel.value]) === window.lightingGeometry,
        sharedRender: lit === photoLighting.source(slotPhoto(1), states[1].photoLight, states[1]),
        alphaPreserved: Array.from(a).every((v, i) => i % 4 !== 3 || v === b[i]),
        before: Array.from(a.slice(index, index + 4)), after: Array.from(b.slice(index, index + 4)) };
    });
    assert.equal(result.originalPreserved, true); assert.equal(result.geometryUnchanged, true);
    assert.deepEqual(result.selected, [100, 100, 0]);
    assert.equal(result.sharedRender, true); assert.equal(result.alphaPreserved, true);
    assert.ok(result.after[0] > result.before[0]);
    await page.locator('[data-light-auto]').click();
    await page.waitForFunction(() => !photoLightingEditor.busy());
    assert.equal(await page.evaluate(() => photoLighting.source(slotPhoto(0), states[0].photoLight, states[0]) === window.lightingFirstResult), true);
    const guarded = await page.evaluate(() => {
      const slider = document.querySelector('[data-light-strength]');
      slider.value = '120'; slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.value = '160'; slider.dispatchEvent(new Event('input', { bubbles: true }));
      return download.disabled && !selectionBoard().ready;
    });
    assert.equal(guarded, true);
    await page.waitForFunction(() => !photoLightingEditor.busy() && states[0].photoLight === 160);
    const snapshot = await page.evaluate(async () => {
      const saved = getCloudSnapshot(), images = new Map(); let index = 0;
      const codec = HeartStarCloudSnapshot.create({ upload: async image => {
        const fileId = (++index).toString(16).padStart(32, '0'); images.set(fileId, image); return { fileId };
      }, loadImage: async id => images.get(id) });
      const stored = await codec.capture(saved, 'project'), restored = await codec.restore(stored);
      const fresh = HeartStarPhotoLighting.create().source(restored.photos[0], restored.states[0].photoLight, restored.states[0]);
      const current = photoLighting.source(slotPhoto(0), states[0].photoLight, states[0]);
      const identical = fresh.toDataURL() === current.toDataURL();
      applyCloudSnapshot(restored);
      return { strength: states[0].photoLight, identical, rawPhotoSaved: slotPhoto(0) === window.lightingOriginal };
    });
    assert.deepEqual(snapshot, { strength: 160, identical: true, rawPhotoSaved: true });
    await page.locator('#watermarkEnabled').uncheck();
    await page.locator('#dpi').selectOption('300');
    await page.locator('#footerText').fill('portrait-light');
    const expected = await page.evaluate(() => {
      draw(false, true); const cfg = templates[sel.value], d = outputConfig(), p = cfg.slots[0];
      const x = Math.round(p.x / cfg.w * d.contentPxW), y = Math.round(p.y / cfg.h * d.contentPxH);
      const color = Array.from(ctx.getImageData(x, y, 1, 1).data); draw(); return { x, y, color };
    });
    const pending = page.waitForEvent('download'); await page.locator('#download').click();
    const file = await pending; assert.equal(await file.failure(), null);
    const bytes = fs.readFileSync(await file.path());
    const exported = await page.evaluate(async ({ encoded, expected }) => {
      const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode();
      const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
      const p = c.getContext('2d'); p.drawImage(image, 0, 0);
      return { pixels: [c.width, c.height], color: Array.from(p.getImageData(expected.x, expected.y, 1, 1).data) };
    }, { encoded: bytes.toString('base64'), expected });
    assert.deepEqual(exported.pixels, [1701, 2516]); assert.deepEqual(exported.color, expected.color);
    if (process.env.PIC_LIGHTING_PREVIEW_DIR) {
      const dir = process.env.PIC_LIGHTING_PREVIEW_DIR; fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'portrait-lighting-export.png'), bytes);
      const comparison = await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 410;
        const p = c.getContext('2d'); p.fillStyle = '#f6f1f3'; p.fillRect(0, 0, 640, 410);
        p.font = 'bold 20px sans-serif'; p.fillStyle = '#4d3542'; p.fillText('补光前', 30, 32); p.fillText('补光后 · 160%', 350, 32);
        p.drawImage(window.lightingOriginal, 30, 62, 256, 320);
        p.drawImage(photoLighting.source(slotPhoto(0), states[0].photoLight, states[0]), 350, 62, 256, 320);
        return c.toDataURL().split(',')[1];
      });
      fs.writeFileSync(path.join(dir, 'portrait-lighting-comparison.png'), Buffer.from(comparison, 'base64'));
      await page.locator('#photoFrameField').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(dir, 'portrait-lighting-editor.png') });
    }
    await page.locator('[data-light-reset]').click();
    await page.waitForFunction(() => !photoLightingEditor.busy() && states[0].photoLight === undefined);
    assert.equal(await page.evaluate(() => photoLighting.source(slotPhoto(0), 0, states[0]) === window.lightingOriginal), true);
    assert.deepEqual(uploads, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result, snapshot, exportPixels: exported.pixels, restoredOriginal: true, uploads, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
