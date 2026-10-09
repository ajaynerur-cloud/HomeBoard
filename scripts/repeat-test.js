/*
 * Repeating tasks, in a real browser and against the API.
 *   npm start & node scripts/repeat-test.js [baseUrl]
 */
const { chromium } = require('playwright');
const Repeat = require('../public/repeat.js');
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
const visible = async (p, sel) => p.locator(`${sel}:not(.hidden)`).count().then((n) => n === 1);

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
  const ctx = await b.newContext({ viewport: { width: 430, height: 932 }, timezoneId: 'Asia/Kolkata' });
  await ctx.addInitScript(AUTO_NOT_NOW);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.accept());

  const s = Date.now();
  console.log('\nRepeating tasks\n');
  await p.goto(BASE);
  await p.click('#tab-signup');
  await p.fill('[name=name]', 'Ravi Repeat');
  await p.fill('#auth-form [name=email]', `rep.${s}@demo.com`);
  await p.fill('#auth-form [name=password]', 'homeboard123');
  await p.click('#auth-submit');
  await p.waitForSelector('#first-board');
  await p.click('#first-board');
  await p.fill('#new-board-form [name=name]', 'Home');
  await p.click('#new-board-form button[type=submit]');
  await p.waitForTimeout(1200);
  const token = await p.evaluate(() => localStorage.getItem('hb.token'));

  // Weekly, no due date picked: starts today/tomorrow at 6pm.
  await p.click('#fab');
  await p.fill('#task-form [name=title]', 'Bins out');
  await p.selectOption('#repeat-preset', 'weekly');
  check('choosing a repeat explains it', await visible(p, '#repeat-hint'));
  await p.fill('#task-form [name=details]', 'Green bin');
  await p.click('#add-check');
  await p.fill('#checklist-edit .t >> nth=0', 'Wheel it out');
  await p.click('#task-save');
  await p.waitForTimeout(400);
  check('the card says it repeats', (await p.textContent('.task:has-text("Bins out")')).includes('↻ Weekly on'));

  // Custom: every 2 weeks on Mon + Thu.
  await p.click('#fab');
  await p.fill('#task-form [name=title]', 'Water the ferns');
  await p.fill('#task-form [name=dueAt]', '2026-10-08T07:30');   // a Thursday
  await p.selectOption('#repeat-preset', 'custom');
  check('custom shows the every-N and day pickers', await visible(p, '#repeat-custom') && await visible(p, '#repeat-days'));
  await p.fill('#repeat-interval', '2');
  await p.click('#repeat-days button[data-d="1"]');   // + Monday (Thursday already on)
  const hint = await p.textContent('#repeat-hint');
  check('it previews the next dates', /Every 2 weeks on Mon, Thu/.test(hint) && /Mon/.test(hint.split('Next:')[1] || ''), hint);
  await p.click('#task-save');
  await p.waitForTimeout(400);

  // Daily, then sync, then finish it.
  await p.click('#fab');
  await p.fill('#task-form [name=title]', 'Feed the cat');
  await p.click('#task-form .quick button[data-in="1"]');
  await p.selectOption('#repeat-preset', 'daily');
  await p.click('#task-save');
  await p.waitForTimeout(300);
  await p.click('#refresh-btn');
  await p.waitForTimeout(1800);
  let server = await apiAs(token, '/tasks');
  const cat = server.tasks.find((t) => t.title === 'Feed the cat');
  const ferns = server.tasks.find((t) => t.title === 'Water the ferns');
  check('the rule reaches the server', cat?.repeat?.unit === 'day' && cat.repeat.interval === 1, JSON.stringify(cat?.repeat));
  check('custom rule kept exactly', ferns?.repeat?.interval === 2 && ferns.repeat.days.join() === '1,4', JSON.stringify(ferns?.repeat));

  const before = cat.dueAt;
  await p.click('.task-open:has-text("Feed the cat")');
  check('the task view shows the repeat', (await p.textContent('#detail-body')).includes('↻ Daily'));
  await p.click('#detail-complete');
  await p.waitForTimeout(400);
  check('finishing says when the next one is', /Next one/.test(await p.textContent('#toast-text')), await p.textContent('#toast-text'));
  check('it stays on the board', await p.locator('.task-title', { hasText: 'Feed the cat' }).count() === 1);
  await p.click('.tabs button[data-view=done]');
  check('and this time goes into Finished', (await p.textContent('#view')).includes('Feed the cat'));
  await p.click('.tabs button[data-view=mine]');

  await p.click('#refresh-btn');
  await p.waitForTimeout(1800);
  server = await apiAs(token, '/tasks');
  const cat2 = server.tasks.find((t) => t.title === 'Feed the cat');
  check('on the server it moved one day on', cat2 && Date.parse(cat2.dueAt) - Date.parse(before) === 24 * 3600 * 1000,
    `${before} → ${cat2?.dueAt}`);
  const hist = await apiAs(token, '/tasks/history/list');
  check('with a line in Finished', hist.history.some((h) => h.title === 'Feed the cat'));

  // Steps untick, details stay.
  const bins = server.tasks.find((t) => t.title === 'Bins out');
  await p.click('.task-open:has-text("Bins out")');
  await p.click('#detail-checks input[type=checkbox]');
  await p.waitForTimeout(200);
  await p.click('#detail-complete');
  await p.waitForTimeout(400);
  const local = await p.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('hb.outbox.')))));
  check('weekly: queued with the date a week on', local.some((o) => o.type === 'complete' && Date.parse(o.nextDueAt) - Date.parse(bins.dueAt) === 7 * 24 * 3600 * 1000));
  await p.click('.task-open:has-text("Bins out")');
  const body = await p.textContent('#detail-body');
  check('details are kept for next time', body.includes('Green bin'));
  check('steps are unticked for next time', await p.locator('#detail-checks .check.done').count() === 0);
  await p.keyboard.press('Escape');

  // Undo after it has synced: it goes back to the earlier date.
  await p.click('#refresh-btn');
  await p.waitForTimeout(1500);
  await p.click('.task-open:has-text("Feed the cat")');
  await p.click('#detail-complete');
  await p.waitForTimeout(300);
  await p.click('#refresh-btn');                        // the completion is sent…
  await p.waitForTimeout(1500);
  const afterDone = (await apiAs(token, '/tasks')).tasks.find((t) => t.title === 'Feed the cat').dueAt;
  await p.evaluate(() => document.querySelector('#toast-action')?.click()); // …then Undo
  await p.waitForTimeout(300);
  await p.click('#refresh-btn');
  await p.waitForTimeout(1500);
  const undone = (await apiAs(token, '/tasks')).tasks.find((t) => t.title === 'Feed the cat').dueAt;
  check('Undo after syncing moves it back a day', Date.parse(afterDone) - Date.parse(undone) === 24 * 3600 * 1000, `${afterDone} → ${undone}`);

  // Turning repeat off makes it an ordinary task again.
  await p.click('.task-open:has-text("Water the ferns")');
  await p.click('#detail-edit');
  check('editing shows the custom rule', (await p.inputValue('#repeat-preset')) === 'custom' && (await p.inputValue('#repeat-interval')) === '2');
  await p.selectOption('#repeat-preset', 'none');
  await p.click('#task-save');
  await p.click('#refresh-btn');
  await p.waitForTimeout(1500);
  server = await apiAs(token, '/tasks');
  check('setting "Doesn\'t repeat" clears it', !server.tasks.find((t) => t.title === 'Water the ferns')?.repeat);

  // An older app (no nextDueAt): the server works the date out itself.
  const board = (await apiAs(token, '/projects')).projects[0];
  const { task } = await apiAs(token, '/tasks', { method: 'POST', body: {
    projectId: board.id, title: 'Old app daily', dueAt: new Date(Date.now() + 3600e3).toISOString(), repeat: { unit: 'day', interval: 1 },
  } });
  const out = await apiAs(token, `/tasks/${task.id}/complete`, { method: 'POST', body: {} });
  check('the server rolls it forward for an older app', out.nextDueAt && Date.parse(out.nextDueAt) - Date.parse(task.dueAt) === 24 * 3600 * 1000, out.nextDueAt);
  const bad = await apiAs(token, `/tasks/${task.id}/complete`, { method: 'POST', body: { nextDueAt: '2001-01-01T00:00:00Z' } });
  check('and refuses a next date in the past', Date.parse(bad.nextDueAt) > Date.now());

  // Repeat rule junk is refused.
  const { task: junk } = await apiAs(token, '/tasks', { method: 'POST', body: { projectId: board.id, title: 'Junk', repeat: { unit: 'century', interval: -4 } } });
  check('a nonsense rule is dropped', !junk.repeat);

  check('rules agree with the shared module', Repeat.describe({ unit: 'week', interval: 2, days: [1, 4] }) === 'Every 2 weeks on Mon, Thu');
  check('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
