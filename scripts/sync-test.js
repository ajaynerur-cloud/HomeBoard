/*
 * Offline-first + manual sync, in a real browser.
 *   npm start & node scripts/sync-test.js [baseUrl]
 *
 * Works offline from the local copy, survives a reload with no network, keeps
 * changes until Sync is pressed, sends them in order, folds create+delete into
 * nothing, and reports a change the server can no longer apply.
 */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000';

const AUTO_NOT_NOW = `
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => {
      if (document.querySelector('#sheet-notify.open')) document.querySelector('#notify-later')?.click();
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
`;

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${l} — ${d || ''}`); } };

async function apiAs(token, path, opts = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

(async () => {
  const b = await chromium.launch(process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {});
  const ctx = await b.newContext({ viewport: { width: 430, height: 932 } });
  await ctx.addInitScript(AUTO_NOT_NOW);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.accept());

  const s = Date.now();
  console.log('\nOffline-first sync\n');

  // Sign up and make a board (needs the server).
  await p.goto(BASE);
  await p.click('#tab-signup');
  await p.fill('[name=name]', 'Offline Olly');
  await p.fill('#auth-form [name=email]', `off.${s}@demo.com`);
  await p.fill('#auth-form [name=password]', 'homeboard123');
  await p.click('#auth-submit');
  await p.waitForSelector('#first-board');
  await p.click('#first-board');
  await p.fill('#new-board-form [name=name]', 'Cabin');
  await p.click('#new-board-form button[type=submit]');
  await p.waitForTimeout(1200);
  const token = await p.evaluate(() => localStorage.getItem('hb.token'));

  // Manual only: no timer, no open/leave sync.
  await p.click('#open-account');
  await p.selectOption('#sync-every', '0');
  await p.uncheck('#sync-edges');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);

  // A task that exists on the server already, for the conflict case later.
  await p.click('#fab');
  await p.fill('#task-form [name=title]', 'Chop wood');
  await p.click('#task-save');
  await p.waitForTimeout(300);
  await p.click('#refresh-btn');
  await p.waitForTimeout(1200);
  let server = await apiAs(token, '/tasks');
  check('Sync now sends a task', server.tasks.some((t) => t.title === 'Chop wood'));

  // ── go offline ──
  await ctx.setOffline(true);
  await p.click('#fab');
  await p.fill('#task-form [name=title]', 'Fix the gutter');
  await p.fill('#task-form [name=details]', 'Left side, near the shed');
  await p.click('#task-save');
  await p.waitForTimeout(300);
  check('a task can be added with no network', await p.locator('.task-title', { hasText: 'Fix the gutter' }).count() === 1);

  await p.click('#fab');
  await p.fill('#task-form [name=title]', 'Typo task');
  await p.click('#task-save');
  await p.waitForTimeout(300);
  await p.click('.task-open:has-text("Typo task")');
  await p.click('#detail-delete');
  await p.waitForTimeout(300);
  check('and deleted again offline', await p.locator('.task-title', { hasText: 'Typo task' }).count() === 0);

  await p.click('.task-open:has-text("Fix the gutter")');
  await p.fill('#note-form [name=text]', 'Ladder is in the garage');
  await p.click('#note-form button[type=submit]');
  await p.waitForTimeout(300);
  check('a note can be added offline', (await p.textContent('#detail-body')).includes('Ladder is in the garage'));
  await p.keyboard.press('Escape');

  check('the badge counts the waiting changes', (await p.textContent('#sync-badge')).trim() === '2',
    await p.textContent('#sync-badge'));
  check('the strip says they are on this device', /on this device/.test(await p.textContent('#sync-strip-text')));

  // Reload with no network: still opens, from the local copy.
  await p.reload().catch(() => {});
  await p.waitForSelector('#app-screen:not(.hidden)', { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(800);
  check('reopening offline shows the app, not sign-in', await p.locator('#app-screen:not(.hidden)').count() === 1);
  check('with the offline task still there', await p.locator('.task-title', { hasText: 'Fix the gutter' }).count() === 1);

  await p.click('#refresh-btn');
  await p.waitForTimeout(600);
  check('Sync while offline keeps the changes', (await p.textContent('#sync-badge')).trim() === '2');

  // Someone else finishes "Chop wood" on the server while we edit it offline.
  const chop = server.tasks.find((t) => t.title === 'Chop wood');
  await p.click('.task-open:has-text("Chop wood")');
  await p.click('#detail-edit');
  await p.fill('#task-form [name=title]', 'Chop wood (lots)');
  await p.click('#task-save');
  await p.waitForTimeout(300);
  await apiAs(token, `/tasks/${chop.id}/complete`, { method: 'POST' });

  // ── back online: manual means nothing happens on its own ──
  await ctx.setOffline(false);
  await p.waitForTimeout(1500);
  server = await apiAs(token, '/tasks');
  check('coming back online does not sync by itself in manual mode', !server.tasks.some((t) => t.title === 'Fix the gutter'));

  await p.click('#refresh-btn');
  await p.waitForTimeout(2500);
  server = await apiAs(token, '/tasks');
  const gutter = server.tasks.find((t) => t.title === 'Fix the gutter');
  check('Sync now sends the offline task', Boolean(gutter));
  check('with its details', gutter?.details === 'Left side, near the shed');
  check('and the offline note, once', gutter?.comments?.filter((c) => c.text === 'Ladder is in the garage').length === 1);
  check('a task made and deleted offline never reaches the server', !server.tasks.some((t) => t.title === 'Typo task'));
  check('the edit to a task someone else finished is reported', /could not be applied/i.test(await p.textContent('#toast-text')),
    await p.textContent('#toast-text'));
  check('and nothing is left waiting', await p.locator('#sync-badge.hidden').count() === 1);

  // Finish offline, sync, check the history keeps the real finish time.
  await ctx.setOffline(true);
  await p.click('.task-open:has-text("Fix the gutter")');
  await p.click('#detail-complete');
  const doneAt = Date.now();
  await p.waitForTimeout(1500);
  await ctx.setOffline(false);
  await p.click('#refresh-btn');
  await p.waitForTimeout(2000);
  const hist = await apiAs(token, '/tasks/history/list');
  const h = hist.history.find((x) => x.title === 'Fix the gutter');
  check('finishing offline lands in Finished after sync', Boolean(h));
  check('with the time it was really finished', h && Math.abs(Date.parse(h.completedAt) - doneAt) < 1500,
    h && `${Date.parse(h.completedAt) - doneAt}ms`);
  server = await apiAs(token, '/tasks');
  check('and the task itself is purged', !server.tasks.some((t) => t.title === 'Fix the gutter'));

  // Replaying a create (reply lost) does not duplicate.
  const id = 'tsk_replaytest' + s;
  const board = (await apiAs(token, '/projects')).projects[0];
  await apiAs(token, '/tasks', { method: 'POST', body: { id, projectId: board.id, title: 'Replay me' } });
  await apiAs(token, '/tasks', { method: 'POST', body: { id, projectId: board.id, title: 'Replay me' } });
  server = await apiAs(token, '/tasks');
  check('sending the same new task twice makes one task', server.tasks.filter((t) => t.id === id).length === 1);

  check('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
