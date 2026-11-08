const { _electron: electron, expect } = require('@playwright/test');
const { join } = require('node:path');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const dir = join(process.cwd(), '.tmp/mms-existing-2');
const out = join(process.cwd(), 'docs/mms-parity');
mkdirSync(out, { recursive: true });
(async () => {
  const app = await electron.launch({ args: [process.cwd(), `--eyerstock-e2e=${dir}`],
    env: { ...process.env, NODE_ENV: 'development', EYERSTOCK_DATA_DIR: dir, LICENCE_DISABLED: '1' } });
  const errors = [];
  const main = [];
  app.process().stderr.on('data', data => main.push(String(data)));
  try {
    const page = await app.firstWindow();
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => { throw e; });
    await page.getByRole('complementary', { name: 'Main navigation' }).waitFor();
    const goto = async path => { await page.evaluate(p => { location.hash = p; }, path); await page.waitForTimeout(700); };
    await goto('/mms');
    await expect(page.getByText('Total Manufacturing Orders', { exact: true })).toBeVisible();
    await expect(page.getByText('Production Cost', { exact: true })).toBeVisible();
    await expect(page.getByText('Daily Output', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(out, 'dashboard-after-light.png'), fullPage: true });
    await page.getByText('Daily Output', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, 'dashboard-charts-light.png'), fullPage: true });
    await page.getByText('Recent Activity', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, 'dashboard-operations-light.png'), fullPage: true });
    await page.getByRole('button', { name: 'Refresh', exact: true }).scrollIntoViewIfNeeded();
    // Break a required SQL relation in this copied database only, through SQLite.
    const rename = async broken => app.evaluate(async ({ app }, broken) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const dir = app.getPath('userData');
      const { key } = require(app.getAppPath() + '/dist/data/encrypted-connection').resolveEncryptionKey(dir);
      const db = require(app.getAppPath() + '/dist/data/connection').openForInspection(dir + '/eyerstock.db', key, false);
      db.exec(broken ? 'ALTER TABLE manufacturing_cost_records RENAME TO controlled_cost_records'
        : 'ALTER TABLE controlled_cost_records RENAME TO manufacturing_cost_records');
      db.close();
    }, broken);
    await rename(true);
    try {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByText('The dashboard could not load', { exact: true })).toBeVisible({ timeout: 25000 });
      const text = await page.locator('main').innerText();
      expect(text).toContain('Reference:');
      const requestId = text.match(/Reference: ([a-f0-9-]+)/)[1];
      await page.screenshot({ path: join(out, 'controlled-error.png'), fullPage: true });
      const log = readFileSync(join(dir, 'logs/main.log'), 'utf8');
      expect(log).toContain(requestId);
      expect(log).toContain('no such table: manufacturing_cost_records');
      expect(errors.join('\n')).toContain(requestId);
      writeFileSync(join(out, 'controlled-error-evidence.json'), JSON.stringify({ requestId,
        renderer: errors, main: log.split('\n').filter(line => line.includes(requestId)) }, null, 2));
    } finally { await rename(false); }
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('Total Manufacturing Orders', { exact: true })).toBeVisible();
    errors.length = 0;
    const theme = async value => {
      await page.getByRole('button', { name: /Theme: .*Change theme/ }).click();
      await page.getByRole('menuitemradio', { name: value, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', value.toLowerCase());
      await page.waitForTimeout(300);
    };
    const screens = { 'ims-dashboard': '/ims', 'ims-products': '/ims/products',
      boms:'/mms/boms', recipes:'/mms/recipes', routes:'/mms/routes', mps:'/mms/planning/mps',
      mrp:'/mms/planning/mrp', orders:'/mms/production/orders', 'work-orders':'/mms/work-orders',
      materials:'/mms/materials', receipts:'/mms/finished-receipts', 'work-centers':'/mms/work-centers',
      equipment:'/mms/equipment', maintenance:'/mms/maintenance', wip:'/mms/wip', quality:'/mms/quality',
      scrap:'/mms/scrap', rework:'/mms/rework', subcontracting:'/mms/subcontracting', costing:'/mms/costing', reports:'/mms/reports' };
    for (const [name, path] of Object.entries(screens)) {
      await goto(path);
      if (name !== 'ims-dashboard') await expect(page.getByRole('textbox', { name: /search/i }).last()).toBeVisible();
      await page.screenshot({ path: join(out, `${name}-light.png`), fullPage:true });
      await theme('Dark');
      await page.screenshot({ path: join(out, `${name}-dark.png`), fullPage:true });
      await theme('Light');
      console.log('Verified table:', name);
    }
    await goto('/mms');
    await theme('Dark');
    await page.screenshot({ path: join(out, 'dashboard-after-dark.png'), fullPage:true });
    expect(errors).toEqual([]);
    console.log('PASS: dashboard, controlled SQL error, matching logs, Retry, all table routes and both themes');
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
