#!/usr/bin/env node
/*
 * Exercises the reminder flow against a stand-in for the Capacitor plugin, so
 * the Android branches are covered without building an APK.
 *
 *   npm start & node scripts/reminders-test.js [baseUrl]
 *   (needs: npm i --no-save playwright)
 */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000';

let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${l}`))
  : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${l} — ${d || ''}`));

/** A fake @capacitor/local-notifications, installed before the app boots. */
function fakePlugin({ permission = 'prompt', exact = 'granted' } = {}) {
  return `
    window.__hb = { scheduled: [], cancelled: 0, asked: 0, openedExactSetting: 0,
                    permission: ${JSON.stringify(permission)}, exact: ${JSON.stringify(exact)} };
    window.Capacitor = { Plugins: {
      LocalNotifications: {
        checkPermissions: async () => ({ display: window.__hb.permission }),
        requestPermissions: async () => {
          window.__hb.asked++;
          if (window.__hb.permission === 'prompt') window.__hb.permission = window.__hb.grantOnAsk ? 'granted' : 'denied';
          return { display: window.__hb.permission };
        },
        schedule: async ({ notifications }) => { window.__hb.scheduled.push(...notifications); },
        getPending: async () => ({ notifications: window.__hb.scheduled.map(n => ({ id: n.id })) }),
        cancel: async () => { window.__hb.cancelled++; window.__hb.scheduled = []; },
        checkExactNotificationSetting: async () => ({ exact_alarm: window.__hb.exact }),
        changeExactNotificationSetting: async () => { window.__hb.openedExactSetting++; },
      },
      App: { exitApp: () => { window.__hb.exited = true; }, addListener: () => {} },
    }};
  `;
}

async function signedInPage(browser, init, { grantOnAsk = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const page = await ctx.newPage();
  await page.addInitScript(init);
  await page.addInitScript(`window.addEventListener('DOMContentLoaded', () => { if (window.__hb) window.__hb.grantOnAsk = ${grantOnAsk}; });`);

  const email = `rem.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@demo.com`;
  await page.goto(BASE);
  await page.click('#tab-signup');
  await page.fill('[name=name]', 'Reminder Tester');
  await page.fill('#auth-form [name=email]', email);
  await page.fill('#auth-form [name=password]', 'household123');
  await page.click('#auth-submit');
  await page.waitForSelector('#app-screen:not(.hidden)', { timeout: 15000 });

  await page.click('#first-board');
  await page.waitForTimeout(400);
  await page.fill('#new-board-form [name=name]', 'Reminders');
  await page.click('#new-board-form button[type=submit]');
  await page.waitForTimeout(1400);

  // One task due soon, one with no deadline (must not be scheduled).
  await page.click('#fab'); await page.waitForTimeout(400);
  await page.fill('#task-form [name=title]', 'Bins out');
  await page.click('#task-form .quick button[data-in="3"]');
  await page.click('#task-save'); await page.waitForTimeout(1400);

  await page.click('#fab'); await page.waitForTimeout(400);
  await page.fill('#task-form [name=title]', 'Someday thing');
  await page.click('#task-form .quick button[data-clear="1"]');
  await page.click('#task-save'); await page.waitForTimeout(1400);

  return page;
}

(async () => {
  const b = await chromium.launch(
    process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {}
  );
  const errs = [];

  console.log('\nReminders\n');

  // ---- happy path: prompt -> granted ----
  {
    const p = await signedInPage(b, fakePlugin({ permission: 'prompt' }), { grantOnAsk: true });
    p.on('pageerror', (e) => errs.push(e.message));

    await p.click('#open-account'); await p.waitForTimeout(600);
    check('the toggle starts off', await p.isChecked('#reminders-toggle') === false);
    check('the copy promises background delivery on Android',
          (await p.textContent('#reminders-note')).includes('HomeBoard closed'));

    await p.click('#reminders-toggle');
    await p.waitForTimeout(1500);
    const st = await p.evaluate(() => window.__hb);
    check('turning it on asks the system for permission', st.asked === 1, `asked ${st.asked}`);
    check('the toggle stays on once granted', await p.isChecked('#reminders-toggle'));
    check('a reminder is scheduled for the task with a deadline', st.scheduled.length === 1,
          JSON.stringify(st.scheduled.map(n => n.title)));
    check('it carries the task title', st.scheduled[0]?.title === 'Bins out', st.scheduled[0]?.title);
    check('it is scheduled at the due time, about three hours out', (() => {
      const at = new Date(st.scheduled[0].schedule.at).getTime() - Date.now();
      return at > 2.8 * 3600e3 && at < 3.1 * 3600e3;
    })(), st.scheduled[0]?.schedule?.at);
    check('the task with no deadline is not scheduled',
          !st.scheduled.some(n => n.title === 'Someday thing'));

    await p.click('#reminders-toggle');
    await p.waitForTimeout(1000);
    const st2 = await p.evaluate(() => window.__hb);
    check('turning it off cancels what was scheduled', st2.scheduled.length === 0 && st2.cancelled > 0);
    await p.context().close();
  }

  // ---- permission refused ----
  {
    const p = await signedInPage(b, fakePlugin({ permission: 'prompt' }), { grantOnAsk: false });
    p.on('pageerror', (e) => errs.push(e.message));
    await p.click('#open-account'); await p.waitForTimeout(600);
    await p.click('#reminders-toggle');
    await p.waitForTimeout(1500);
    check('a refused permission flips the toggle back', await p.isChecked('#reminders-toggle') === false);
    const msg = await p.textContent('#toast-text');
    check('and says where to turn it on', /Settings → Apps → HomeBoard/.test(msg), msg);
    check('nothing was scheduled', (await p.evaluate(() => window.__hb.scheduled.length)) === 0);
    await p.context().close();
  }

  // ---- already denied at the OS level: don't pretend to ask ----
  {
    const p = await signedInPage(b, fakePlugin({ permission: 'denied' }));
    p.on('pageerror', (e) => errs.push(e.message));
    await p.click('#open-account'); await p.waitForTimeout(600);
    await p.click('#reminders-toggle');
    await p.waitForTimeout(1200);
    const st = await p.evaluate(() => window.__hb);
    check('an already-denied permission is not re-requested pointlessly', st.asked === 0, `asked ${st.asked}`);
    check('the toggle stays off', await p.isChecked('#reminders-toggle') === false);
    await p.context().close();
  }

  // ---- granted, but exact alarms are not allowed ----
  {
    const p = await signedInPage(b, fakePlugin({ permission: 'granted', exact: 'denied' }));
    p.on('pageerror', (e) => errs.push(e.message));
    await p.click('#open-account'); await p.waitForTimeout(600);
    await p.click('#reminders-toggle');
    await p.waitForTimeout(1500);
    check('reminders still turn on', await p.isChecked('#reminders-toggle'));
    const msg = await p.textContent('#toast-text');
    check('but the lateness is admitted', /may arrive late/.test(msg), msg);
    check('with a way to fix it', await p.locator('#toast-action:not(.hidden)').count() === 1);
    await p.click('#toast-action');
    await p.waitForTimeout(600);
    check('which opens the Android setting',
          (await p.evaluate(() => window.__hb.openedExactSetting)) === 1);
    await p.context().close();
  }

  // ---- revoked in Android settings while the app was closed ----
  {
    const p = await signedInPage(b, fakePlugin({ permission: 'granted' }));
    p.on('pageerror', (e) => errs.push(e.message));
    await p.click('#open-account'); await p.waitForTimeout(500);
    await p.click('#reminders-toggle'); await p.waitForTimeout(1200);
    check('reminders are on before the revoke', await p.isChecked('#reminders-toggle'));

    await p.evaluate(() => { window.__hb.permission = 'denied'; });
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.click('#open-account'); await p.waitForTimeout(900);
    check('reopening Settings shows the toggle has gone off',
          await p.isChecked('#reminders-toggle') === false);
    await p.context().close();
  }

  // ---- plain browser, no Capacitor ----
  {
    const p = await signedInPage(b, 'window.__hb = null;');
    p.on('pageerror', (e) => errs.push(e.message));
    await p.click('#open-account'); await p.waitForTimeout(600);
    const note = await p.textContent('#reminders-note');
    check('in a browser the copy does not promise background reminders',
          note.includes('only fires while HomeBoard is open'), note);
    await p.context().close();
  }

  console.log(`\n  js errors: ${errs.length ? JSON.stringify(errs, null, 2) : 'none'}`);
  console.log(`\n${fail === 0 && !errs.length ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  await b.close();
  process.exit(fail === 0 && errs.length === 0 ? 0 : 1);
})();
