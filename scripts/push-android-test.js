#!/usr/bin/env node
/*
 * The APK half of new-task push, with the Capacitor plugins stood in for.
 *
 *   - Android's permission dialog is asked for straight after sign-in, no tap
 *   - with Firebase in the build, the phone's token reaches the server
 *   - without Firebase, permission is STILL asked, and new tasks still raise a
 *     notification while the app is alive
 *   - tapping a notification that cold-started the app opens that task
 *
 * Needs a running server:  npm start &   then   node scripts/push-android-test.js
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

const stub = ({ fcm, permission = 'prompt', coldTapTaskId = null }) => `
  window.__a = { asked: 0, registered: 0, local: [], channels: [], listeners: {}, permission: ${JSON.stringify(permission)} };
  const perm = (key) => ({
    checkPermissions: async () => ({ [key]: window.__a.permission }),
    requestPermissions: async () => { window.__a.asked++; if (window.__a.permission === 'prompt') window.__a.permission = 'granted'; return { [key]: window.__a.permission }; },
  });
  const listen = (name, cb) => {
    (window.__a.listeners[name] ||= []).push(cb);
    // Android hands over the tap that launched the app as soon as someone listens.
    if (name === 'pushNotificationActionPerformed' && ${JSON.stringify(coldTapTaskId)}) {
      setTimeout(() => cb({ actionId: 'tap', notification: { data: { taskId: ${JSON.stringify(coldTapTaskId)} } } }), 0);
    }
    return { remove() {} };
  };
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      LocalNotifications: {
        ...perm('display'),
        createChannel: async (c) => window.__a.channels.push(c.id),
        registerActionTypes: async () => {},
        schedule: async ({ notifications }) => window.__a.local.push(...notifications),
        getPending: async () => ({ notifications: [] }),
        cancel: async () => {},
        checkExactNotificationSetting: async () => ({ exact_alarm: 'granted' }),
        addListener: listen,
      },
      PushNotifications: {
        ...perm('receive'),
        createChannel: async (c) => window.__a.channels.push(c.id),
        register: async () => {
          window.__a.registered++;
          setTimeout(() => (window.__a.listeners.registration || []).forEach((cb) => cb({ value: 'fcm-token-' + 'x'.repeat(140) })), 50);
        },
        addListener: listen,
      },
      App: { exitApp() {}, addListener() {} },
    },
  };
  ${fcm ? 'window.HOMEBOARD_FCM = true;' : ''}
  // config.js runs after this and would reset the flag; keep it.
  Object.defineProperty(window, 'HOMEBOARD_FCM', { value: ${fcm}, writable: false });
`;

(async () => {
  const b = await chromium.launch(process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {});
  const stamp = Date.now();
  const alice = await api('/auth/signup', { method: 'POST', body: { name: 'Alice', email: `aa.${stamp}@example.com`, password: 'household123' } });
  const bob = await api('/auth/signup', { method: 'POST', body: { name: 'Bob', email: `ab.${stamp}@example.com`, password: 'household123' } });
  const { project } = await api('/projects', { method: 'POST', token: alice.token, body: { name: 'Home' } });
  await api('/projects/join', { method: 'POST', token: bob.token, body: { code: project.inviteCode } });

  async function open(init) {
    const ctx = await b.newContext({ viewport: { width: 412, height: 915 } });
    await ctx.addInitScript(init);
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE);
    await p.fill('input[name=email]', `ab.${stamp}@example.com`);
    await p.fill('input[name=password]', 'household123');
    await p.click('#auth-submit');
    await p.waitForSelector('#app-screen:not(.hidden)', { timeout: 15000 });
    await sleep(1200);
    return { ctx, p, errs };
  }
  const devices = () => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.data', 'push.json'), 'utf8')).filter((r) => r.type === 'device' && r.userId === bob.user.id); }
    catch { return []; }
  };

  console.log('\nNew-task push in the APK (plugins stood in for)\n');

  /* With Firebase */
  {
    const { ctx, p, errs } = await open(stub({ fcm: true }));
    const a = await p.evaluate(() => window.__a);
    check('sign-in shows Android\'s notification permission dialog by itself', a.asked >= 1);
    check('no in-app sheet needed on Android', !(await p.isVisible('#sheet-notify.open')));
    check('registers with Firebase once allowed', a.registered === 1);
    check('creates the high-importance "New tasks" channel', a.channels.includes('homeboard-tasks'));
    check('the phone\'s token reaches the server', devices().some((d) => d.kind === 'fcm'));
    await p.click('#open-account'); await sleep(300);
    check('Account shows it as on', /^On/.test(await p.textContent('#push-status')));
    check('no page errors', !errs.length, errs.join(' | '));
    await ctx.close();
  }

  /* Without Firebase in the build */
  {
    const { ctx, p, errs } = await open(stub({ fcm: false }));
    let a = await p.evaluate(() => window.__a);
    check('no-Firebase build: permission is still asked for at sign-in', a.asked >= 1);
    check('…does not try to register with Firebase (that would crash the app)', a.registered === 0);
    check('…still creates the "New tasks" channel', a.channels.includes('homeboard-tasks'));
    await p.click('#open-account'); await sleep(300);
    check('…and Account says why closed-app delivery is off', /without Firebase/.test(await p.textContent('#push-status')));
    await p.evaluate(() => document.querySelector('#sheet-account .close-x').click());

    // Backgrounded: the app is alive but not in front.
    await p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    });
    await api('/tasks', { method: 'POST', token: alice.token, body: { projectId: project.id, title: 'Put the washing out', assigneeId: bob.user.id } });
    await p.evaluate(() => document.querySelector('#refresh-btn').click());
    await sleep(1200);
    a = await p.evaluate(() => window.__a);
    const n = a.local.find((x) => x.title === 'New task from Alice');
    check('in the background, a new task raises an Android notification', Boolean(n), JSON.stringify(a.local.map((x) => x.title)));
    check('…on the New tasks channel', n?.channelId === 'homeboard-tasks');
    check('…carrying the task so a tap opens it', Boolean(n?.extra?.taskId));
    const before = a.local.length;
    await p.evaluate(() => document.querySelector('#refresh-btn').click());
    await sleep(1000);
    check('…and only once', (await p.evaluate(() => window.__a.local.length)) === before);
    check('no page errors', !errs.length, errs.join(' | '));
    await ctx.close();
  }

  /* Tap on a notification that launched the app */
  {
    const task = (await api('/tasks', { method: 'POST', token: alice.token, body: { projectId: project.id, title: 'Pay the milkman', assigneeId: bob.user.id } })).task;
    const { ctx, p } = await open(stub({ fcm: true, permission: 'granted', coldTapTaskId: task.id }));
    await p.waitForSelector('#sheet-detail.open', { timeout: 5000 }).catch(() => {});
    const t = await p.textContent('#sheet-detail.open').catch(() => '');
    check('a tap that cold-started the app opens that task once signed in', t.includes('Pay the milkman'), t.slice(0, 60));
    await ctx.close();
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
