#!/usr/bin/env node
/**
 * New-task push, end to end, with no browser and no Google.
 *
 * Boots a real HomeBoard server on local storage, stands up a fake push
 * service over HTTPS, and plays the part of a browser: it makes real P-256
 * keys, subscribes, and DECRYPTS what the server sends — so a pass means a
 * real browser would have shown the notification.
 *
 *   npm run test:push
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const ece = require('http_ece');

let passed = 0, failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A self-signed cert for the fake push service. */
function selfSigned(dir) {
  const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
  require('child_process').execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-push-'));
  const PUSH_PORT = 3555, APP_PORT = 3556;

  /* The fake push service: records deliveries; /gone/* answers 410 like an expired subscription. */
  const deliveries = [];
  const fcmCalls = [];
  const { publicKey: saPub, privateKey: saPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccount = {
    type: 'service_account', project_id: 'homeboard-test', client_email: 'push@homeboard-test.iam.gserviceaccount.com',
    private_key: saPriv.export({ type: 'pkcs8', format: 'pem' }),
  };
  const pushServer = https.createServer(selfSigned(tmp), (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/token') {
        const assertion = new URLSearchParams(Buffer.concat(chunks).toString()).get('assertion');
        try {
          require('jsonwebtoken').verify(assertion, saPub, { algorithms: ['RS256'] });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'fake-google-token', expires_in: 3600 }));
        } catch { res.writeHead(401); res.end('{}'); }
        return;
      }
      if (req.url.startsWith('/v1/projects/')) {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        fcmCalls.push({ url: req.url, auth: req.headers.authorization, body });
        if (body.message.token.startsWith('dead')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
        } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"name":"x"}'); }
        return;
      }
      if (req.url.startsWith('/gone/')) { res.writeHead(410); res.end(); return; }
      deliveries.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201); res.end();
    });
  });
  await new Promise((r) => pushServer.listen(PUSH_PORT, r));

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      GITHUB_TOKEN: '', DATA_REPO: '',
      NODE_ENV: 'test',
      NODE_TLS_REJECT_UNAUTHORIZED: '0', // only for the fake push service's cert
      ...(process.env.HB_TEST_FCM ? {
        FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(serviceAccount)).toString('base64'),
        FCM_TOKEN_URL: `https://localhost:${PUSH_PORT}/token`,
        FCM_API_BASE: `https://localhost:${PUSH_PORT}`,
      } : {}),
      NODE_OPTIONS: '--no-warnings',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));

  const BASE = `http://localhost:${APP_PORT}/api`;
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const res = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {}; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };

  try {
    for (let i = 0; i < 50; i++) { try { if ((await call('/health')).status === 200) break; } catch {} await sleep(150); }

    console.log('\nHomeBoard push test\n');
    const health = await call('/health');
    check('server is up and reports web push', health.data?.push?.web === true, JSON.stringify(health.data));
    check('startup log says whether Android push is on', /push: web on/.test(log), log);

    const cfg = await call('/push/config');
    check('config hands out a VAPID public key', typeof cfg.data.webPublicKey === 'string' && cfg.data.webPublicKey.length > 80);
    check('config never leaks the private key', !JSON.stringify(cfg.data).toLowerCase().includes('private'));

    const stamp = Date.now();
    const mk = async (name) => {
      const r = await call('/auth/signup', { method: 'POST', body: { name, email: `${name.toLowerCase()}.${stamp}@example.com`, password: 'household123' } });
      return { token: r.data.token, user: r.data.user };
    };
    const alice = await mk('Alice');
    const bob = await mk('Bob');

    const board = (await call('/projects', { method: 'POST', token: alice.token, body: { name: 'Flat 4' } })).data.project;
    await call(`/projects/${board.id}/invite`, { method: 'POST', token: alice.token, body: { email: bob.user.email } });
    const onBoard = (await call('/projects', { token: bob.token })).data.projects.some((p) => p.id === board.id);
    if (!onBoard) {
      await call('/projects/join', { method: 'POST', token: bob.token, body: { code: board.inviteCode } });
    }

    /* Bob's "browser": real keys, like PushManager.subscribe() would make. */
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const b64u = (b) => b.toString('base64url');
    const bobSub = { endpoint: `https://localhost:${PUSH_PORT}/send/bob-phone`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(authSecret) } };

    const noAuth = await call('/push/subscribe', { method: 'POST', body: { kind: 'web', subscription: bobSub } });
    check('subscribing needs sign-in', noAuth.status === 401);
    const badSub = await call('/push/subscribe', { method: 'POST', token: bob.token, body: { kind: 'web', subscription: { endpoint: 'http://evil', keys: {} } } });
    check('a malformed subscription is refused', badSub.status === 400);
    const sub = await call('/push/subscribe', { method: 'POST', token: bob.token, body: { kind: 'web', subscription: bobSub } });
    check('Bob subscribes this device', sub.status === 201, JSON.stringify(sub.data));
    // Subscribing twice must not double up notifications.
    await call('/push/subscribe', { method: 'POST', token: bob.token, body: { kind: 'web', subscription: bobSub } });

    const decrypt = (d) => JSON.parse(ece.decrypt(d.body, { version: 'aes128gcm', privateKey: ecdh, authSecret }).toString('utf8'));

    /* The main event: Alice pushes a task to Bob. */
    deliveries.length = 0;
    const t0 = Date.now();
    const created = await call('/tasks', { method: 'POST', token: alice.token, body: { projectId: board.id, title: 'Take the bins out', assigneeId: bob.user.id, priority: 'high', dueAt: new Date(Date.now() + 3600e3).toISOString() } });
    check('Alice creates a task for Bob', created.status === 201);
    for (let i = 0; i < 40 && !deliveries.length; i++) await sleep(50);
    check('a push reached Bob\'s device as soon as the task was added', deliveries.length === 1, `deliveries: ${deliveries.length}`);
    check(`…within ${Date.now() - t0} ms`, Date.now() - t0 < 2000);

    if (deliveries[0]) {
      const d = deliveries[0];
      check('sent with high urgency', d.headers.urgency === 'high');
      check('signed with VAPID', /^vapid t=/.test(d.headers.authorization || ''));
      check('kept for a day if the phone is offline', Number(d.headers.ttl) >= 3600);
      let msg = null;
      try { msg = decrypt(d); } catch (e) { check('payload decrypts with Bob\'s keys', false, e.message); }
      if (msg) {
        check('payload decrypts with Bob\'s keys', true);
        check('title names who sent it', msg.title === 'New task from Alice', msg.title);
        check('body names the task and board', msg.body === 'Take the bins out — Flat 4', msg.body);
        check('carries the task id so tapping opens it', msg.data?.taskId === created.data.task.id);
        check('carries the priority', msg.data?.priority === 'high');
      }
    }

    /* Assigning to yourself is not news. */
    deliveries.length = 0;
    await call('/tasks', { method: 'POST', token: bob.token, body: { projectId: board.id, title: 'Buy milk' } });
    await sleep(400);
    check('no push when you add a task for yourself', deliveries.length === 0);

    /* A task Alice keeps, then hands to Bob. */
    const mine = (await call('/tasks', { method: 'POST', token: alice.token, body: { projectId: board.id, title: 'Call the landlord' } })).data.task;
    await sleep(300);
    deliveries.length = 0;
    await call(`/tasks/${mine.id}`, { method: 'PATCH', token: alice.token, body: { assigneeId: bob.user.id } });
    for (let i = 0; i < 40 && !deliveries.length; i++) await sleep(50);
    check('handing a task to someone pushes to them', deliveries.length === 1);
    if (deliveries[0]) check('…and says it was handed over', decrypt(deliveries[0]).title === 'Alice handed you a task');

    deliveries.length = 0;
    await call(`/tasks/${mine.id}`, { method: 'PATCH', token: alice.token, body: { title: 'Call the landlord today' } });
    await sleep(400);
    check('editing without reassigning does not push again', deliveries.length === 0);

    /* Test button. */
    deliveries.length = 0;
    const test = await call('/push/test', { method: 'POST', token: bob.token });
    check('"Send me a test" delivers', test.data.sent === 1 && deliveries.length === 1, JSON.stringify(test.data));

    /* An expired subscription is pruned, not retried forever. */
    const ecdh2 = crypto.createECDH('prime256v1'); ecdh2.generateKeys();
    await call('/push/subscribe', { method: 'POST', token: bob.token, body: { kind: 'web', subscription: { endpoint: `https://localhost:${PUSH_PORT}/gone/old-laptop`, keys: { p256dh: b64u(ecdh2.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } } } });
    const both = await call('/push/test', { method: 'POST', token: bob.token });
    check('with a dead device too, the live one still gets it', both.data.sent === 1, JSON.stringify(both.data));
    check('the dead device is pruned', both.data.pruned === 1);
    const after = await call('/push/test', { method: 'POST', token: bob.token });
    check('…and not tried again', after.data.pruned === 0 && after.data.sent === 1);

    /* Signing out on that device stops it. */
    await call('/push/unsubscribe', { method: 'POST', token: bob.token, body: { kind: 'web', subscription: bobSub } });
    deliveries.length = 0;
    await call('/tasks', { method: 'POST', token: alice.token, body: { projectId: board.id, title: 'Water plants', assigneeId: bob.user.id } });
    await sleep(400);
    check('after unsubscribing, nothing is sent to that device', deliveries.length === 0);

    /* A phone passed to someone else follows the new account. */
    await call('/push/subscribe', { method: 'POST', token: bob.token, body: { kind: 'web', subscription: bobSub } });
    await call('/push/subscribe', { method: 'POST', token: alice.token, body: { kind: 'web', subscription: bobSub } });
    deliveries.length = 0;
    await call('/tasks', { method: 'POST', token: alice.token, body: { projectId: board.id, title: 'Hoover', assigneeId: bob.user.id } });
    await sleep(400);
    check('a device that changed hands stops getting the old owner\'s tasks', deliveries.length === 0);

    const fcm = await call('/push/subscribe', { method: 'POST', token: bob.token, body: { kind: 'fcm', token: 'f'.repeat(160) } });
    check('an Android FCM token is accepted', fcm.status === 201);

    if (!process.env.HB_TEST_FCM) {
      const fcmTest = await call('/push/test', { method: 'POST', token: bob.token });
      check('without FCM_SERVICE_ACCOUNT it is counted as not sent, not an error', fcmTest.status === 200 && fcmTest.data.failed === 1);
    } else {
      console.log('\n  Android (FCM, Google stood in for)');
      check('health reports Android push on', (await call('/health')).data.push.fcm === true);
      fcmCalls.length = 0;
      const t = (await call('/tasks', { method: 'POST', token: alice.token, body: { projectId: board.id, title: 'Feed the cat', assigneeId: bob.user.id } })).data.task;
      for (let i = 0; i < 40 && !fcmCalls.length; i++) await sleep(50);
      const c = fcmCalls[0];
      check('a new task goes to Bob\'s phone through FCM', Boolean(c));
      if (c) {
        check('authenticated with a Google token from the service account', c.auth === 'Bearer fake-google-token');
        check('sent to the right Firebase project', c.url === '/v1/projects/homeboard-test/messages:send');
        check('a notification message — Android draws it with the app killed', c.body.message.notification?.title === 'New task from Alice');
        check('high priority, so Doze does not hold it back', c.body.message.android.priority === 'HIGH');
        check('on the HomeBoard channel', c.body.message.android.notification.channel_id === 'homeboard-tasks');
        check('carries the task id', c.body.message.data.taskId === t.id);
        check('all data values are strings (FCM rejects anything else)', Object.values(c.body.message.data).every((v) => typeof v === 'string'));
      }
      await call('/push/subscribe', { method: 'POST', token: bob.token, body: { kind: 'fcm', token: 'dead' + 'x'.repeat(100) } });
      const r = await call('/push/test', { method: 'POST', token: bob.token });
      check('an uninstalled app\'s token is pruned', r.data.pruned === 1 && r.data.sent === 1, JSON.stringify(r.data));
    }

    /* Deleting the account removes its devices. */
    await call('/auth/me', { method: 'DELETE', token: bob.token });
    const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.data', 'push.json'), 'utf8'));
    check('deleting the account deletes its devices', !rows.some((r) => r.userId === bob.user.id));
  } finally {
    // Wait for both to let go of their ports, so back-to-back runs don't collide.
    await new Promise((r) => { server.once('exit', r); server.kill(); });
    await new Promise((r) => pushServer.close(r));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
