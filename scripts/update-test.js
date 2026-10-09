/*
 * An app a version behind the server says so.
 *   npm start & node scripts/update-test.js [baseUrl]
 */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l} — ${d || ''}`); } };

async function run(b, { apk }) {
  const ctx = await b.newContext({ viewport: { width: 430, height: 932 }, serviceWorkers: 'block' });
  if (apk) await ctx.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: {} }; });
  // Pretend this copy of the page is one version older than the server's.
  await ctx.route(/\/(index\.html)?(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/(<meta name="hb-version" content=")(\d+)/, (m, a, v) => a + (Number(v) - 1));
    route.fulfill({ response: res, body });
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE);
  await p.click('#tab-signup');
  await p.fill('[name=name]', 'Old Copy');
  await p.fill('#auth-form [name=email]', `upd.${apk ? 'a' : 'w'}.${Date.now()}@demo.com`);
  await p.fill('#auth-form [name=password]', 'homeboard123');
  await p.click('#auth-submit');
  await p.waitForSelector('#app-screen:not(.hidden)');
  await p.waitForTimeout(2500);
  const shown = await p.locator('#update-banner:not(.hidden)').count() === 1;
  check(`${apk ? 'APK' : 'browser'}: an older copy shows "A newer HomeBoard is out"`, shown);
  const text = await p.textContent('#update-text');
  if (apk) check('APK: it says to install the new APK', /Build Android APK/.test(text), text);
  else check('browser: it offers Update', await p.locator('#update-btn:not(.hidden)').count() === 1, text);
  check('no page errors', !errs.length, errs.join(' | '));
  await ctx.close();
}

(async () => {
  const b = await chromium.launch(process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {});
  console.log('\nUpdate notice\n');
  await run(b, { apk: false });
  await run(b, { apk: true });
  // And the current copy says nothing.
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto(BASE);
  await p.click('#tab-signup');
  await p.fill('[name=name]', 'New Copy');
  await p.fill('#auth-form [name=email]', `upd.n.${Date.now()}@demo.com`);
  await p.fill('#auth-form [name=password]', 'homeboard123');
  await p.click('#auth-submit');
  await p.waitForSelector('#app-screen:not(.hidden)');
  await p.waitForTimeout(2500);
  check('an up-to-date copy shows no notice', await p.locator('#update-banner.hidden').count() === 1);
  await b.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
