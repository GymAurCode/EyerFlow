const { chromium,expect }=require('@playwright/test');
const { join }=require('node:path');
const { mkdirSync }=require('node:fs');
(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
  const page=browser.contexts()[0].pages().find(p=>p.url().includes(':5273'));
  if(!page)throw new Error('The development renderer was not found.');
  await page.waitForLoadState('domcontentloaded');
  if(await page.getByRole('button',{name:/^sign in$/i}).isVisible()){
    console.log('The updated development app is running; sign-in is required.');process.exit(0);
  }
  await page.getByRole('complementary',{name:'Main navigation'}).waitFor();
  const errors=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('pageerror',e=>errors.push(e.stack));
  mkdirSync('docs/planning',{recursive:true});
  const result=await page.evaluate(async()=>({mps:await window.api.invoke('mms.mps.plans.list',{}),mrp:await window.api.invoke('mms.mrp.runs.list',{})}));
  expect(result.mps.ok).toBe(true);expect(result.mrp.ok).toBe(true);
  await page.evaluate(()=>{location.hash='/mms/planning/mps';});
  await expect(page.getByRole('button',{name:'Create Production Schedule',exact:true})).toBeVisible();
  await page.screenshot({path:join(process.cwd(),'docs/planning/live-mps.png'),fullPage:true});
  await page.evaluate(()=>{location.hash='/mms/planning/mrp';});
  await expect(page.getByRole('button',{name:'Run MRP',exact:true}).first()).toBeVisible();
  await page.screenshot({path:join(process.cwd(),'docs/planning/live-mrp.png'),fullPage:true});
  expect(errors).toEqual([]);
  console.log('LIVE PASS: both planning pages and persisted-list RPCs load; no console errors; no business records were created or edited.');
  // Disconnect this read-only inspector while leaving the user's Electron app running.
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
