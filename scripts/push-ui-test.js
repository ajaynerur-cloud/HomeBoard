#!/usr/bin/env node
/*
 * The browser half of new-task push, in real Chromium.
 *
 *   - permission is asked for on sign-in, with no switch to find first
 *   - once granted, the browser's subscription reaches the server
 *   - a push delivered to the service worker shows a notification with the
 *     page CLOSED, and tapping it opens the task
 *
 * Needs a running server:   npm start &   then   node scripts/push-ui-test.js
 * (npm i --no-save playwright; PLAYWRIGHT_CHROME=/path/to/chrome if needed)
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000';

let pass = 0, fail = 0;
const check = (l, c, d = '') => {
  if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l}${d ? ' — ' + d : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({}));
}

/*
 * Headless Chromium cannot reach Google's push service, so subscribe() is stood
 * in for with a well-formed subscription. Everything around it is real.
 */
const STUB_SUBSCRIBE = `
  (() => {
    // Like a real browser, the subscription outlives the page that made it.
    const fake = (key, endpoint) => ({
      endpoint: endpoint || 'https://push.example.test/send/' + Math.random().toString(36).slice(2),
      options: { applicationServerKey: key },
      toJSON() { return { endpoint: this.endpoint, keys: {
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
        auth: 'tBHItJI5svbpez7KI4CCXg' } }; },
      unsubscribe: async () => { localStorage.removeItem('stub.sub'); return true; },
    });
    if (self.PushManager) {
      PushManager.prototype.subscribe = async function (opts) {
        const sub = fake(opts.applicationServerKey);
        localStorage.setItem('stub.sub', JSON.stringify({ endpoint: sub.endpoint, key: [...new Uint8Array(opts.applicationServerKey)] }));
        return sub;
      };
      PushManager.prototype.getSubscription = async function () {
        const saved = JSON.parse(localStorage.getItem('stub.sub') || 'null');
        return saved ? fake(new Uint8Array(saved.key).buffer, saved.endpoint) : null;
      };
    }
    window.__askCount = 0;
    const real = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (...a) => { window.__askCount++; return real(...a); };
  })();
`;

(async () => {
  const b = await chromium.launch(process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {});
  const stamp = Date.now();

  // Bob exists and is on Alice's board.
  const alice = await api('/auth/signup', { method: 'POST', body: { name: 'Alice', email: `pa.${stamp}@example.com`, password: 'household123' } });
  const bob = await api('/auth/signup', { method: 'POST', body: { name: 'Bob', email: `pb.${stamp}@example.com`, password: 'household123' } });
  const { project } = await api('/projects', { method: 'POST', token: alice.token, body: { name: 'Home' } });
  await api('/projects/join', { method: 'POST', token: bob.token, body: { code: project.inviteCode } });

  console.log('\nNew-task push in the browser\n');

  const signIn = async (p) => {
    await p.goto(BASE);
    await p.fill('input[name=email]', `pb.${stamp}@example.com`);
    await p.fill('input[name=password]', 'household123');
    await p.click('#auth-submit');
    await p.waitForSelector('#app-screen:not(.hidden)', { timeout: 15000 });
  };
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
  const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  /* 1. Mobile browser tab, permission not decided: sign-in shows the ask, the tap asks. */
  {
    const ctx = await b.newContext({ userAgent: ANDROID_CHROME, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(STUB_SUBSCRIBE);
    const p = await ctx.newPage();
    await signIn(p);
    await p.waitForSelector('#sheet-notify.open', { timeout: 5000 }).catch(() => {});
    check('phone browser: signing in brings up "Turn on notifications"', await p.isVisible('#sheet-notify.open'));
    check('…and does not fire a prompt without a tap (Chrome would block it)', (await p.evaluate(() => window.__askCount)) === 0);
    await p.click('#notify-go');
    await sleep(500);
    check('tapping the button shows the browser\'s permission prompt', (await p.evaluate(() => window.__askCount)) === 1);
    await ctx.close();
  }

  /* 1b. Blocked on a phone: say exactly where to unblock it. */
  {
    const ctx = await b.newContext({ userAgent: ANDROID_CHROME, isMobile: true, hasTouch: true });
    await ctx.addInitScript(STUB_SUBSCRIBE + `Object.defineProperty(Notification, 'permission', { get: () => 'denied' });`);
    const p = await ctx.newPage();
    await signIn(p);
    await p.waitForSelector('#sheet-notify.open', { timeout: 5000 }).catch(() => {});
    const t = await p.textContent('#notify-text').catch(() => '');
    check('blocked in Chrome on Android: shows how to allow it', /Permissions → Notifications → Allow/.test(t), t);
    await ctx.close();
  }

  /* 1c. iPhone Safari tab: push needs the Home Screen app, so say that. */
  {
    const ctx = await b.newContext({ userAgent: IPHONE_SAFARI, isMobile: true, hasTouch: true });
    await ctx.addInitScript(STUB_SUBSCRIBE);
    const p = await ctx.newPage();
    await signIn(p);
    await p.waitForSelector('#sheet-notify.open', { timeout: 5000 }).catch(() => {});
    const t = await p.textContent('#notify-text').catch(() => '');
    check('iPhone Safari tab: explains Add to Home Screen', /Add to Home Screen/.test(t), t);
    await ctx.close();
  }

  /* 1d. Push unavailable, app open: still hears about a new task. */
  {
    const ctx = await b.newContext({ permissions: ['notifications'] });
    await ctx.addInitScript(STUB_SUBSCRIBE + `PushManager.prototype.subscribe = async () => { throw new Error('push service unreachable'); };`);
    const p = await ctx.newPage();
    await signIn(p);
    await sleep(1200);
    check('if push cannot register, the banner says so', await p.isVisible('#push-banner'));
    await api('/tasks', { method: 'POST', token: alice.token, body: { projectId: project.id, title: 'Defrost the freezer', assigneeId: bob.user.id } });
    await p.click('#refresh-btn');
    await sleep(1000);
    const toastText = await p.evaluate(() => document.body.innerText);
    check('…and a new task from someone else still shows up as an alert in the app', /New task from Alice — Defrost the freezer/.test(toastText));
    await ctx.close();
  }

  /* 2. Permission granted: the device is registered, no taps needed. */
  const ctx = await b.newContext({ permissions: ['notifications'] });
  await ctx.addInitScript(STUB_SUBSCRIBE);
  let p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE);
  await p.fill('input[name=email]', `pb.${stamp}@example.com`);
  await p.fill('input[name=password]', 'household123');
  await p.click('#auth-submit');
  await p.waitForSelector('#app-screen:not(.hidden)', { timeout: 15000 });

  let registered = false;
  for (let i = 0; i < 40 && !registered; i++) {
    await sleep(150);
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.data', 'push.json'), 'utf8'));
      registered = rows.some((r) => r.type === 'device' && r.kind === 'web' && r.userId === bob.user.id);
    } catch {}
  }
  check('with permission, this browser is registered for push on sign-in', registered);
  check('no banner once notifications are on', !(await p.isVisible('#push-banner')));

  await p.click('#open-account');
  await sleep(300);
  const status = await p.textContent('#push-status');
  check('Account shows new-task notifications as on', /^On/.test(status), status);
  check('…with a "Send me a test" button', await p.isVisible('#push-test'));
  check('reminders default to on once permission exists', await p.isChecked('#reminders-toggle'));
  await p.keyboard.press('Escape').catch(() => {});

  /* 3. A task arrives while the page is CLOSED. */
  const task = (await api('/tasks', { method: 'POST', token: alice.token, body: { projectId: project.id, title: 'Take the bins out', assigneeId: bob.user.id } })).task;
  const swTarget = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const origin = new URL(BASE).origin;

  // Keep a handle on the worker through CDP, then close every page.
  const cdpPage = await ctx.newPage();
  await cdpPage.goto('about:blank');
  await p.close();
  const cdp = await ctx.newCDPSession(cdpPage);
  const regs = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');
  await sleep(500);
  const reg = regs.find((r) => r.scopeURL.startsWith(origin) && !r.isDeleted);
  check('the service worker is still registered with the app closed', Boolean(reg));

  const payload = JSON.stringify({
    title: 'New task from Alice',
    body: 'Take the bins out — Home',
    data: { kind: 'task-assigned', taskId: task.id, projectId: project.id, priority: 'normal' },
  });
  if (reg) await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: reg.registrationId, data: payload });
  await sleep(800);

  const shown = await swTarget.evaluate(async () =>
    (await self.registration.getNotifications()).map((n) => ({ title: n.title, body: n.body, data: n.data }))
  );
  check('the service worker shows a notification with no HomeBoard page open', shown.length === 1, JSON.stringify(shown));
  check('…titled with who sent it', shown[0]?.title === 'New task from Alice');
  check('…and what the task is', shown[0]?.body === 'Take the bins out — Home');

  /* 4. Tapping it opens the app on that task. */
  // With the app closed the worker opens /?task=<id>. (Chromium only lets a
  // real click open a window, so that URL is opened here directly.)
  p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${BASE}/?task=${encodeURIComponent(task.id)}`);
  await p.waitForSelector('#sheet-detail.open', { timeout: 10000 }).catch(() => {});
  let txt = await p.textContent('#sheet-detail.open').catch(() => '');
  check('opening from a notification lands straight on that task', txt.includes('Take the bins out'), txt.slice(0, 80));
  check('…and the URL is cleaned up', !p.url().includes('task='));

  // With the app already open, the tap brings it forward on the task.
  await p.evaluate(() => document.querySelector('#sheet-detail .close-x')?.click());
  await sleep(300);
  await swTarget.evaluate(async () => {
    const [n] = await self.registration.getNotifications();
    const ev = new Event('notificationclick');
    Object.defineProperty(ev, 'notification', { value: n });
    ev.waitUntil = (pr) => pr;
    self.dispatchEvent(ev);
  });
  await p.waitForSelector('#sheet-detail.open', { timeout: 5000 }).catch(() => {});
  txt = await p.textContent('#sheet-detail.open').catch(() => '');
  check('tapping it with HomeBoard open jumps to the task', txt.includes('Take the bins out'));

  /* 5. Signing out stops pushes to this browser. */
  if (p) {
    await p.evaluate(() => document.querySelector('.sheet .close-x')?.click());
    await sleep(300);
    await p.click('#open-account');
    await sleep(300);
    await p.click('#signout-btn');
    await sleep(800);
    const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.data', 'push.json'), 'utf8'));
    check('signing out removes this browser from push', !rows.some((r) => r.type === 'device' && r.userId === bob.user.id));
  }

  check('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
