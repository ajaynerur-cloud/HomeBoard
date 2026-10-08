/*
 * Signing in never waits for a sleeping server.
 *   npm start & node scripts/login-test.js [baseUrl]
 *
 * The API is made to answer like a sleeping Render host (503 + HTML holding
 * page). Signing in with a password this phone has seen before, with the
 * fingerprint from the sign-in screen, and unlocking the lock screen must all
 * open the board at once — no waking screen — and the server session must
 * arrive afterwards, once the host is "awake".
 */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000';

const AUTO_NOT_NOW = `
  window.__wakingSeen = false;
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => {
      if (document.querySelector('#sheet-notify.open')) document.querySelector('#notify-later')?.click();
      if (document.querySelector('#waking.show')) window.__wakingSeen = true;
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
`;

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l} — ${d || ''}`); } };
const visible = async (p, sel) => p.locator(`${sel}:not(.hidden)`).count().then((n) => n === 1);

(async () => {
  const b = await chromium.launch(process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {});
  const ctx = await b.newContext({ viewport: { width: 430, height: 932 } });
  await ctx.addInitScript(AUTO_NOT_NOW);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.accept());

  // The switch for "Render is asleep".
  let asleep = false;
  let apiHitsWhileAsleep = 0;
  await ctx.route('**/api/**', (route) => {
    if (!asleep) return route.continue();
    apiHitsWhileAsleep++;
    return route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>SERVICE WAKING UP</h1>' });
  });

  const cdp = await ctx.newCDPSession(p);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });

  const s = Date.now();
  const email = `login.${s}@demo.com`;
  console.log('\nSign-in without waking the server\n');

  // First ever sign-up: needs the server, of course.
  await p.goto(BASE);
  await p.click('#tab-signup');
  await p.fill('[name=name]', 'Lena Login');
  await p.fill('#auth-form [name=email]', email);
  await p.fill('#auth-form [name=password]', 'homeboard123');
  await p.click('#auth-submit');
  await p.waitForSelector('#app-screen:not(.hidden)');
  await p.waitForSelector('#first-board');
  await p.click('#first-board');
  await p.fill('#new-board-form [name=name]', 'Flat');
  await p.click('#new-board-form button[type=submit]');
  await p.waitForTimeout(1200);
  await p.click('#fab');
  await p.fill('#task-form [name=title]', 'Water the plants');
  await p.click('#task-save');
  await p.click('#refresh-btn');
  await p.waitForTimeout(1500);

  // ── 1. password this phone knows, server asleep ──
  await p.click('#open-account');
  await p.click('#signout-btn');
  await p.waitForSelector('#auth-screen:not(.hidden)');
  asleep = true; apiHitsWhileAsleep = 0;
  await p.evaluate(() => { window.__wakingSeen = false; });
  await p.fill('#auth-form [name=email]', email);
  await p.fill('#auth-form [name=password]', 'homeboard123');
  let t0 = Date.now();
  await p.click('#auth-submit');
  await p.waitForSelector('#app-screen:not(.hidden)', { timeout: 4000 }).catch(() => {});
  let took = Date.now() - t0;
  check('a password this phone knows signs in with the server asleep', await visible(p, '#app-screen'));
  check('at once', took < 2500, `${took}ms`);
  check('without the waking screen', !(await p.evaluate(() => window.__wakingSeen)));
  await p.waitForTimeout(800);
  check('the board is there, fetched in the background', (await p.textContent('#view')).includes('Water the plants') || (await p.textContent('#view')).includes('Fetching'));

  asleep = false;   // Render wakes up
  await p.waitForTimeout(500);
  await p.click('#refresh-btn');
  await p.waitForTimeout(2500);
  check('once the server wakes, a session arrives behind the scenes', Boolean(await p.evaluate(() => localStorage.getItem('hb.token'))));
  check('and the board is fetched', (await p.textContent('#view')).includes('Water the plants'));

  // A wrong password is not let in locally.
  await p.click('#open-account');
  await p.click('#signout-btn');
  await p.waitForSelector('#auth-screen:not(.hidden)');
  await p.fill('#auth-form [name=email]', email);
  await p.fill('#auth-form [name=password]', 'wrongpass99');
  await p.click('#auth-submit');
  await p.waitForTimeout(1500);
  check('a wrong password is not accepted on the phone', await visible(p, '#auth-screen') && !(await visible(p, '#app-screen')));

  // ── 2. fingerprint from the sign-in screen, server asleep ──
  await p.fill('#auth-form [name=password]', 'homeboard123');
  await p.click('#auth-submit');
  await p.waitForSelector('#app-screen:not(.hidden)');
  await p.waitForTimeout(800);
  if (await visible(p, '#bio-banner')) await p.click('#bio-banner-on');
  await p.waitForTimeout(1500);
  check('fingerprint turned on', Boolean(await p.evaluate(() => JSON.parse(localStorage.getItem('hb.bio') || 'null')?.deviceId)));
  await p.click('#open-account');
  await p.click('#signout-btn');
  await p.waitForSelector('#auth-screen:not(.hidden)');

  asleep = true;
  await p.evaluate(() => { window.__wakingSeen = false; });
  t0 = Date.now();
  await p.click('#bio-signin-btn');
  await p.waitForSelector('#app-screen:not(.hidden)', { timeout: 4000 }).catch(() => {});
  took = Date.now() - t0;
  check('the fingerprint signs in with the server asleep', await visible(p, '#app-screen'));
  check('at once', took < 2500, `${took}ms`);
  check('without the waking screen', !(await p.evaluate(() => window.__wakingSeen)));
  check('and shows the board from the phone', (await p.textContent('#view')).includes('Water the plants'));

  asleep = false;
  await p.click('#refresh-btn');
  await p.waitForTimeout(2500);
  check('then the session arrives once the server is up', Boolean(await p.evaluate(() => localStorage.getItem('hb.token'))));

  // ── 3. lock screen on reopen, server asleep ──
  asleep = true;
  await p.reload();
  await p.evaluate(() => { window.__wakingSeen = false; });
  await p.waitForSelector('#app-screen:not(.hidden)', { timeout: 5000 }).catch(() => {});
  check('reopening the app unlocks with the server asleep', await visible(p, '#app-screen'));
  await p.waitForTimeout(1500);
  check('without the waking screen', !(await p.evaluate(() => window.__wakingSeen)));
  asleep = false;

  check('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
