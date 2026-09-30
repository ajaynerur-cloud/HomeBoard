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

// The "Turn on notifications" sheet appears after sign-in in a browser; these
// flows aren't about that, so it is answered "Not now" whenever it shows.
const AUTO_NOT_NOW = `
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => {
      if (document.querySelector('#sheet-notify.open')) document.querySelector('#notify-later')?.click();
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
`;


let pass = 0, fail = 0;
const check = (l, c, d) => c
  ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${l}`))
  : (fail++, console.log(`  \x1b[31m✗\x1b[0m ${l} — ${d || ''}`));

/** A stand-in for @capacitor/local-notifications, installed before the app boots. */
function fakePlugin({ permission = 'prompt', exact = 'granted' } = {}) {
  return `
    window.__hb = {
      scheduled: [], cancelledIds: [], asked: 0, openedExactSetting: 0,
      channels: [], actionTypes: [], listeners: {},
      permission: ${JSON.stringify(permission)}, exact: ${JSON.stringify(exact)},
    };
    window.Capacitor = { Plugins: {
      LocalNotifications: {
        checkPermissions: async () => ({ display: window.__hb.permission }),
        requestPermissions: async () => {
          window.__hb.asked++;
          if (window.__hb.permission === 'prompt') window.__hb.permission = window.__hb.grantOnAsk ? 'granted' : 'denied';
          return { display: window.__hb.permission };
        },
        createChannel: async (c) => { window.__hb.channels.push(c); },
        registerActionTypes: async ({ types }) => { window.__hb.actionTypes.push(...types); },
        schedule: async ({ notifications }) => {
          // Mirror the real plugin: scheduling an existing id replaces it.
          for (const n of notifications) {
            const i = window.__hb.scheduled.findIndex(x => x.id === n.id);
            if (i >= 0) window.__hb.scheduled[i] = n; else window.__hb.scheduled.push(n);
          }
        },
        getPending: async () => ({ notifications: window.__hb.scheduled.map(n => ({ id: n.id, title: n.title })) }),
        cancel: async ({ notifications }) => {
          const ids = notifications.map(n => n.id);
          window.__hb.cancelledIds.push(...ids);
          window.__hb.scheduled = window.__hb.scheduled.filter(n => !ids.includes(n.id));
        },
        checkExactNotificationSetting: async () => ({ exact_alarm: window.__hb.exact }),
        changeExactNotificationSetting: async () => { window.__hb.openedExactSetting++; },
        addListener: (name, cb) => { (window.__hb.listeners[name] ||= []).push(cb); return { remove(){} }; },
      },
      App: { exitApp: () => { window.__hb.exited = true; }, addListener: () => {} },
    }};
    // Lets the test pretend the user tapped a notification action.
    window.__fire = (name, event) => (window.__hb.listeners[name] || []).forEach(cb => cb(event));
  `;
}

const BAND = 700000000;
const bandOf = (id) => (id < BAND ? 'early' : id < BAND * 2 ? 'due' : 'snooze');

async function signedInPage(browser, init, { grantOnAsk = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  const page = await ctx.newPage();
  await page.addInitScript(init);
  await page.addInitScript(AUTO_NOT_NOW);
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
    const st = await p.evaluate(() => window.__hb);
    // Permission is asked for straight after sign-in now, and once it is
    // granted reminders switch on by default — no toggle hunt.
    check('signing in asks the system for permission, once', st.asked === 1, `asked ${st.asked}`);
    check('the copy promises background delivery on Android',
          (await p.textContent('#reminders-note')).includes('HomeBoard closed'));
    check('reminders are on without touching the toggle', await p.isChecked('#reminders-toggle'));
    check('the lead-time control is showing', await p.locator('#lead-field.hidden').count() === 0);
    check('the background-apps help appears', await p.locator('#battery-help.hidden').count() === 0);

    const reminderChannel = st.channels.find((c) => c.id === 'homeboard-reminders');
    check('a high-importance channel is created for reminders',
          reminderChannel?.importance === 5, JSON.stringify(st.channels));
    check('and one for new tasks', st.channels.some((c) => c.id === 'homeboard-tasks' && c.importance === 5));
    check('a Snooze action is registered',
          st.actionTypes[0]?.actions?.some((a) => a.id === 'SNOOZE' && /10 min/.test(a.title)),
          JSON.stringify(st.actionTypes));

    const bins = st.scheduled.filter((n) => n.title === 'Bins out');
    check('two reminders are scheduled for the task — early and on time', bins.length === 2,
          JSON.stringify(st.scheduled.map((n) => [n.title, n.body])));
    check('one of each band', new Set(bins.map((n) => bandOf(n.id))).size === 2,
          JSON.stringify(bins.map((n) => bandOf(n.id))));

    const early = bins.find((n) => bandOf(n.id) === 'early');
    const due = bins.find((n) => bandOf(n.id) === 'due');
    check('the early one says how long is left', /Due in 10 minutes/.test(early.body), early.body);
    check('the early one fires 10 minutes before the due time',
          Math.round((new Date(due.schedule.at) - new Date(early.schedule.at)) / 60000) === 10,
          `${early.schedule.at} -> ${due.schedule.at}`);
    check('the due one lands about three hours out', (() => {
      const at = new Date(due.schedule.at).getTime() - Date.now();
      return at > 2.8 * 3600e3 && at < 3.1 * 3600e3;
    })(), due.schedule.at);
    check('both survive Doze', bins.every((n) => n.schedule.allowWhileIdle === true));
    check('both carry the Snooze action', bins.every((n) => n.actionTypeId === 'HB_TASK_DUE'));
    check('both carry the task id so a tap can open it',
          bins.every((n) => typeof n.extra?.taskId === 'string' && n.extra.taskId.startsWith('tsk_')));
    check('the task with no deadline is not scheduled',
          !st.scheduled.some((n) => n.title === 'Someday thing'));

    // Change the lead time
    await p.selectOption('#lead-minutes', '30');
    await p.waitForTimeout(1500);
    const st30 = await p.evaluate(() => window.__hb);
    const bins30 = st30.scheduled.filter((n) => n.title === 'Bins out');
    const e30 = bins30.find((n) => bandOf(n.id) === 'early');
    const d30 = bins30.find((n) => bandOf(n.id) === 'due');
    check('changing the lead time reschedules the early warning',
          Math.round((new Date(d30.schedule.at) - new Date(e30.schedule.at)) / 60000) === 30,
          `${e30.schedule.at} -> ${d30.schedule.at}`);
    check('and the worked example in the hint updates',
          /21:00/.test(await p.textContent('#lead-hint')), await p.textContent('#lead-hint'));

    // "Only at the due time"
    await p.selectOption('#lead-minutes', '0');
    await p.waitForTimeout(1500);
    const st0 = await p.evaluate(() => window.__hb);
    const bins0 = st0.scheduled.filter((n) => n.title === 'Bins out');
    check('choosing "only at the due time" drops the early warning',
          bins0.length === 1 && bandOf(bins0[0].id) === 'due', JSON.stringify(bins0.map((n) => bandOf(n.id))));

    await p.selectOption('#lead-minutes', '10');
    await p.waitForTimeout(1200);

    // Snooze
    await p.evaluate(() => {
      const n = window.__hb.scheduled.find((x) => x.title === 'Bins out');
      window.__fire('localNotificationActionPerformed', { actionId: 'SNOOZE', notification: n });
    });
    await p.waitForTimeout(1200);
    const snoozed = await p.evaluate(() => window.__hb.scheduled.filter((n) => n.id >= 1400000000));
    check('Snooze schedules a fresh reminder', snoozed.length === 1, JSON.stringify(snoozed));
    check('ten minutes out', (() => {
      const d = new Date(snoozed[0].schedule.at).getTime() - Date.now();
      return d > 9.5 * 60000 && d < 10.5 * 60000;
    })(), snoozed[0]?.schedule?.at);
    check('and it says so on screen', /Snoozed for 10 minutes/.test(await p.textContent('#toast-text')),
          await p.textContent('#toast-text'));

    // The app refreshes every 20s — that must not wipe a snooze.
    await p.keyboard.press('Escape');          // the Account sheet is still open
    await p.waitForTimeout(400);
    await p.click('#refresh-btn');
    await p.waitForTimeout(2000);
    const afterRefresh = await p.evaluate(() => window.__hb.scheduled.filter((n) => n.id >= 1400000000));
    check('a refresh does not cancel the snooze', afterRefresh.length === 1,
          JSON.stringify(afterRefresh));

    // Tapping the notification body opens that task
    await p.evaluate(() => {
      const n = window.__hb.scheduled.find((x) => x.title === 'Bins out');
      window.__fire('localNotificationActionPerformed', { actionId: 'tap', notification: n });
    });
    await p.waitForTimeout(900);
    check('tapping a reminder opens that task',
          (await p.textContent('#detail-body')).includes('Bins out')
          || await p.locator('#sheet-detail.open').count() === 1);

    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    await p.click('#open-account'); await p.waitForTimeout(500);
    await p.click('#reminders-toggle');
    await p.waitForTimeout(1200);
    const st2 = await p.evaluate(() => window.__hb);
    check('turning it off cancels everything, snoozes included', st2.scheduled.length === 0,
          JSON.stringify(st2.scheduled));
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
    // Already on from sign-in; switch it off and on again to see the warning.
    await p.click('#reminders-toggle');
    await p.waitForTimeout(800);
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
    check('reminders are on before the revoke (on by default once allowed)', await p.isChecked('#reminders-toggle'));

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
