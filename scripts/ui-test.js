/*
 * Browser walk-through of the whole UI.
 *   npm i --no-save playwright && npx playwright install chromium
 *   npm start & node scripts/ui-test.js [baseUrl]
 */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000';
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
  const p=await ctx.newPage();
  const errs=[];
  p.on('pageerror',e=>errs.push('pageerror: '+e.message));
  p.on('console',m=>{const t=m.text(); if(m.type()==='error' && !t.includes('ERR_TUNNEL')) errs.push('console: '+t)});

  const s=Date.now();
  const email=`ui.${s}@demo.com`;

  console.log('\nUI flow\n');
  await p.goto(BASE);
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

  await p.click('.task-body');
  await p.waitForTimeout(600);
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
  await p.waitForTimeout(1500);
  check('task gone from the board', await p.locator('.task').count() === 0);

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

  const p2 = await (await b.newContext({viewport:{width:430,height:932}})).newPage();
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

  await p.reload();
  await p.waitForTimeout(1600);
  check('lands on the other person\'s "For me"', await p.locator('.task-title',{hasText:'Call the plumber'}).count()>0);

  // tick from the card
  await p.click('.tick');
  await p.waitForTimeout(1600);
  check('one-tap complete from the card works', await p.locator('.task').count()===0);

  console.log(`\n  js errors: ${errs.length? JSON.stringify(errs,null,2):'none'}`);
  console.log(`\n${fail===0?'\x1b[32m':'\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  await b.close();
  process.exit(fail===0 && errs.length===0 ?0:1);
})();
