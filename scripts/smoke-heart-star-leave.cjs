// Uses the existing local browser/runtime; does not save or upload any files.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PIC_PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PIC_BROWSER_PATH ? { executablePath: process.env.PIC_BROWSER_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5173/tools/heart-star');
    await page.locator('#heart-star-password').fill('87654321');
    await page.getByRole('button', { name: '解锁使用', exact: true }).click();
    const handle = await page.waitForSelector('iframe'); const frame = await handle.contentFrame();
    await frame.waitForFunction(() => selectionBoard().ready && document.querySelector('.cloud-save-state').textContent.includes('尚未保存'));
    await frame.locator('#clearSelection').click();
    assert.equal(await frame.evaluate(() => picHeartStar.hasUnsavedChanges()), false, '仅清空选择不应提醒');
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);
    await frame.locator('#selectAll').click();
    await frame.evaluate(() => { states[0].dx = 10; draw(); });
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true, '父页面刷新应触发提醒');
    let prompts = 0;
    page.once('dialog', dialog => { prompts++; return dialog.dismiss(); });
    await page.locator('a[href="/workspace"]').first().click();
    await page.waitForTimeout(100);
    assert.ok(page.url().endsWith('/tools/heart-star'), '取消离开后应留在工具页');
    assert.equal(await frame.evaluate(() => states[0].dx), 10, '取消离开不能重建或丢弃排版');
    page.once('dialog', dialog => { prompts++; return dialog.accept(); });
    await page.locator('a[href="/workspace"]').first().click();
    await page.waitForURL('**/workspace');
    assert.equal(prompts, 2); assert.deepEqual(errors, []);
    console.log('PASS: 仅选择不提醒、父页面刷新保护、站内离开取消保留排版、确认后正常离开');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
