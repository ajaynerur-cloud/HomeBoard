#!/usr/bin/env node
/**
 * End-to-end check of the HomeBoard API.
 * Boots nothing — point it at a running server:  node scripts/smoke-test.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:3000';

let passed = 0, failed = 0;
const ok = (label) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); };
const bad = (label, detail) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}\n      ${detail}`); };

function check(label, condition, detail = '') {
  condition ? ok(label) : bad(label, detail);
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  const stamp = Date.now();
  const alice = { name: 'Alice Tester', email: `alice.${stamp}@example.com`, password: 'household123' };
  const bob   = { name: 'Bob Tester',   email: `bob.${stamp}@example.com`,   password: 'household123' };

  console.log(`\nHomeBoard smoke test → ${BASE}\n`);

  console.log('Health');
  const health = await call('/health');
  check('server is up', health.status === 200 && health.data.ok, JSON.stringify(health.data));
  console.log(`  storage backend: ${health.data.storage}`);

  console.log('\nAccounts');
  const a = await call('/auth/signup', { method: 'POST', body: alice });
  check('Alice can sign up', a.status === 201 && a.data.token, JSON.stringify(a.data));
  const b = await call('/auth/signup', { method: 'POST', body: bob });
  check('Bob can sign up', b.status === 201 && b.data.token, JSON.stringify(b.data));

  const dupe = await call('/auth/signup', { method: 'POST', body: alice });
  check('duplicate email is rejected', dupe.status === 409, `got ${dupe.status}`);

  const wrongPw = await call('/auth/signin', { method: 'POST', body: { email: alice.email, password: 'nope' } });
  check('wrong password is rejected', wrongPw.status === 401, `got ${wrongPw.status}`);

  const signin = await call('/auth/signin', { method: 'POST', body: { email: alice.email, password: alice.password } });
  check('Alice can sign in', signin.status === 200 && signin.data.token, JSON.stringify(signin.data));

  const A = a.data.token, B = b.data.token;
  const aliceId = a.data.user.id, bobId = b.data.user.id;

  const anon = await call('/projects');
  check('anonymous requests are blocked', anon.status === 401, `got ${anon.status}`);

  console.log('\nBoards and invites');
  const proj = await call('/projects', { method: 'POST', token: A, body: { name: 'Flat 3B' } });
  check('Alice creates a board', proj.status === 201, JSON.stringify(proj.data));
  const P = proj.data.project;
  check('creator is the owner', P.ownerId === aliceId);
  check('board has a join code', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(P.inviteCode), P.inviteCode);

  const bobSees = await call('/projects', { token: B });
  check('Bob cannot see a board he is not on', bobSees.data.projects.length === 0);

  const invite = await call(`/projects/${P.id}/invite`, { method: 'POST', token: A, body: { email: bob.email } });
  check('Alice invites Bob by email', invite.status === 200 && invite.data.added?.id === bobId, JSON.stringify(invite.data));

  const bobSees2 = await call('/projects', { token: B });
  check('Bob now sees the board', bobSees2.data.projects.some((p) => p.id === P.id));

  console.log('\nPushing a task to someone else');
  const task = await call('/tasks', {
    method: 'POST', token: A,
    body: {
      projectId: P.id, title: 'Take the bins out', assigneeId: bobId,
      details: 'Green bin this week. Gate code is 4412.',
      priority: 'high',
      dueAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
      checklist: [{ text: 'Green bin to kerb' }, { text: 'Rinse the recycling' }],
    },
  });
  check('Alice assigns a task to Bob', task.status === 201, JSON.stringify(task.data));
  const T = task.data.task;
  check('task carries details', T.details.includes('4412'));
  check('checklist saved with ids', T.checklist.length === 2 && T.checklist[0].id?.startsWith('chk_'));
  check('assignee resolved for the UI', T.assignee?.name === bob.name);

  const bobTasks = await call('/tasks', { token: B });
  check('the task appears on Bob\'s list', bobTasks.data.tasks.some((t) => t.id === T.id));

  const note = await call(`/tasks/${T.id}/comments`, { method: 'POST', token: B, body: { text: 'On it after dinner' } });
  check('Bob can add a note', note.status === 200 && note.data.task.comments.length === 1);

  console.log('\nSecurity boundaries');
  const outsider = await call('/auth/signup', {
    method: 'POST', body: { name: 'Mallory', email: `mal.${stamp}@example.com`, password: 'household123' },
  });
  const M = outsider.data.token;
  const peek = await call(`/tasks/${T.id}`, { method: 'PATCH', token: M, body: { title: 'hijacked' } });
  check('a non-member cannot edit the task', peek.status === 403 || peek.status === 404, `got ${peek.status}`);
  const badAssign = await call(`/tasks/${T.id}`, { method: 'PATCH', token: A, body: { assigneeId: outsider.data.user.id } });
  check('cannot assign to someone off the board', badAssign.status === 400, `got ${badAssign.status}`);

  console.log('\nCompleting purges the details');
  const done = await call(`/tasks/${T.id}/complete`, { method: 'POST', token: B });
  check('Bob marks it done', done.status === 200 && done.data.purged, JSON.stringify(done.data));

  const after = await call('/tasks', { token: A });
  check('task row is gone', !after.data.tasks.some((t) => t.id === T.id));

  const hist = await call('/tasks/history/list', { token: A });
  const entry = hist.data.history.find((h) => h.title === 'Take the bins out');
  check('history keeps the name', Boolean(entry));
  check('history keeps who finished it', entry?.completedBy?.id === bobId);
  check('history holds NO details', entry && !('details' in entry) && !('checklist' in entry) && !('comments' in entry),
        JSON.stringify(entry));

  console.log('\nJoin by code');
  const carol = await call('/auth/signup', {
    method: 'POST', body: { name: 'Carol', email: `carol.${stamp}@example.com`, password: 'household123' },
  });
  const join = await call('/projects/join', { method: 'POST', token: carol.data.token, body: { code: P.inviteCode } });
  check('Carol joins with the code', join.status === 200 && join.data.project.id === P.id, JSON.stringify(join.data));
  const badJoin = await call('/projects/join', { method: 'POST', token: carol.data.token, body: { code: 'ZZZZ-9999' } });
  check('a bad code is refused', badJoin.status === 404, `got ${badJoin.status}`);

  console.log('\nUndo a completion');
  const t2 = await call('/tasks', {
    method: 'POST', token: A,
    body: { projectId: P.id, title: 'Defrost the freezer', assigneeId: aliceId, details: 'Towels are under the sink.' },
  });
  const done2 = await call(`/tasks/${t2.data.task.id}/complete`, { method: 'POST', token: A });
  check('completion hands the task back for undo', Boolean(done2.data.undo?.id), JSON.stringify(done2.data).slice(0, 120));
  const restored = await call('/tasks/restore', {
    method: 'POST', token: A,
    body: { task: done2.data.undo, historyId: done2.data.history.id },
  });
  check('undo puts the task back', restored.status === 200, JSON.stringify(restored.data).slice(0, 120));
  const afterUndo = await call('/tasks', { token: A });
  const back = afterUndo.data.tasks.find((t) => t.id === t2.data.task.id);
  check('restored task keeps its details', back?.details.includes('under the sink'));
  const histAfter = await call('/tasks/history/list', { token: A });
  check('undo removes the history line', !histAfter.data.history.some((h) => h.id === done2.data.history.id));
  const doubleUndo = await call('/tasks/restore', { method: 'POST', token: A, body: { task: done2.data.undo } });
  check('undo twice is refused', doubleUndo.status === 409, `got ${doubleUndo.status}`);
  await call(`/tasks/${t2.data.task.id}`, { method: 'DELETE', token: A });

  console.log('\nHanding the board over');
  const notOwner = await call(`/projects/${P.id}/transfer-owner`, { method: 'POST', token: B, body: { userId: bobId } });
  check('a member cannot take ownership', notOwner.status === 403, `got ${notOwner.status}`);
  const toStranger = await call(`/projects/${P.id}/transfer-owner`, { method: 'POST', token: A, body: { userId: outsider.data.user.id } });
  check('cannot hand it to someone off the board', toStranger.status === 400, `got ${toStranger.status}`);
  const handed = await call(`/projects/${P.id}/transfer-owner`, { method: 'POST', token: A, body: { userId: bobId } });
  check('owner hands the board to Bob', handed.status === 200, JSON.stringify(handed.data).slice(0, 120));
  check('Bob is recorded as owner', handed.data.project.ownerId === bobId);
  check('Alice is demoted to member',
        handed.data.project.members.find((m) => m.userId === aliceId)?.role === 'member');
  const aliceTries = await call(`/projects/${P.id}`, { method: 'PATCH', token: A, body: { name: 'nope' } });
  check('the old owner loses owner powers', aliceTries.status === 403, `got ${aliceTries.status}`);

  console.log('\nDeleting an account');
  const blocked = await call('/auth/me', { method: 'DELETE', token: B });
  check('cannot delete while owning a shared board', blocked.status === 409, `got ${blocked.status}`);
  check('the refusal names the board', /Flat 3B/.test(blocked.data.error || ''), blocked.data.error);

  const solo = await call('/auth/signup', {
    method: 'POST', body: { name: 'Solo', email: `solo.${stamp}@example.com`, password: 'household123' },
  });
  const soloBoard = await call('/projects', { method: 'POST', token: solo.data.token, body: { name: 'Just me' } });
  await call('/tasks', { method: 'POST', token: solo.data.token, body: { projectId: soloBoard.data.project.id, title: 'Water the plants' } });
  const gone = await call('/auth/me', { method: 'DELETE', token: solo.data.token });
  check('an account with only solo boards deletes', gone.status === 200 && gone.data.boardsDeleted === 1, JSON.stringify(gone.data));
  const ghost = await call('/auth/me', { token: solo.data.token });
  check('the deleted account can no longer sign in', ghost.status === 401, `got ${ghost.status}`);
  const reSignin = await call('/auth/signin', { method: 'POST', body: { email: `solo.${stamp}@example.com`, password: 'household123' } });
  check('and its password no longer works', reSignin.status === 401, `got ${reSignin.status}`);

  console.log('\nCleanup');
  const del = await call(`/projects/${P.id}`, { method: 'DELETE', token: A });
  check('a non-owner cannot delete the board', del.status === 403, `got ${del.status}`);
  const del2 = await call(`/projects/${P.id}`, { method: 'DELETE', token: B });
  check('the new owner can delete the board', del2.status === 200);

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nSmoke test crashed:', err.message);
  process.exit(1);
});
