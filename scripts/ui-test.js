/*
 * Browser walk-through of the whole UI.
 *   npm i --no-save playwright && npx playwright install chromium
 *   npm start & node scripts/ui-test.js [baseUrl]
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

let pass=0, fail=0;
const ok=(l)=>{pass++;console.log(`  \x1b[32m✓\x1b[0m ${l}`)};
const bad=(l,d)=>{fail++;console.log(`  \x1b[31m✗\x1b[0m ${l} — ${d||''}`)};
const check=(l,c,d)=>c?ok(l):bad(l,d);

(async()=>{
  // PLAYWRIGHT_CHROME lets you point at a chromium you already have, for
  // environments where `npx playwright install` can't reach the download host.
  const b = await chromium.launch(
    process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {}
  );
  const ctx=await b.newContext({viewport:{width:430,height:932}});
  await ctx.addInitScript(AUTO_NOT_NOW);
  const p=await ctx.newPage();
  const errs=[];
  p.on('pageerror',e=>errs.push('pageerror: '+e.message));
  p.on('console',m=>{const t=m.text(); if(m.type()==='error' && !t.includes('ERR_TUNNEL')) errs.push('console: '+t)});

  const s=Date.now();
  const email=`ui.${s}@demo.com`;

  console.log('\nUI flow\n');
  await p.goto(BASE);

  // Show / hide password
  await p.waitForSelector('#peek-password');
  check('password starts hidden', await p.getAttribute('#auth-form [name=password]', 'type') === 'password');
  await p.click('#peek-password');
  check('tapping the eye reveals it', await p.getAttribute('#auth-form [name=password]', 'type') === 'text');
  await p.click('#peek-password');
  check('tapping again hides it', await p.getAttribute('#auth-form [name=password]', 'type') === 'password');

  await p.click('#tab-signup');
  await p.fill('[name=name]','Test Person');
  await p.fill('#auth-form [name=email]',email);
  await p.fill('#auth-form [name=password]','homeboard123');
  await p.click('#auth-submit');
  await p.waitForSelector('#app-screen:not(.hidden)',{timeout:10000});
  check('sign up lands in the app', true);

  await p.waitForSelector('#first-board',{timeout:5000});
  await p.click('#first-board');
  await p.waitForTimeout(500);
  await p.fill('#new-board-form [name=name]','Flat 3B');
  await p.click('#new-board-form button[type=submit]');
  await p.waitForTimeout(1200);
  check('board created', (await p.textContent('#board-name')).includes('Flat 3B'),
        await p.textContent('#board-name'));

  await p.click('#fab');
  await p.waitForTimeout(500);
  await p.fill('#task-form [name=title]','Take the bins out');
  await p.fill('#task-form [name=details]','Green bin. Gate code 4412.');
  await p.click('#task-form .quick button[data-in="3"]');
  await p.click('#priority-seg button[data-v=high]');
  await p.click('#add-check');
  await p.fill('#checklist-edit .t','Bin to the kerb');
  await p.click('#task-save');
  await p.waitForTimeout(1500);
  check('task created from the UI', await p.locator('.task-title', {hasText:'Take the bins out'}).count() > 0);
  const meta = await p.textContent('.task-meta');
  check('countdown shows on the card', /left|overdue/.test(meta), meta);
  check('details flag shows', meta.includes('details'), meta);
  check('checklist count shows', meta.includes('0/1'), meta);
  check('priority stripe applied', await p.locator('.task.pri-high').count() === 1);

  check('no one-tap complete button on the card', await p.locator('.task .tick').count() === 0);
  await p.click('.task-open');
  await p.waitForTimeout(600);
  check('tapping the card opens it instead of completing it',
        await p.locator('#sheet-detail.open').count() === 1);
  check('the task is still on the board', await p.locator('.task').count() === 1);
  const detail = await p.textContent('#detail-body');
  check('detail sheet shows the details text', detail.includes('4412'));
  check('detail sheet shows the step', detail.includes('Bin to the kerb'));

  await p.fill('#note-form [name=text]','Collection moved to Tuesday');
  await p.click('#note-form button[type=submit]');
  await p.waitForTimeout(1200);
  check('note posted', (await p.textContent('#detail-body')).includes('Collection moved to Tuesday'));

  await p.click('#detail-checks input[type=checkbox]');
  await p.waitForTimeout(1200);
  check('step ticked', (await p.textContent('#detail-body')).includes('1/1'),
        await p.textContent('#detail-body').then(t=>t.slice(0,80)));

  await p.click('#detail-complete');
  await p.waitForTimeout(1600);
  check('task gone from the board', await p.locator('.task').count() === 0);
  check('an Undo is offered', await p.locator('#toast-action:not(.hidden)').count() === 1);

  await p.click('#toast-action');
  await p.waitForTimeout(1600);
  check('Undo puts the task back', await p.locator('.task-title', { hasText: 'Take the bins out' }).count() === 1);
  await p.click('.task-open');
  await p.waitForTimeout(600);
  check('and its details survived the round trip',
        (await p.textContent('#detail-body')).includes('4412'));

  await p.click('#detail-complete');
  await p.waitForTimeout(1600);
  check('completing again works', await p.locator('.task').count() === 0);

  await p.click('.tabs button[data-view=done]');
  await p.waitForTimeout(500);
  const hist = await p.textContent('#view');
  check('name kept in Finished', hist.includes('Take the bins out'));
  check('details NOT in Finished', !hist.includes('4412') && !hist.includes('Collection moved'));

  // second user joins by code
  await p.click('.tabs button[data-view=mine]');
  await p.click('#open-members');
  await p.waitForTimeout(500);
  const code = await p.textContent('#invite-code');
  check('join code visible', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code.trim()), code);
  check('a QR code is drawn for the invite', await p.locator('#invite-qr svg').count() === 1);
  const qrModules = await p.locator('#invite-qr svg path').getAttribute('d');
  check('the QR has real content', (qrModules || '').length > 400, `path length ${(qrModules || '').length}`);

  const ctx2 = await b.newContext({viewport:{width:430,height:932}}); await ctx2.addInitScript(AUTO_NOT_NOW);
  const p2 = await ctx2.newPage();
  p2.on('pageerror',e=>errs.push('p2 pageerror: '+e.message));
  await p2.goto(BASE);
  await p2.click('#tab-signup');
  await p2.fill('[name=name]','Second Person');
  await p2.fill('#auth-form [name=email]',`ui2.${s}@demo.com`);
  await p2.fill('#auth-form [name=password]','homeboard123');
  await p2.click('#auth-submit');
  await p2.waitForSelector('#app-screen:not(.hidden)',{timeout:10000});
  await p2.click('#first-board');
  await p2.waitForTimeout(500);
  await p2.fill('#join-form [name=code]',code.trim());
  await p2.click('#join-form button[type=submit]');
  await p2.waitForTimeout(1500);
  check('second user joined via code', (await p2.textContent('#board-name')).includes('Flat 3B'),
        await p2.textContent('#board-name'));

  // push a task to person 1
  await p2.click('#fab');
  await p2.waitForTimeout(500);
  await p2.fill('#task-form [name=title]','Call the plumber');
  const people = await p2.locator('#assignee-picker .person').allTextContents();
  check('assignee picker lists both people', people.length===2, JSON.stringify(people));
  const other = p2.locator('#assignee-picker .person').filter({ hasNotText: 'Me' }).first();
  check('other person is selectable', await other.count() === 1);
  await other.click();
  await p2.click('#task-save');
  await p2.waitForTimeout(1500);
  await p2.click('.tabs button[data-view=sent]');
  await p2.waitForTimeout(400);
  check('shows under "I assigned" for the sender', await p2.locator('.task-title',{hasText:'Call the plumber'}).count()>0);
  await p2.click('#refresh-btn');           // send it
  await p2.waitForTimeout(1500);

  await p.reload();                         // opening the app syncs (safety net on by default)
  await p.waitForTimeout(1600);
  check('lands on the other person\'s "For me"', await p.locator('.task-title',{hasText:'Call the plumber'}).count()>0);

  // Live sync: person 2 adds a task, person 1 sees it without touching anything.
  await p2.click('#fab');
  await p2.waitForTimeout(400);
  await p2.fill('#task-form [name=title]', 'Defrost the freezer');
  const other2 = p2.locator('#assignee-picker .person').filter({ hasNotText: 'Me' }).first();
  await other2.click();
  await p2.click('#task-save');
  await p2.waitForTimeout(1200);

  // Offline-first: it is on p2's device only until p2 syncs.
  check('the sender sees it straight away', await p2.locator('.task-title',{hasText:'Defrost the freezer'}).count()>0);
  check('the sync button shows a change waiting', (await p2.textContent('#sync-badge')).trim() === '1');
  await p.click('#refresh-btn');
  await p.waitForTimeout(1200);
  check('the other person does not get it before the sender syncs',
        await p.locator('.task-title',{hasText:'Defrost the freezer'}).count()===0);
  await p2.click('#refresh-btn');
  await p2.waitForTimeout(1500);
  check('after syncing, nothing is waiting', await p2.locator('#sync-badge.hidden').count() === 1);
  await p.click('#refresh-btn');
  await p.waitForSelector('.task-title:has-text("Defrost the freezer")', { timeout: 10000 });
  check('Sync now brings the other person\'s task across', true);

  // Hand the board over. Person 1 created the board, so person 1 owns it.
  await p.click('#open-members');
  await p.waitForTimeout(700);
  const canHand = await p.locator('#member-list [data-makeowner]').count();
  check('the owner is offered "Make owner" for other members', canHand >= 1, `found ${canHand}`);
  check('a member is not offered it', await p2.locator('#member-list [data-makeowner]').count() === 0);

  p.once('dialog', (d) => d.accept());
  await p.click('#member-list [data-makeowner] >> nth=0');
  await p.waitForTimeout(2000);
  check('after handing over, the old owner loses the Make owner action',
        await p.locator('#member-list [data-makeowner]').count() === 0);
  check('and the board settings are hidden from them',
        await p.locator('#danger-block.hidden').count() === 1);

  // Deleting an account is refused while it still owns a shared board.
  await p2.click('.close-x >> nth=0').catch(() => {});
  await p2.keyboard.press('Escape');
  await p2.waitForTimeout(300);
  await p2.click('#open-account');
  await p2.waitForTimeout(600);
  let alerted = '';
  p2.on('dialog', async (d) => {
    if (d.type() === 'confirm') { await d.accept(); }
    else { alerted = d.message(); await d.accept(); }
  });
  await p2.click('#delete-account');
  await p2.waitForTimeout(2500);
  check('deleting an account that owns a shared board is refused, with a reason',
        /still own/i.test(alerted), alerted || '(no dialog)');

  // Scanning the QR opens a ?join= link. New person: sign up, land on the board.
  await p.keyboard.press('Escape');
  const ctx3 = await b.newContext({ viewport: { width: 430, height: 932 } }); await ctx3.addInitScript(AUTO_NOT_NOW);
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errs.push('p3 pageerror: ' + e.message));
  await p3.goto(`${BASE}/?join=${code.trim()}`);
  await p3.waitForTimeout(800);
  check('an invite link opens straight on Create account',
        await p3.getAttribute('#tab-signup', 'aria-selected') === 'true');
  check('the URL is cleaned up', !p3.url().includes('join='), p3.url());
  await p3.fill('[name=name]', 'Scanned Person');
  await p3.fill('#auth-form [name=email]', `scan.${s}@demo.com`);
  await p3.fill('#auth-form [name=password]', 'homeboard123');
  await p3.click('#auth-submit');
  await p3.waitForSelector('#app-screen:not(.hidden)', { timeout: 15000 });
  await p3.waitForTimeout(2500);
  check('and they join the board automatically after signing up',
        (await p3.textContent('#board-name')).includes('Flat 3B'),
        await p3.textContent('#board-name'));

  console.log(`\n  js errors: ${errs.length? JSON.stringify(errs,null,2):'none'}`);
  console.log(`\n${fail===0?'\x1b[32m':'\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  await b.close();
  process.exit(fail===0 && errs.length===0 ?0:1);
})();
