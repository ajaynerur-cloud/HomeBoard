'use strict';
/**
 * Push notifications that arrive with HomeBoard closed.
 *
 * Reminders are scheduled on the phone, but a task someone else has just put
 * on your plate is news the phone cannot know about — the server has to tell
 * it. Two channels, used together:
 *
 *   web  — Web Push (VAPID). Works for the installed PWA and any browser that
 *          supports it. The service worker is woken by the browser to show the
 *          notification, so the tab does not need to be open.
 *          Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or are generated
 *          once and kept in the private data repo so they survive redeploys.
 *
 *   fcm  — Firebase Cloud Messaging, for the Android APK. The WebView inside the
 *          APK cannot do Web Push, so the app registers a native FCM token.
 *          Needs FCM_SERVICE_ACCOUNT (the service-account JSON, raw or base64).
 *          Without it, FCM tokens are stored but nothing is sent to them.
 *
 * Everything is best-effort: a failed push never fails the request that caused
 * it, and subscriptions the push service says are gone are pruned.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const store = require('./store');

const COLLECTION = 'push';
const MAX_DEVICES_PER_USER = 10;
const CHANNEL_ID = 'homeboard-tasks';

/* ───────────── VAPID ───────────── */

let vapid = null;

async function initVapid() {
  let publicKey = process.env.VAPID_PUBLIC_KEY || '';
  let privateKey = process.env.VAPID_PRIVATE_KEY || '';

  if (!publicKey || !privateKey) {
    const rows = await store.read(COLLECTION);
    const saved = rows.find((r) => r.type === 'vapid');
    if (saved) {
      ({ publicKey, privateKey } = saved);
    } else {
      const keys = webpush.generateVAPIDKeys();
      await store.update(COLLECTION, (all) => {
        // Another instance may have beaten us to it.
        const existing = all.find((r) => r.type === 'vapid');
        if (existing) { keys.publicKey = existing.publicKey; keys.privateKey = existing.privateKey; return; }
        all.push({ type: 'vapid', id: 'vapid', ...keys, createdAt: new Date().toISOString() });
      }, 'HomeBoard: web push keys');
      ({ publicKey, privateKey } = keys);
    }
  }

  const subject = process.env.VAPID_SUBJECT || 'mailto:homeboard@example.com';
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapid = { publicKey };
}

/* ───────────── FCM (HTTP v1) ───────────── */

function loadServiceAccount() {
  const raw = (process.env.FCM_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const sa = JSON.parse(text);
    if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('missing fields');
    return sa;
  } catch (err) {
    console.error('[HomeBoard] FCM_SERVICE_ACCOUNT is not a valid service-account JSON:', err.message);
    return null;
  }
}

const serviceAccount = loadServiceAccount();
// Overridable only so the test suite can stand in for Google.
const TOKEN_URL = process.env.FCM_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const FCM_BASE = process.env.FCM_API_BASE || 'https://fcm.googleapis.com';
let fcmToken = { value: null, expires: 0 };

async function fcmAccessToken() {
  if (fcmToken.value && Date.now() < fcmToken.expires - 60000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    serviceAccount.private_key,
    { algorithm: 'RS256' }
  );
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`FCM auth failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  fcmToken = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return fcmToken.value;
}

/** Returns 'ok', 'gone' (token dead — prune it) or 'error'. */
async function sendFcm(token, msg) {
  const access = await fcmAccessToken();
  const data = Object.fromEntries(Object.entries(msg.data || {}).map(([k, v]) => [k, String(v)]));
  const res = await fetch(
    `${FCM_BASE}/v1/projects/${serviceAccount.project_id}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          // A "notification" message is drawn by Android itself when the app is
          // closed or killed — no app code needs to run for it to appear.
          notification: { title: msg.title, body: msg.body },
          data,
          android: {
            priority: 'HIGH',
            notification: {
              channel_id: CHANNEL_ID,
              tag: data.taskId || undefined,
              default_sound: true,
              default_vibrate_timings: true,
              notification_priority: 'PRIORITY_MAX',
              visibility: 'PUBLIC',
            },
          },
        },
      }),
    }
  );
  if (res.ok) return 'ok';
  const text = await res.text();
  if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(text)) return 'gone';
  console.warn(`[HomeBoard] FCM send failed (${res.status}): ${text.slice(0, 200)}`);
  return 'error';
}

/* ───────────── devices ───────────── */

const deviceKey = (d) =>
  crypto.createHash('sha256').update(d.kind === 'web' ? d.subscription.endpoint : d.token).digest('hex').slice(0, 24);

function validWebSubscription(s) {
  return (
    s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1024 &&
    s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string'
  );
}

/** Save (or refresh) a device for a user. One device belongs to one user at a time. */
async function addDevice(userId, input) {
  let device;
  if (input?.kind === 'web') {
    if (!validWebSubscription(input.subscription)) return { error: 'That push subscription is not valid.' };
    const { endpoint, keys } = input.subscription;
    device = { kind: 'web', subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } };
  } else if (input?.kind === 'fcm') {
    const token = String(input.token || '');
    if (token.length < 20 || token.length > 4096) return { error: 'That device token is not valid.' };
    device = { kind: 'fcm', token };
  } else {
    return { error: 'Unknown device kind.' };
  }

  const id = deviceKey(device);
  const now = new Date().toISOString();
  await store.update(COLLECTION, (rows) => {
    // A phone handed from one person to another must stop getting the old
    // owner's tasks, so the device moves rather than being duplicated.
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].type === 'device' && rows[i].id === id) rows.splice(i, 1);
    rows.push({ type: 'device', id, userId, ...device, createdAt: now });
    const mine = rows.filter((r) => r.type === 'device' && r.userId === userId);
    if (mine.length > MAX_DEVICES_PER_USER) {
      const drop = new Set(mine.slice(0, mine.length - MAX_DEVICES_PER_USER).map((r) => r.id));
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].type === 'device' && drop.has(rows[i].id)) rows.splice(i, 1);
    }
  }, 'HomeBoard: push device registered');
  return { id };
}

async function removeDevices(predicate, message) {
  const rows = await store.read(COLLECTION);
  if (!rows.some((r) => r.type === 'device' && predicate(r))) return;
  await store.update(COLLECTION, (all) => {
    for (let i = all.length - 1; i >= 0; i--) if (all[i].type === 'device' && predicate(all[i])) all.splice(i, 1);
  }, message);
}

async function removeDevice(userId, input) {
  const key =
    input?.kind === 'web' && input.subscription?.endpoint ? deviceKey({ kind: 'web', subscription: input.subscription })
    : input?.kind === 'fcm' && input.token ? deviceKey({ kind: 'fcm', token: String(input.token) })
    : null;
  if (!key) return;
  await removeDevices((r) => r.id === key && r.userId === userId, 'HomeBoard: push device removed');
}

const removeUser = (userId) => removeDevices((r) => r.userId === userId, 'HomeBoard: push devices removed with account');

/* ───────────── sending ───────────── */

/**
 * Send one notification to every device a user has. Never throws.
 * Resolves to { sent, failed, pruned } — handy for tests and logs.
 */
async function sendToUser(userId, msg) {
  const out = { sent: 0, failed: 0, pruned: 0 };
  try {
    const devices = (await store.read(COLLECTION)).filter((r) => r.type === 'device' && r.userId === userId);
    const dead = new Set();

    await Promise.all(devices.map(async (d) => {
      try {
        if (d.kind === 'web') {
          await webpush.sendNotification(d.subscription, JSON.stringify(msg), { TTL: 24 * 60 * 60, urgency: 'high', topic: msg.data?.taskId?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined });
          out.sent++;
        } else if (d.kind === 'fcm') {
          if (!serviceAccount) { out.failed++; return; }
          const r = await sendFcm(d.token, msg);
          if (r === 'ok') out.sent++;
          else if (r === 'gone') dead.add(d.id);
          else out.failed++;
        }
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) dead.add(d.id);
        else { out.failed++; console.warn('[HomeBoard] push failed:', err.statusCode || '', err.body || err.message); }
      }
    }));

    if (dead.size) {
      out.pruned = dead.size;
      await removeDevices((r) => dead.has(r.id), 'HomeBoard: expired push devices pruned');
    }
  } catch (err) {
    console.warn('[HomeBoard] push fan-out failed:', err.message);
  }
  return out;
}

/** "Alice put a task on your plate." Skips people assigning to themselves. */
function notifyAssigned(task, { byUser, projectName, reassigned = false } = {}) {
  if (!task?.assigneeId || task.assigneeId === byUser?.id) return Promise.resolve(null);
  const who = byUser?.name?.split(/\s+/)[0] || 'Someone';
  return sendToUser(task.assigneeId, {
    title: reassigned ? `${who} handed you a task` : `New task from ${who}`,
    body: `${task.title}${projectName ? ` — ${projectName}` : ''}`,
    data: {
      kind: 'task-assigned',
      taskId: task.id,
      projectId: task.projectId,
      dueAt: task.dueAt || '',
      priority: task.priority || 'normal',
    },
  });
}

async function init() {
  await initVapid();
  return { web: true, fcm: Boolean(serviceAccount) };
}

const config = () => ({ webPublicKey: vapid?.publicKey || null, fcm: Boolean(serviceAccount), channelId: CHANNEL_ID });

module.exports = { init, config, addDevice, removeDevice, removeUser, sendToUser, notifyAssigned, COLLECTION, CHANNEL_ID };
