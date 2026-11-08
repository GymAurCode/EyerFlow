const { _electron: electron, expect } = require('@playwright/test');
const { join } = require('node:path');
(async () => {
  const app = await electron.launch({ args: [process.cwd()],
    env: { ...process.env, NODE_ENV: 'development', LICENCE_DISABLED: '1' }, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.stack));
    await page.getByRole('complementary', { name: 'Main navigation' }).waitFor();
    await page.evaluate(() => { location.hash = '/mms'; });
    await expect(page.getByText('Total Manufacturing Orders', { exact: true })).toBeVisible();
    const result = await page.evaluate(() => window.api.invoke('mms.dashboard', {}));
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(process.cwd(), 'docs/mms-parity/dashboard-live.png'), fullPage:true });
    console.log('PASS: original development database dashboard loads in Electron; all eight KPIs available; no console errors.');
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
