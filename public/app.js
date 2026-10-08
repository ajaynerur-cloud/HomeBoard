/* HomeBoard — front end. No build step, no framework. */
(() => {
'use strict';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ───────────────────────── state ───────────────────────── */

const state = {
  user: null,
  projects: [],
  activeId: localStorage.getItem('hb.board') || null,
  tasks: [],
  history: [],
  view: 'mine',
  editing: null,     // task being edited, or null for a new one
  detailId: null,
  draftChecks: [],
};

const activeProject = () =>
  state.projects.find((p) => p.id === state.activeId) || state.projects[0] || null;

/* ───────────────────────── api ───────────────────────── */

const TOKEN_KEY = 'hb.token';
const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

/**
 * Where the API lives. Empty string on the web (same origin as the page).
 * On Android the page is served from https://localhost inside the APK, so the
 * build writes the live server URL into config.js and we use that instead.
 */
const API_BASE = (window.HOMEBOARD_API || '').replace(/\/+$/, '');

/**
 * Free hosting sleeps after 15 minutes idle and takes up to a minute to come
 * back. While that happens the platform answers with its own holding page —
 * an HTML body and a gateway status — rather than our JSON. We retry through
 * it behind our own waking screen so nobody ever sees someone else's.
 */
const WAKE_DEADLINE_MS = 90000;
const RETRY_STATUS = new Set([408, 502, 503, 504]);
const BACKOFF = [800, 1500, 2500, 4000, 6000, 8000, 10000, 12000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `background: true` is for sync — no full-screen waking overlay (the sync
 * button spins instead), so working from the local copy is never blocked.
 * Errors carry `.status` (server said no) or `.offline` (never got an answer),
 * which is how sync tells "drop this change" from "try again later".
 */
function apiError(message, extra) { return Object.assign(new Error(message), extra); }

async function api(path, { method = 'GET', body, background = false, noSession = false } = {}) {
  if (navigator.onLine === false) {
    throw apiError('You are offline. Your changes are kept on this device until you sync.', { offline: true });
  }
  // Signed in on the phone only (fingerprint or remembered password): get the
  // server session now, the first time something actually needs the server.
  if (!noSession) await ensureSession();
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const device = localStorage.getItem('hb.pushDevice');
  if (device) headers['X-HB-Device'] = device;

  const started = Date.now();
  let attempt = 0;
  let lastReason = '';

  for (;;) {
    let res = null;
    let transient = false;

    try {
      res = await fetch(`${API_BASE}/api${path}`, {
        method,
        headers,
        credentials: API_BASE ? 'omit' : 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      transient = true;
      lastReason = 'the server did not answer';
    }

    if (res) {
      // A gateway status, or an HTML body where JSON belongs, means the request
      // never reached our code — it was the host's holding page. Safe to repeat,
      // even for a POST.
      const type = res.headers.get('content-type') || '';
      const looksLikeJson = type.includes('application/json');
      if (RETRY_STATUS.has(res.status) || (!looksLikeJson && !res.ok)) {
        transient = true;
        lastReason = `the server answered ${res.status}`;
      } else if (!looksLikeJson && res.ok) {
        // 200 with a non-JSON body: the request went somewhere that is not our
        // API. Almost always a misconfigured API base in the mobile build.
        throw new Error(
          API_BASE
            ? `The app is pointed at ${API_BASE}, which is not answering as HomeBoard. Rebuild it with the right server URL.`
            : 'The server sent back something unexpected. Try again in a moment.'
        );
      }
    }

    if (transient) {
      const elapsed = Date.now() - started;
      if (elapsed < WAKE_DEADLINE_MS && navigator.onLine !== false) {
        if (!background) showWaking(); else setSyncNote('Waking the server…');
        await sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)]);
        attempt++;
        continue;
      }
      hideWaking();
      throw apiError(
        `Could not reach HomeBoard — ${lastReason}. If it has been asleep a while, give it a moment and try again.`,
        { offline: true }
      );
    }

    hideWaking();

    let data = {};
    try { data = await res.json(); } catch { /* an empty body is fine */ }

    if (res.status === 401 && state.user && !noSession) {
      setToken(null);
      state.user = null;
      showAuth();
      throw apiError(data.error || 'Please sign in again.', { status: 401, auth: true });
    }
    if (!res.ok) throw apiError(data.error || `Something went wrong (${res.status}).`, { status: res.status });
    return data;
  }
}

/*
 * Signing in never waits for the server.
 *
 * A fingerprint, or a password this phone has seen work before, signs you in
 * on the phone and opens the board from the local copy straight away. The
 * server session is fetched afterwards, quietly — just after sign-in, or the
 * first time a sync needs it — so a sleeping Render host is woken *after* you
 * are in, never in front of you.
 */
let sessionGetter = null;   // async () => void — fetches and stores a token
let sessionPromise = null;

async function ensureSession() {
  if (getToken() || !sessionGetter) return;
  if (!sessionPromise) {
    sessionPromise = sessionGetter().finally(() => { sessionPromise = null; });
  }
  await sessionPromise;
}

/** After a local sign-in: fetch the session in the background, never blocking. */
function sessionInBackground() {
  ensureSession().catch((err) => {
    if (err?.status === 401) return; // handled where the credential is
    /* offline or asleep — the next sync tries again */
  });
}

/* Password check on the phone: PBKDF2, never the password itself. */
const PW_KEY = 'hb.pw';
const PW_ITER = 210000;
const enc = (s) => new TextEncoder().encode(s);
async function pwHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(salt), iterations: PW_ITER }, key, 256);
  return bytesToB64(bits);
}
function pwSaved() { try { return JSON.parse(localStorage.getItem(PW_KEY) || 'null'); } catch { return null; } }
async function rememberPassword(email, password, user) {
  if (!crypto?.subtle) return;
  try {
    const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(PW_KEY, JSON.stringify({ email: String(email).trim().toLowerCase(), salt, hash: await pwHash(password, salt), user }));
  } catch { /* no local sign-in next time; the server still works */ }
}
/** The user, if this phone recognises this email + password; otherwise null. */
async function localPasswordCheck(email, password) {
  const saved = pwSaved();
  if (!saved || !crypto?.subtle || saved.email !== String(email).trim().toLowerCase()) return null;
  try { return (await pwHash(password, saved.salt)) === saved.hash ? saved.user : null; } catch { return null; }
}

/* The waking screen — ours, not the host's. */
let wakeShownAt = 0;
function showWaking() {
  const el = $('#waking');
  if (!el || el.classList.contains('show')) return;
  wakeShownAt = Date.now();
  el.classList.add('show');
}
function hideWaking() {
  const el = $('#waking');
  if (!el || !el.classList.contains('show')) return;
  // Don't flash it away the instant it appears.
  const held = Math.max(0, 450 - (Date.now() - wakeShownAt));
  setTimeout(() => el.classList.remove('show'), held);
}

/* ───────────────────────── helpers ───────────────────────── */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function avatar(user, cls = '') {
  if (!user) return `<span class="avatar ${cls}" style="background:var(--ink-3)">–</span>`;
  return `<span class="avatar ${cls}" style="background:${esc(user.avatarColor || '#0f766e')}" title="${esc(user.name)}">${esc(initials(user.name))}</span>`;
}

/** "3d left" / "45m left" / "2h overdue" — plus a tone for colouring. */
function remaining(dueAt) {
  if (!dueAt) return { text: 'No deadline', tone: 'mute', ms: Infinity };
  const ms = Date.parse(dueAt) - Date.now();
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  let text;
  if (d >= 1)      text = h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  else if (h >= 1) text = m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  else if (m >= 1) text = `${m}m`;
  else             text = 'under a minute';

  if (ms < 0) return { text: `${text} overdue`, tone: 'danger', ms };
  if (ms < 60 * 60 * 1000) return { text: `${text} left`, tone: 'danger', ms };
  if (ms < 6 * 60 * 60 * 1000) return { text: `${text} left`, tone: 'warn', ms };
  return { text: `${text} left`, tone: 'ok', ms };
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 6) return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (d >= 1) return `${d}d ago`;
  if (h >= 1) return `${h}h ago`;
  if (m >= 1) return `${m}m ago`;
  return 'just now';
}

/** <input type="datetime-local"> wants local time with no zone suffix. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let toastTimer;
/** `action` is optional: { label, run } puts a button in the toast. */
function toast(message, action = null, ms = null) {
  const el = $('#toast');
  const btn = $('#toast-action');
  $('#toast-text').textContent = message;

  btn.classList.toggle('hidden', !action);
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => {
      el.classList.remove('show');
      clearTimeout(toastTimer);
      action.run();
    };
  } else {
    btn.onclick = null;
  }

  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || (action ? 9000 : 2800));
}

/* ───────────────────────── sheets ───────────────────────── */

let openSheet = null;
function sheet(id) {
  if (openSheet) openSheet.classList.remove('open');
  const el = $(id);
  el.classList.add('open');
  $('#scrim').classList.add('open');
  openSheet = el;
  document.body.style.overflow = 'hidden';
}
let afterSheetClosed = null;
function closeSheet() {
  if (openSheet) openSheet.classList.remove('open');
  $('#scrim').classList.remove('open');
  openSheet = null;
  document.body.style.overflow = '';
  if (afterSheetClosed) { const fn = afterSheetClosed; afterSheetClosed = null; setTimeout(fn, 500); }
}
$('#scrim').addEventListener('click', closeSheet);
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openSheet) closeSheet(); });

/* ───────────────────────── auth screen ───────────────────────── */

let authMode = 'signin';

function setAuthMode(mode) {
  authMode = mode;
  $('#tab-signin').setAttribute('aria-selected', String(mode === 'signin'));
  $('#tab-signup').setAttribute('aria-selected', String(mode === 'signup'));
  $('#name-field').hidden = mode !== 'signup';
  $('#name-field').querySelector('input').required = mode === 'signup';
  $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  $('#auth-form').querySelector('[name=password]').autocomplete =
    mode === 'signup' ? 'new-password' : 'current-password';
  $('#auth-note').textContent =
    mode === 'signup'
      ? 'Got a join code from someone? Create your account, then enter the code on the next screen.'
      : 'New here? Create an account — it takes a few seconds.';
  $('#auth-alert').classList.add('hidden');
  updateBioSignin?.();
}

/* Show / hide the password. Worth having: a mistyped password on a phone
   keyboard is the single most common reason a sign-in fails. */
$('#peek-password').addEventListener('click', () => {
  const btn = $('#peek-password');
  const input = $('#auth-form [name=password]');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.setAttribute('aria-pressed', String(!showing));
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  $('.eye-on', btn).classList.toggle('hidden', !showing);
  $('.eye-off', btn).classList.toggle('hidden', showing);
  input.focus();
});

$('#tab-signin').addEventListener('click', () => setAuthMode('signin'));
$('#tab-signup').addEventListener('click', () => setAuthMode('signup'));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit');
  const alert = $('#auth-alert');
  const fd = new FormData(e.target);
  const payload = {
    email: fd.get('email'),
    password: fd.get('password'),
    ...(authMode === 'signup' ? { name: fd.get('name') } : {}),
  };

  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>';
  alert.classList.add('hidden');

  try {
    // Seen this password work on this phone before? Sign in here and now; the
    // server is asked afterwards, in the background.
    const known = authMode === 'signin' && await localPasswordCheck(payload.email, payload.password);
    if (known?.id) {
      setToken(null);
      state.user = known;
      sessionGetter = async () => {
        try {
          const data = await api('/auth/signin', { method: 'POST', body: payload, background: true, noSession: true });
          if (data?.token) { setToken(data.token); if (state.user?.id === data.user?.id) { state.user = data.user; saveLocal(); } }
          sessionGetter = bioOnFor(state.user?.id) ? bioGetter() : null; // don't keep the password around
        } catch (err) {
          if (err.status === 401) {
            // Changed on another device — this phone's copy of it is out of date.
            localStorage.removeItem(PW_KEY);
            sessionGetter = null;
            signOutHere('Your password was changed. Sign in with the new one.');
          }
          throw err;
        }
      };
      await boot();
      sessionInBackground();
      return;
    }
    const data = await api(`/auth/${authMode}`, { method: 'POST', body: payload });
    if (!data?.token || !data?.user?.id) {
      throw new Error('The server replied but did not send an account back. Check that the app is pointed at your HomeBoard server.');
    }
    setToken(data.token);
    state.user = data.user;
    rememberPassword(payload.email, payload.password, data.user);
    await boot();
  } catch (err) {
    alert.textContent = err.message;
    alert.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

function showAuth() {
  $('#app-screen').classList.add('hidden');
  $('#lock-screen')?.classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  closeSheet();
}

/* ───────────────────────── rendering ───────────────────────── */

function taskCard(task) {
  const r = remaining(task.dueAt);
  const steps = (task.checklist || []).length;
  const doneSteps = (task.checklist || []).filter((c) => c.done).length;
  const notes = (task.comments || []).length;
  const mine = task.assigneeId === state.user.id;

  const bits = [];
  bits.push(`<span class="who">${avatar(task.assignee, 'sm')}${esc(mine ? 'You' : task.assignee?.name || 'Unassigned')}</span>`);
  bits.push(`<span class="dot"></span><span class="remaining pill pill-${r.tone}" data-due="${esc(task.dueAt || '')}">${esc(r.text)}</span>`);
  if (steps) bits.push(`<span class="dot"></span><span class="has-details">☑ ${doneSteps}/${steps}</span>`);
  if (task.details) bits.push(`<span class="dot"></span><span class="has-details">≡ details</span>`);
  if (notes) bits.push(`<span class="dot"></span><span class="has-details">💬 ${notes}</span>`);
  if (state.view === 'all' && task.createdById !== task.assigneeId)
    bits.push(`<span class="dot"></span><span>from ${esc(task.createdBy?.name?.split(' ')[0] || '?')}</span>`);

  // No tick on the card. Tapping opens the task so it can be read before it is
  // marked done — completing wipes the details, so it should never be one
  // stray thumb away.
  const initial = task.priority === 'high' ? '!' : (task.checklist || []).length ? '☰' : '·';

  return `
    <div class="task pri-${esc(task.priority)}${r.ms < 0 ? ' overdue' : ''}" data-id="${esc(task.id)}">
      <button class="task-open" data-open="${esc(task.id)}" aria-label="Open “${esc(task.title)}”">
        <span class="task-chip" aria-hidden="true">${initial}</span>
        <span class="task-body">
          <span class="task-title">${esc(task.title)}</span>
          <span class="task-meta">${bits.join('')}</span>
        </span>
      </button>
    </div>`;
}

const emptyState = (title, body) => `
  <div class="empty">
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
    <h3>${esc(title)}</h3><p>${esc(body)}</p>
  </div>`;

function render() {
  const project = activeProject();
  if (!project && !local.base && state.user) {
    // First time on this phone: the boards are on their way, in the background.
    $('#board-name').textContent = 'HomeBoard';
    $('#view').innerHTML = local.lastError
      ? emptyState('Could not fetch your boards yet', `${local.lastError} Tap the sync button to try again.`)
      : `<div class="center-load"><span class="spinner"></span><p style="color:var(--ink-3);font-size:13px;margin-top:10px">Fetching your boards…</p></div>`;
    $$('.tabs .count').forEach((c) => (c.textContent = '0'));
    return;
  }
  if (!project) {
    $('#board-name').textContent = 'No board yet';
    $('#view').innerHTML = emptyState(
      'Create your first board',
      'A board is one shared list — your home, your flat, a weekend project. Everyone you invite sees the same tasks.'
    ) + `<div style="margin-top:14px;text-align:center"><button class="btn btn-primary" id="first-board">Create a board</button></div>`;
    $('#first-board').addEventListener('click', () => sheet('#sheet-boards'));
    $$('.tabs .count').forEach((c) => (c.textContent = '0'));
    return;
  }

  state.activeId = project.id;
  localStorage.setItem('hb.board', project.id);
  $('#board-name').textContent = `${project.emoji || '🏠'} ${project.name}`;

  const all = state.tasks.filter((t) => t.projectId === project.id);
  const mine = all.filter((t) => t.assigneeId === state.user.id);
  const sent = all.filter((t) => t.createdById === state.user.id && t.assigneeId !== state.user.id);

  $('#c-mine').textContent = mine.length;
  $('#c-all').textContent = all.length;
  $('#c-sent').textContent = sent.length;

  const view = $('#view');

  if (state.view === 'done') {
    const rows = state.history.filter((h) => h.projectId === project.id);
    view.innerHTML = rows.length
      ? `<p style="font-size:12.5px;color:var(--ink-3);margin:2px 4px 12px;line-height:1.6">
           Details, steps and notes were deleted when each of these was finished. Only the name stays.
         </p>
         <div class="task-list">${rows.map((h) => `
           <div class="hist">
             ${avatar(h.completedBy, 'sm')}
             <span class="ttl">${esc(h.title)}</span>
             ${h.wasLate ? '<span class="pill pill-warn">late</span>' : ''}
             <span class="when">${esc(ago(h.completedAt))}</span>
           </div>`).join('')}</div>`
      : emptyState('Nothing finished yet', 'Completed tasks show up here by name — everything else about them gets deleted.');
    return;
  }

  const list =
    state.view === 'mine' ? mine :
    state.view === 'sent' ? sent : all;

  if (!list.length) {
    const copy = {
      mine: ['Nothing on your plate', 'When someone assigns you a task it lands here, with the time you have left to do it.'],
      sent: ['You have not pushed anything out', 'Tap + and pick someone else as the owner to put a task on their plate.'],
      all:  ['This board is clear', 'Tap + to add the first task.'],
    }[state.view];
    view.innerHTML = emptyState(copy[0], copy[1]);
    return;
  }

  const overdue = list.filter((t) => t.dueAt && Date.parse(t.dueAt) < Date.now());
  const rest = list.filter((t) => !overdue.includes(t));

  view.innerHTML = [
    overdue.length ? `<div class="section-head"><h2>Overdue</h2><span class="pill pill-danger">${overdue.length}</span></div>
      <div class="task-list">${overdue.map(taskCard).join('')}</div>` : '',
    rest.length ? `${overdue.length ? '<div class="section-head"><h2>Coming up</h2></div>' : ''}
      <div class="task-list">${rest.map(taskCard).join('')}</div>` : '',
  ].join('');
}

/** Refresh just the countdown pills — cheap, runs on a timer. */
function tickCountdowns() {
  $$('.remaining[data-due]').forEach((el) => {
    const r = remaining(el.dataset.due || null);
    el.textContent = r.text;
    el.className = `remaining pill pill-${r.tone}`;
  });
}
setInterval(tickCountdowns, 30000);

/* ───────────────────────── local copy + sync ───────────────────────── */

/*
 * Offline-first. Everything you see comes from a copy kept on this device, and
 * every change you make lands there instantly — no network, no waiting.
 *
 *   base     the last copy downloaded from the server
 *   outbox   your changes since then, in order, not yet sent
 *   screen   base with the outbox replayed on top
 *
 * Sync sends the outbox one change at a time, then downloads a fresh base.
 * Because the screen is always "base + outbox", a download can happen at any
 * moment without losing anything you have not sent yet.
 *
 * Sync runs when you press it. Account → Sync adds a safety net: every N
 * minutes, and/or when you open or leave the app. Both can be switched off.
 */
const SYNC_EVERY_KEY = 'hb.syncEvery';       // minutes, '0' = manual only
const SYNC_EDGES_KEY = 'hb.syncOnOpenLeave'; // '1' | '0'
const DEFAULT_SYNC_EVERY = 15;

const local = { base: null, outbox: [], lastSyncAt: null, lastError: '', serverHasNews: false };
let syncing = null;

const localKey  = () => `hb.local.${state.user.id}`;
const outboxKey = () => `hb.outbox.${state.user.id}`;

function syncEvery() {
  const raw = localStorage.getItem(SYNC_EVERY_KEY);
  if (raw === null || raw === '') return DEFAULT_SYNC_EVERY;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_SYNC_EVERY;
}
const syncOnEdges = () => localStorage.getItem(SYNC_EDGES_KEY) !== '0';

function rid(prefix) {
  const bytes = new Uint8Array(9);
  (window.crypto || {}).getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function saveLocal() {
  if (!state.user) return;
  try {
    localStorage.setItem('hb.user', JSON.stringify(state.user));
    localStorage.setItem(localKey(), JSON.stringify({ base: local.base, lastSyncAt: local.lastSyncAt }));
    localStorage.setItem(outboxKey(), JSON.stringify(local.outbox));
  } catch (err) {
    console.warn('[HomeBoard] could not save the local copy', err);
    toast('This device is out of space for HomeBoard — sync now so nothing is lost.');
  }
}

function loadLocal() {
  local.base = null; local.outbox = []; local.lastSyncAt = null; local.lastError = '';
  if (!state.user) return;
  try {
    const saved = JSON.parse(localStorage.getItem(localKey()) || 'null');
    if (saved?.base) { local.base = saved.base; local.lastSyncAt = saved.lastSyncAt || null; }
    local.outbox = JSON.parse(localStorage.getItem(outboxKey()) || '[]') || [];
  } catch { /* a corrupt copy just means a fresh download */ }
}

function forgetLocal() {
  if (state.user) {
    localStorage.removeItem(localKey());
    localStorage.removeItem(outboxKey());
  }
  localStorage.removeItem('hb.user');
  local.base = null; local.outbox = []; local.lastSyncAt = null;
}

/* What the server would have added to a task, worked out from the board. */
function memberUser(projectId, userId) {
  if (!userId) return null;
  if (userId === state.user?.id) return state.user;
  for (const p of state.projects) {
    if (projectId && p.id !== projectId) continue;
    const m = p.members.find((x) => x.user?.id === userId);
    if (m) return m.user;
  }
  return null;
}
function decorateLocal(t) {
  t.assignee = memberUser(t.projectId, t.assigneeId);
  t.createdBy = memberUser(t.projectId, t.createdById);
  t.comments = (t.comments || []).map((c) => ({ ...c, author: c.author || memberUser(t.projectId, c.userId) }));
  return t;
}
/** The task as the server stores it — no decorations. */
function rawTask(t) {
  const { assignee, createdBy, ...rest } = t;
  return { ...rest, comments: (t.comments || []).map(({ author, ...c }) => c) };
}

function applyOp(tasks, history, op) {
  const find = (id) => tasks.find((t) => t.id === id);
  switch (op.type) {
    case 'create':
      if (!find(op.task.id)) tasks.push(clone(op.task));
      break;
    case 'update': {
      const t = find(op.taskId);
      if (t) Object.assign(t, clone(op.patch), { updatedAt: op.at });
      break;
    }
    case 'comment': {
      const t = find(op.taskId);
      if (t && !(t.comments || []).some((c) => c.id === op.comment.id)) {
        t.comments = [...(t.comments || []), { ...op.comment, userId: state.user.id }];
      }
      break;
    }
    case 'complete': {
      const i = tasks.findIndex((t) => t.id === op.taskId);
      if (i !== -1) tasks.splice(i, 1);
      if (!history.some((h) => h.id === op.history.id)) history.unshift({ ...op.history, completedBy: state.user });
      break;
    }
    case 'restore': {
      if (!find(op.task.id)) tasks.push(clone(op.task));
      const i = history.findIndex((h) => h.id === op.historyId);
      if (i !== -1) history.splice(i, 1);
      break;
    }
    case 'delete': {
      const i = tasks.findIndex((t) => t.id === op.taskId);
      if (i !== -1) tasks.splice(i, 1);
      break;
    }
  }
}

/** Screen = base + outbox. */
function rebuild() {
  const base = local.base || { projects: [], tasks: [], history: [] };
  state.projects = clone(base.projects || []);
  const tasks = clone(base.tasks || []);
  const history = clone(base.history || []);
  for (const op of local.outbox) applyOp(tasks, history, op);
  tasks.forEach(decorateLocal);
  tasks.sort((a, b) => {
    const ad = a.dueAt ? Date.parse(a.dueAt) : Infinity;
    const bd = b.dueAt ? Date.parse(b.dueAt) : Infinity;
    if (ad !== bd) return ad - bd;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
  history.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  state.tasks = tasks;
  state.history = history;
  if (!state.projects.some((p) => p.id === state.activeId)) state.activeId = state.projects[0]?.id || null;
}

/** Re-draw everything that shows tasks. */
function redraw() {
  rebuild();
  render();
  if (openSheet === $('#sheet-detail') && state.detailId) renderDetail();
  if (openSheet === $('#sheet-members')) renderMembers();
  updateSyncUi();
}

/**
 * Record a change on this device. Folds it into an earlier unsent change where
 * that's the same thing, so a burst of edits is one request, and a task made
 * and deleted offline never reaches the server at all.
 */
function queue(op) {
  op.id = op.id || rid('op');
  op.at = op.at || new Date().toISOString();
  const open = (o) => !o.sending && o.taskId === op.taskId;

  if (op.type === 'delete') {
    const created = local.outbox.find((o) => o.type === 'create' && o.taskId === op.taskId && !o.sending);
    if (created) {
      local.outbox = local.outbox.filter((o) => o.taskId !== op.taskId || o.sending);
      return commitLocal();
    }
  }
  if (op.type === 'update') {
    const created = local.outbox.find((o) => o.type === 'create' && open(o));
    if (created) {
      Object.assign(created.task, clone(op.patch));
      return commitLocal();
    }
    const last = [...local.outbox].reverse().find((o) => o.taskId === op.taskId);
    if (last && last.type === 'update' && !last.sending) {
      Object.assign(last.patch, clone(op.patch));
      last.at = op.at;
      return commitLocal();
    }
  }
  local.outbox.push(op);
  commitLocal();
}
function commitLocal() {
  saveLocal();
  redraw();
  scheduleReminders(); // a new or moved due date is reminded about straight away, synced or not
}

/* ── talking to the server ── */

async function sendOp(op) {
  const opts = { background: true };
  switch (op.type) {
    case 'create': {
      const t = op.task;
      return api('/tasks', { ...opts, method: 'POST', body: {
        id: t.id, projectId: t.projectId, title: t.title, details: t.details, checklist: t.checklist,
        assigneeId: t.assigneeId, dueAt: t.dueAt, priority: t.priority, createdAt: t.createdAt,
      } });
    }
    case 'update':
      return api(`/tasks/${encodeURIComponent(op.taskId)}`, { ...opts, method: 'PATCH', body: op.patch });
    case 'comment':
      return api(`/tasks/${encodeURIComponent(op.taskId)}/comments`, { ...opts, method: 'POST', body: op.comment });
    case 'complete':
      return api(`/tasks/${encodeURIComponent(op.taskId)}/complete`, { ...opts, method: 'POST', body: {
        historyId: op.history.id, completedAt: op.history.completedAt,
      } });
    case 'restore':
      return api('/tasks/restore', { ...opts, method: 'POST', body: { task: op.task, historyId: op.historyId } });
    case 'delete':
      return api(`/tasks/${encodeURIComponent(op.taskId)}`, { ...opts, method: 'DELETE' });
  }
  return null;
}

const OP_LABEL = {
  create: 'adding', update: 'editing', comment: 'a note on', complete: 'finishing', restore: 'putting back', delete: 'deleting',
};
function opTitle(op) {
  return op.task?.title || op.history?.title || state.tasks.find((t) => t.id === op.taskId)?.title
    || local.base?.tasks?.find((t) => t.id === op.taskId)?.title || 'a task';
}

/** Download a fresh copy of the boards, tasks and history. */
async function pull({ background = true } = {}) {
  const [{ projects }, { tasks }, { history }] = await Promise.all([
    api('/projects', { background }),
    api('/tasks', { background }),
    api('/tasks/history/list', { background }),
  ]);
  local.base = {
    projects,
    tasks: tasks.map(rawTask),
    history: history.map(({ completedBy, assignedTo, ...h }) => ({ ...h, completedBy, assignedTo })),
  };
  local.serverHasNews = false;
  saveLocal();
  redraw();
  noticeNewTasks();
  scheduleReminders();
  // A notification tap that arrived before the boards did.
  if (pendingOpenTaskId && state.projects.length) {
    const id = pendingOpenTaskId; pendingOpenTaskId = null; openTaskFromPush(id);
  }
}

/**
 * Send everything waiting, then download. A change the server refuses (the
 * task was finished or deleted by someone else, you were removed from the
 * board) is dropped and reported; no connection stops the sync and keeps the
 * rest for next time.
 */
function syncNow({ reason = 'manual' } = {}) {
  if (!state.user) return Promise.resolve(null);
  if (syncing) return syncing;
  const btn = $('#refresh-btn');
  btn?.classList.add('spinning');
  setSyncNote(local.outbox.length ? `Sending ${local.outbox.length} change${local.outbox.length === 1 ? '' : 's'}…` : 'Checking for changes…');

  syncing = (async () => {
    const dropped = [];
    let sent = 0;
    while (local.outbox.length) {
      const op = local.outbox[0];
      op.sending = true;
      try {
        await sendOp(op);
        sent++;
      } catch (err) {
        op.sending = false;
        if (err.offline || err.auth || !err.status || err.status >= 500 || err.status === 429) { saveLocal(); throw err; }
        // 404 on finishing or deleting means it is already gone — that's the goal reached.
        const alreadyGone = err.status === 404 && (op.type === 'complete' || op.type === 'delete');
        if (!alreadyGone) dropped.push(`${OP_LABEL[op.type] || 'changing'} “${opTitle(op)}”: ${err.message}`);
      }
      local.outbox = local.outbox.filter((o) => o !== op);
      saveLocal();
    }
    await pull();
    local.lastSyncAt = new Date().toISOString();
    local.lastError = '';
    saveLocal();
    return { sent, dropped, reason };
  })()
    .catch((err) => { local.lastError = err.message; throw err; })
    .finally(() => {
      syncing = null;
      setTimeout(() => btn?.classList.remove('spinning'), 350);
      setSyncNote('');
      updateSyncUi();
    });
  return syncing;
}

/** Sync and say how it went. For the button, pull-to-refresh, and Account. */
async function syncAndReport() {
  const before = $('#toast-text').textContent;
  try {
    const out = await syncNow({ reason: 'manual' });
    if (!out) return;
    if (out.dropped.length) {
      toast(`Synced, but ${out.dropped.length} change${out.dropped.length === 1 ? '' : 's'} could not be applied — ${out.dropped[0]}`, null, 9000);
      console.warn('[HomeBoard] changes the server refused:', out.dropped);
      return;
    }
    // Don't talk over a "New task from…" alert the sync just raised.
    if ($('#toast-text').textContent !== before && $('#toast').classList.contains('show')) return;
    toast(out.sent ? `Synced — ${out.sent} change${out.sent === 1 ? '' : 's'} sent.` : 'Up to date.');
  } catch (err) {
    toast(err.offline
      ? `Couldn't reach the server. ${pendingText()} — kept on this device.`
      : err.message, null, 6000);
  }
}

/** Safety-net syncs: quiet, and they never complain. */
function autoSync(reason) {
  syncNow({ reason }).then((out) => {
    if (out?.dropped?.length) toast(`${out.dropped.length} change${out.dropped.length === 1 ? '' : 's'} could not be applied — ${out.dropped[0]}`, null, 9000);
  }).catch(() => {});
}

const pendingText = () => `${local.outbox.length} change${local.outbox.length === 1 ? '' : 's'} waiting`;

let syncNoteText = '';
function setSyncNote(text) { syncNoteText = text; updateSyncUi(); }

function updateSyncUi() {
  const n = local.outbox.length;
  const badge = $('#sync-badge');
  if (badge) { badge.textContent = n > 99 ? '99+' : String(n); badge.classList.toggle('hidden', !n && !local.serverHasNews); badge.classList.toggle('dot-only', !n); }
  const btn = $('#refresh-btn');
  if (btn) btn.title = n ? `Sync now — ${pendingText()}` : 'Sync now';

  const strip = $('#sync-strip');
  if (strip) {
    const show = Boolean(state.user) && (n > 0 || local.serverHasNews);
    strip.classList.toggle('hidden', !show);
    $('#sync-strip-text').textContent = syncNoteText ||
      (n ? `${pendingText()} on this device — not on the server yet.` : 'There are new changes on the server.');
  }

  const status = $('#sync-status');
  if (status) {
    const parts = [];
    parts.push(local.lastSyncAt ? `Last synced ${ago(local.lastSyncAt)}.` : 'Not synced yet on this device.');
    parts.push(n ? `${pendingText()} to be sent.` : 'Nothing waiting to be sent.');
    if (local.lastError) parts.push(`Last try failed: ${local.lastError}`);
    if (syncNoteText) parts.push(syncNoteText);
    status.textContent = parts.join(' ');
  }
}

/* ── the safety net ── */

let autoTimer = null;
function startPolling() {
  stopPolling();
  const every = syncEvery();
  if (every > 0) autoTimer = setInterval(() => autoSync('timer'), every * 60000);
}
function stopPolling() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (!state.user || !syncOnEdges()) return;
  if (document.visibilityState === 'visible') autoSync('open');
  else if (local.outbox.length) autoSync('leave'); // get it off the phone before Android kills us
});
window.addEventListener('online', () => {
  if (state.user && local.outbox.length && (syncEvery() > 0 || syncOnEdges())) autoSync('online');
});
window.addEventListener('offline', () => updateSyncUi());

/* Board-level actions still need the server; afterwards, refresh the copy. */
async function loadAll() { await pull({ background: false }); }

/** A push says something changed on the server. */
function serverChanged() {
  local.serverHasNews = true;
  updateSyncUi();
  if (syncEvery() > 0 || syncOnEdges()) autoSync('push');
}

/* ───────────────────────── tabs ───────────────────────── */

$$('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    state.view = btn.dataset.view;
    render();
  });
});

/* ───────────────────────── task sheet ───────────────────────── */

function renderAssigneePicker(selectedId) {
  const project = activeProject();
  if (!project) return;
  $('#assignee-picker').innerHTML = project.members
    .map((m) => `
      <button type="button" class="person" data-uid="${esc(m.user.id)}" aria-pressed="${String(m.user.id === selectedId)}">
        ${avatar(m.user, 'sm')}${esc(m.user.id === state.user.id ? 'Me' : m.user.name)}
      </button>`)
    .join('');
}

function renderChecklistEdit() {
  const wrap = $('#checklist-edit');
  wrap.innerHTML = state.draftChecks
    .map((c, i) => `
      <div class="check${c.done ? ' done' : ''}" data-i="${i}">
        <input type="checkbox" ${c.done ? 'checked' : ''} aria-label="Step done">
        <input class="t" value="${esc(c.text)}" placeholder="Step…" maxlength="200">
        <button type="button" class="x" aria-label="Remove step">✕</button>
      </div>`)
    .join('');
}

$('#checklist-edit').addEventListener('input', (e) => {
  const row = e.target.closest('.check');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (e.target.matches('.t')) state.draftChecks[i].text = e.target.value;
  if (e.target.type === 'checkbox') {
    state.draftChecks[i].done = e.target.checked;
    row.classList.toggle('done', e.target.checked);
  }
});
$('#checklist-edit').addEventListener('click', (e) => {
  if (!e.target.matches('.x')) return;
  state.draftChecks.splice(Number(e.target.closest('.check').dataset.i), 1);
  renderChecklistEdit();
});
$('#add-check').addEventListener('click', () => {
  state.draftChecks.push({ text: '', done: false });
  renderChecklistEdit();
  const inputs = $$('#checklist-edit .t');
  inputs[inputs.length - 1]?.focus();
});

$('#assignee-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.person');
  if (!btn) return;
  $$('#assignee-picker .person').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
});

$('#priority-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $$('#priority-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
});

$('.quick', $('#task-form')).addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const input = $('#task-form [name=dueAt]');
  if (btn.dataset.clear) { input.value = ''; return; }
  const d = new Date();
  if (btn.dataset.in)      d.setHours(d.getHours() + Number(btn.dataset.in));
  if (btn.dataset.tonight) d.setHours(20, 0, 0, 0);
  if (btn.dataset.days) {
    d.setDate(d.getDate() + Number(btn.dataset.days));
    d.setHours(18, 0, 0, 0);
  }
  input.value = toLocalInput(d.toISOString());
});

function openTaskSheet(task = null) {
  if (!activeProject()) { sheet('#sheet-boards'); return; }
  state.editing = task;
  const form = $('#task-form');
  form.reset();

  $('#task-sheet-title').textContent = task ? 'Edit task' : 'New task';
  $('#task-save').textContent = task ? 'Save changes' : 'Create task';

  form.elements.title.value = task?.title || '';
  form.elements.details.value = task?.details || '';
  form.elements.dueAt.value = toLocalInput(task?.dueAt);

  state.draftChecks = (task?.checklist || []).map((c) => ({ ...c }));
  renderChecklistEdit();
  renderAssigneePicker(task?.assigneeId || state.user.id);

  const pri = task?.priority || 'normal';
  $$('#priority-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === pri)));

  sheet('#sheet-task');
  setTimeout(() => form.elements.title.focus(), 280);
}

$('#fab').addEventListener('click', () => openTaskSheet());

$('#task-save').addEventListener('click', () => {
  const form = $('#task-form');
  const title = form.elements.title.value.trim();
  if (title.length < 2) { form.elements.title.focus(); toast('Give the task a name.'); return; }

  const assigneeId = $('#assignee-picker .person[aria-pressed="true"]')?.dataset.uid || state.user.id;
  const priority = $('#priority-seg button[aria-pressed="true"]')?.dataset.v || 'normal';
  const payload = {
    projectId: activeProject().id,
    title,
    details: form.elements.details.value,
    dueAt: form.elements.dueAt.value ? new Date(form.elements.dueAt.value).toISOString() : null,
    assigneeId,
    priority,
    checklist: state.draftChecks
      .filter((c) => c.text.trim())
      .map((c) => ({ id: c.id || rid('chk'), text: c.text.trim().slice(0, 200), done: Boolean(c.done) })),
  };

  // Saved on this device straight away; it reaches everyone else on the next sync.
  const editing = state.editing;
  if (editing) {
    const patch = {};
    for (const k of ['title', 'details', 'dueAt', 'assigneeId', 'priority', 'checklist']) {
      if (JSON.stringify(payload[k] ?? null) !== JSON.stringify(editing[k] ?? null)) patch[k] = payload[k];
    }
    if (Object.keys(patch).length) queue({ type: 'update', taskId: editing.id, patch });
  } else {
    const now = new Date().toISOString();
    const task = {
      id: rid('tsk'), ...payload, title: title.slice(0, 120), details: payload.details.slice(0, 4000),
      createdById: state.user.id, comments: [], createdAt: now, updatedAt: now,
    };
    markNotified(task.id); // you made it — no "new task" alert for it here
    queue({ type: 'create', taskId: task.id, task });
  }
  closeSheet();
  const who = activeProject().members.find((m) => m.user.id === assigneeId)?.user;
  toast(
    editing ? 'Task updated.'
    : assigneeId === state.user.id ? 'Added to your list.'
    : `Saved for ${who?.name?.split(' ')[0] || 'them'} — they get it when you sync.`,
    { label: 'Sync now', run: syncAndReport }
  );
});

/* ───────────────────────── detail sheet ───────────────────────── */

function renderDetail() {
  const task = state.tasks.find((t) => t.id === state.detailId);
  if (!task) { closeSheet(); return; }
  const r = remaining(task.dueAt);
  const steps = task.checklist || [];
  const notes = task.comments || [];

  $('#detail-body').innerHTML = `
    <div class="detail-title">${esc(task.title)}</div>
    <div class="detail-strip">
      <span class="pill pill-${r.tone}">${esc(r.text)}</span>
      ${task.priority === 'high' ? '<span class="pill pill-danger">High priority</span>' : ''}
      ${task.priority === 'low' ? '<span class="pill pill-mute">Low priority</span>' : ''}
      ${task.dueAt ? `<span class="pill pill-mute">Due ${esc(new Date(task.dueAt).toLocaleString(undefined,{weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}))}</span>` : ''}
    </div>

    <div class="detail-block">
      <h4>Assigned to</h4>
      <div class="people" id="detail-assignee">
        ${activeProject().members.map((m) => `
          <button type="button" class="person" data-uid="${esc(m.user.id)}" aria-pressed="${String(m.user.id === task.assigneeId)}">
            ${avatar(m.user,'sm')}${esc(m.user.id === state.user.id ? 'Me' : m.user.name)}
          </button>`).join('')}
      </div>
      <p style="font-size:12px;color:var(--ink-3);margin:8px 0 0">
        Added by ${esc(task.createdBy?.id === state.user.id ? 'you' : task.createdBy?.name || 'someone')} · ${esc(ago(task.createdAt))}
      </p>
    </div>

    ${task.details ? `<div class="detail-block"><h4>Details</h4><div class="detail-text">${esc(task.details)}</div></div>` : ''}

    ${steps.length ? `
      <div class="detail-block">
        <h4>Steps · ${steps.filter((s) => s.done).length}/${steps.length}</h4>
        <div class="checks" id="detail-checks">
          ${steps.map((s) => `
            <div class="check${s.done ? ' done' : ''}" data-cid="${esc(s.id)}">
              <input type="checkbox" ${s.done ? 'checked' : ''} aria-label="${esc(s.text)}">
              <span class="t">${esc(s.text)}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}

    <div class="detail-block">
      <h4>Notes</h4>
      ${notes.length ? `<div class="notes">${notes.map((n) => `
        <div class="note">${avatar(n.author,'sm')}
          <div class="bubble">
            <div class="nm">${esc(n.author?.id === state.user.id ? 'You' : n.author?.name || 'Someone')}</div>
            ${esc(n.text)}
            <div class="at">${esc(ago(n.at))}</div>
          </div>
        </div>`).join('')}</div>` : '<p style="font-size:13px;color:var(--ink-3);margin:0 0 10px">No notes yet.</p>'}
      <form id="note-form" class="row" style="margin-top:11px">
        <input class="input" name="text" placeholder="Add a note…" maxlength="1000" required>
        <button class="btn" type="submit" style="flex:0 0 auto">Post</button>
      </form>
    </div>`;

  $('#detail-assignee').addEventListener('click', async (e) => {
    const btn = e.target.closest('.person');
    if (!btn || btn.getAttribute('aria-pressed') === 'true') return;
    $$('#detail-assignee .person').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    queue({ type: 'update', taskId: task.id, patch: { assigneeId: btn.dataset.uid } });
    const who = activeProject().members.find((m) => m.user.id === btn.dataset.uid)?.user;
    toast(btn.dataset.uid === state.user.id ? 'You took this on.' : `Passed to ${who?.name?.split(' ')[0]}.`);
  });

  $('#detail-checks')?.addEventListener('change', async (e) => {
    if (e.target.type !== 'checkbox') return;
    const row = e.target.closest('.check');
    row.classList.toggle('done', e.target.checked);
    const next = steps.map((s) => (s.id === row.dataset.cid ? { ...s, done: e.target.checked } : s));
    queue({ type: 'update', taskId: task.id, patch: { checklist: next } });
  });

  $('#note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.elements.text;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    queue({ type: 'comment', taskId: task.id, comment: { id: rid('cmt'), text: text.slice(0, 1000), at: new Date().toISOString() } });
  });
}

function openDetail(id) {
  state.detailId = id;
  $('#detail-heading').textContent = 'Task';
  renderDetail();
  sheet('#sheet-detail');
}

$('#detail-edit').addEventListener('click', () => {
  const task = state.tasks.find((t) => t.id === state.detailId);
  if (task) openTaskSheet(task);
});

$('#detail-complete').addEventListener('click', async () => {
  const task = state.tasks.find((t) => t.id === state.detailId);
  if (!task) return;
  await completeTask(task.id, task.title);
  closeSheet();
});

$('#detail-delete').addEventListener('click', async () => {
  const task = state.tasks.find((t) => t.id === state.detailId);
  if (!task) return;
  if (!confirm(`Delete “${task.title}”? It will not appear in Finished.`)) return;
  closeSheet();
  queue({ type: 'delete', taskId: task.id });
  toast('Task deleted.');
});

async function completeTask(id, title) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  // Kept in this closure only, for Undo. Once the toast goes, it really is gone.
  const before = rawTask(clone(task));
  const completedAt = new Date().toISOString();
  const op = {
    type: 'complete', taskId: id,
    history: {
      id: rid('hst'), projectId: task.projectId, title: task.title, completedById: state.user.id,
      assignedToId: task.assigneeId || null, completedAt,
      wasLate: task.dueAt ? Date.parse(completedAt) > Date.parse(task.dueAt) : false,
    },
  };
  queue(op);
  toast(`“${title}” done.`, {
    label: 'Undo',
    run: () => {
      if (local.outbox.includes(op) && !op.sending) {
        // Not sent yet — just forget it was ever done.
        local.outbox = local.outbox.filter((o) => o !== op);
        commitLocal();
      } else {
        queue({ type: 'restore', taskId: id, task: before, historyId: op.history.id });
      }
      toast('Put back.');
    },
  });
}

$('#view').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) openDetail(open.dataset.open);
});

/* ───────────────────────── boards ───────────────────────── */

$('#board-switch').addEventListener('click', () => {
  const list = $('#board-list');
  list.innerHTML = state.projects.length
    ? state.projects.map((p) => `
        <button class="btn btn-block" data-board="${esc(p.id)}"
          style="justify-content:space-between;${p.id === state.activeId ? 'border-color:var(--teal-700);background:var(--teal-50)' : ''}">
          <span>${esc(p.emoji || '🏠')} ${esc(p.name)}</span>
          <span style="font-size:12px;color:var(--ink-3);font-weight:500">${p.members.length} ${p.members.length === 1 ? 'person' : 'people'}</span>
        </button>`).join('')
    : '<p style="font-size:13px;color:var(--ink-3);margin:0">You are not on any board yet.</p>';
  sheet('#sheet-boards');
});

$('#board-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-board]');
  if (!btn) return;
  state.activeId = btn.dataset.board;
  localStorage.setItem('hb.board', state.activeId);
  closeSheet();
  render();
});

$('#new-board-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.elements.name.value.trim();
  if (name.length < 2) return;
  try {
    const { project } = await api('/projects', { method: 'POST', body: { name } });
    e.target.reset();
    state.activeId = project.id;
    closeSheet();
    await loadAll();
    toast(`“${project.name}” is ready. Invite people from the 👥 button.`);
  } catch (err) { toast(err.message); }
});

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = e.target.elements.code.value.trim();
  if (!code) return;
  try {
    const { project, message } = await api('/projects/join', { method: 'POST', body: { code } });
    e.target.reset();
    state.activeId = project.id;
    closeSheet();
    await loadAll();
    toast(message);
  } catch (err) { toast(err.message); }
});

/* ───────────────────────── members & invites ───────────────────────── */

function renderMembers() {
  const project = activeProject();
  if (!project) return;
  const iAmOwner = project.ownerId === state.user.id;

  $('#member-list').innerHTML = project.members.map((m) => `
    <div class="member">
      ${avatar(m.user)}
      <div class="info">
        <div class="nm">${esc(m.user.name)}${m.user.id === state.user.id ? ' <span style="font-weight:500;color:var(--ink-3)">(you)</span>' : ''}</div>
        <div class="em">${esc(m.user.email)}</div>
      </div>
      ${m.role === 'owner' ? '<span class="pill pill-mute">Owner</span>' : ''}
      ${iAmOwner && m.role !== 'owner'
        ? `<button class="btn btn-ghost btn-sm" data-makeowner="${esc(m.user.id)}">Make owner</button>` : ''}
      ${(iAmOwner && m.role !== 'owner') || m.user.id === state.user.id
        ? `<button class="btn btn-ghost btn-sm" data-remove="${esc(m.user.id)}">${m.user.id === state.user.id ? 'Leave' : 'Remove'}</button>` : ''}
    </div>`).join('');

  $('#invite-code').textContent = project.inviteCode;
  renderInviteQr(project);
  $('#rotate-code').classList.toggle('hidden', !iAmOwner);
  $('#danger-block').classList.toggle('hidden', !iAmOwner);
  $('#invite-alert').classList.add('hidden');
}

$('#open-members').addEventListener('click', () => {
  if (!activeProject()) { sheet('#sheet-boards'); return; }
  renderMembers();
  sheet('#sheet-members');
});

$('#member-list').addEventListener('click', async (e) => {
  const hand = e.target.closest('[data-makeowner]');
  if (hand) {
    const project = activeProject();
    const who = project.members.find((m) => m.user.id === hand.dataset.makeowner)?.user;
    if (!confirm(`Make ${who?.name || 'them'} the owner of “${project.name}”?\n\nThey will be able to rename and delete the board, and remove people — including you. You stay on as a member.`)) return;
    try {
      const out = await api(`/projects/${project.id}/transfer-owner`, {
        method: 'POST', body: { userId: hand.dataset.makeowner },
      });
      await loadAll();
      renderMembers();
      toast(out.message);
    } catch (err) { toast(err.message); }
    return;
  }

  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const uid = btn.dataset.remove;
  const self = uid === state.user.id;
  if (!confirm(self ? 'Leave this board?' : 'Remove this person from the board?')) return;
  try {
    await api(`/projects/${activeProject().id}/members/${uid}`, { method: 'DELETE' });
    if (self) { state.activeId = null; closeSheet(); }
    await loadAll();
    if (!self) renderMembers();
    toast(self ? 'You left the board.' : 'Removed.');
  } catch (err) { toast(err.message); }
});

$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = e.target.elements.email.value.trim();
  const box = $('#invite-alert');
  try {
    const out = await api(`/projects/${activeProject().id}/invite`, { method: 'POST', body: { email } });
    e.target.reset();
    box.textContent = out.message;
    box.className = 'alert alert-ok';
    await loadAll();
    renderMembers();
    box.classList.remove('hidden');
  } catch (err) {
    box.textContent = err.message;
    box.className = 'alert alert-error';
    box.classList.remove('hidden');
  }
});

$('#copy-code').addEventListener('click', async () => {
  const project = activeProject();
  const text = `Join my HomeBoard “${project.name}”: ${joinLink(project)}\n\n(or enter the code ${project.inviteCode} yourself)`;
  try {
    if (navigator.share) await navigator.share({ title: 'HomeBoard invite', text });
    else { await navigator.clipboard.writeText(text); toast('Invite copied.'); }
  } catch { /* user cancelled the share sheet */ }
});

$('#rotate-code').addEventListener('click', async () => {
  if (!confirm('Reset the join code? The old one stops working immediately.')) return;
  try {
    await api(`/projects/${activeProject().id}/rotate-code`, { method: 'POST' });
    await loadAll();
    renderMembers();
    toast('New code generated.');
  } catch (err) { toast(err.message); }
});

$('#delete-board').addEventListener('click', async () => {
  const project = activeProject();
  if (!confirm(`Delete “${project.name}” for everyone? All its tasks and history go too.`)) return;
  try {
    await api(`/projects/${project.id}`, { method: 'DELETE' });
    state.activeId = null;
    closeSheet();
    await loadAll();
    toast('Board deleted.');
  } catch (err) { toast(err.message); }
});

/* ───────────────────────── account & theme ───────────────────────── */

function applyTheme(v) {
  document.documentElement.dataset.theme = v || '';
  localStorage.setItem('hb.theme', v || '');
  $('#theme-seg') && $$('#theme-seg button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v || '') === (v || ''))));
  const meta = $('meta[name=theme-color]');
  if (meta) meta.content = v === 'dark' ? '#081619' : '#0f766e';
}
applyTheme(localStorage.getItem('hb.theme') || '');

$('#theme-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) applyTheme(btn.dataset.v);
});

$('#open-account').addEventListener('click', () => {
  $('#sync-every').value = String(syncEvery());
  $('#sync-edges').checked = syncOnEdges();
  updateSyncUi();
  updateBioUi();
  syncRemindersToggle();
  updatePushUi();
  if ($('#push-diag-wrap')?.open) renderPushDiagnostics();
  const av = $('#acct-avatar');
  av.style.background = state.user.avatarColor || '#0f766e';
  av.textContent = initials(state.user.name);
  $('#acct-name').textContent = state.user.name;
  $('#acct-email').textContent = state.user.email;
  sheet('#sheet-account');
});

$('#signout-btn').addEventListener('click', async () => {
  const keepCopy = bioOnFor(state.user?.id);   // locked behind the fingerprint, so it can stay
  if (local.outbox.length && !keepCopy) {
    if (confirm(`${pendingText()} on this device. Sync them before signing out?`)) {
      try { await syncNow({ reason: 'signout' }); }
      catch (err) {
        if (!confirm(`Sync failed: ${err.message}\n\nSign out anyway? Unsynced changes on this device will be lost.`)) return;
      }
    } else if (!confirm('Sign out and throw those changes away?')) return;
  }
  disablePush();
  if (!keepCopy) forgetLocal();
  appVisible = false;
  api('/auth/signout', { method: 'POST', background: true }).catch(() => { /* signed out here regardless */ });
  sessionGetter = null;
  setToken(null);
  state.user = null;
  state.projects = [];
  state.tasks = [];
  stopPolling();
  closeSheet();
  setAuthMode('signin');
  showAuth();
});

$('#sync-now-acct').addEventListener('click', () => syncAndReport());
$('#sync-every').addEventListener('change', (e) => {
  localStorage.setItem(SYNC_EVERY_KEY, e.target.value);
  startPolling();
  const m = Number(e.target.value);
  toast(m ? `Syncing every ${m === 60 ? 'hour' : `${m} minutes`}.` : 'Sync is manual now — press the sync button when you want to.');
});
$('#sync-edges').addEventListener('change', (e) => {
  localStorage.setItem(SYNC_EDGES_KEY, e.target.checked ? '1' : '0');
});
$('#export-local').addEventListener('click', () => {
  const data = {
    exportedAt: new Date().toISOString(),
    user: { id: state.user.id, name: state.user.name, email: state.user.email },
    lastSyncAt: local.lastSyncAt,
    boards: state.projects.map((p) => ({ id: p.id, name: p.name })),
    tasks: state.tasks.map(rawTask),
    finished: state.history.map(({ completedBy, assignedTo, ...h }) => h),
    unsyncedChanges: local.outbox,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `homeboard-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* ───────────────────────── PWA install ───────────────────────── */

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!localStorage.getItem('hb.installDismissed')) $('#install-banner').classList.remove('hidden');
});
$('#install-btn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('#install-banner').classList.add('hidden');
});
$('#install-dismiss').addEventListener('click', () => {
  localStorage.setItem('hb.installDismissed', '1');
  $('#install-banner').classList.add('hidden');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/* ───────────────────────── staying in sync ───────────────────────── */

/*
 * Two people on one board need to see each other's changes without being told
 * to reload. There is a refresh button, a pull-to-refresh, a refresh whenever
 * the app comes back to the foreground, and a quiet poll in between.
 */
$('#refresh-btn').addEventListener('click', () => syncAndReport());
$('#sync-strip-btn')?.addEventListener('click', () => syncAndReport());

/* Pull down at the top of the list to refresh. */
(function pullToRefresh() {
  const main = document.querySelector('main');
  const indicator = document.createElement('div');
  indicator.className = 'pull';
  indicator.textContent = 'Pull to sync';
  main.prepend(indicator);

  const THRESHOLD = 68;
  let startY = 0;
  let pulling = false;

  main.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0 || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  main.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { indicator.style.height = '0px'; return; }
    const h = Math.min(dy * 0.45, 86);
    indicator.style.height = `${h}px`;
    const armed = h >= THRESHOLD * 0.45;
    indicator.classList.toggle('armed', armed);
    indicator.textContent = armed ? 'Release to sync' : 'Pull to sync';
  }, { passive: true });

  const end = async () => {
    if (!pulling) return;
    pulling = false;
    const armed = indicator.classList.contains('armed');
    indicator.style.height = '0px';
    indicator.classList.remove('armed');
    if (armed) await syncAndReport();
  };
  main.addEventListener('touchend', end);
  main.addEventListener('touchcancel', end);
})();

/* ───────────────────────── reminders ───────────────────────── */

/*
 * On Android the Capacitor plugin schedules these with the operating system,
 * so they arrive even when HomeBoard is closed. In a browser we can only use
 * the Notifications API, which means the tab has to be open — so the copy in
 * Settings says so rather than promising something we cannot deliver.
 */
const cap = () => window.Capacitor?.Plugins || null;
const localNotifications = () => cap()?.LocalNotifications || null;
const remindersOn = () => localStorage.getItem('hb.reminders') === '1';

/*
 * Notification ids have to be 32-bit integers, and each task needs three that
 * never collide: the early warning, the one at the due time, and any snooze.
 * Three bands of 700 million keep them apart and inside the signed range.
 */
const BAND = 700000000;
const BAND_EARLY = 0;
const BAND_DUE = BAND;
const BAND_SNOOZE = BAND * 2;

function taskHash(taskId) {
  let h = 0;
  for (let i = 0; i < taskId.length; i++) h = (h * 31 + taskId.charCodeAt(i)) | 0;
  return Math.abs(h) % BAND;
}
const notifId = (taskId, band) => taskHash(taskId) + band;

const CHANNEL_ID = 'homeboard-reminders';
const ACTION_TYPE = 'HB_TASK_DUE';
const SNOOZE_MINUTES = 10;

const DEFAULT_LEAD_MINUTES = 10;
const leadMinutes = () => {
  // Careful: Number(null) is 0, not NaN, so an unset value would silently read
  // as "only at the due time" and the early warning would never be scheduled.
  const raw = localStorage.getItem('hb.leadMinutes');
  if (raw === null || raw === '') return DEFAULT_LEAD_MINUTES;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_LEAD_MINUTES;
};

const webTimers = new Map();

function myUpcoming() {
  return state.tasks.filter(
    (t) => t.assigneeId === state.user?.id && t.dueAt && Date.parse(t.dueAt) > Date.now()
  );
}

/*
 * A channel of its own, at max importance. The default channel is quiet enough
 * that a reminder can sit unnoticed in the shade — this one behaves like an
 * alarm: heads-up, sound, vibration.
 */
let channelReady = false;
async function ensureChannel(ln) {
  if (channelReady || !ln?.createChannel) return;
  try {
    await ln.createChannel({
      id: CHANNEL_ID,
      name: 'Task reminders',
      description: 'When a task assigned to you is about to be due.',
      importance: 5,
      visibility: 1,
      vibration: true,
      lights: true,
    });
    channelReady = true;
  } catch (err) {
    console.warn('[HomeBoard] could not create the notification channel', err);
  }
}

let actionsReady = false;
async function ensureActions(ln) {
  if (actionsReady || !ln?.registerActionTypes) return;
  try {
    await ln.registerActionTypes({
      types: [{
        id: ACTION_TYPE,
        actions: [
          { id: 'SNOOZE', title: `Snooze ${SNOOZE_MINUTES} min` },
          { id: 'OPEN', title: 'Open', foreground: true },
        ],
      }],
    });
    actionsReady = true;
  } catch (err) {
    console.warn('[HomeBoard] could not register notification actions', err);
  }
}

function notificationFor(task, band, at, body) {
  return {
    id: notifId(task.id, band),
    title: task.title,
    body,
    largeBody: task.details ? task.details.slice(0, 300) : undefined,
    schedule: { at, allowWhileIdle: true },
    channelId: CHANNEL_ID,
    actionTypeId: ACTION_TYPE,
    smallIcon: 'ic_launcher',
    extra: { taskId: task.id, projectId: task.projectId },
  };
}

async function scheduleReminders() {
  if (!state.user) return;
  const ln = localNotifications();

  if (!remindersOn()) {
    if (ln) { try { await clearNative(ln, { includeSnoozes: true }); } catch {} }
    for (const t of webTimers.values()) clearTimeout(t);
    webTimers.clear();
    return;
  }

  if (ln) {
    try {
      await ensureChannel(ln);
      await ensureActions(ln);
      await clearNative(ln);

      const lead = leadMinutes();
      const now = Date.now();
      const notifications = [];

      for (const t of myUpcoming().slice(0, 40)) {
        const due = Date.parse(t.dueAt);

        // The early warning — the point of the whole thing is to be told
        // before the deadline, not as it passes.
        if (lead > 0) {
          const warnAt = due - lead * 60000;
          if (warnAt > now + 5000) {
            notifications.push(notificationFor(
              t, BAND_EARLY, new Date(warnAt),
              `Due in ${lead} minute${lead === 1 ? '' : 's'}${t.details ? ' — ' + t.details.slice(0, 60) : ''}`
            ));
          }
        }

        notifications.push(notificationFor(t, BAND_DUE, new Date(due), 'Due now.'));
      }

      if (notifications.length) await ln.schedule({ notifications });
    } catch (err) {
      console.warn('[HomeBoard] could not schedule reminders', err);
    }
    return;
  }

  // Browser fallback: only while the page is open.
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  for (const t of webTimers.values()) clearTimeout(t);
  webTimers.clear();
  const lead = leadMinutes();
  for (const t of myUpcoming()) {
    const due = Date.parse(t.dueAt);
    const points = lead > 0 ? [[due - lead * 60000, `Due in ${lead} min`], [due, 'Due now.']] : [[due, 'Due now.']];
    points.forEach(([at, body], i) => {
      const delay = at - Date.now();
      if (delay < 0 || delay > 6 * 60 * 60 * 1000) return;
      webTimers.set(`${t.id}:${i}`, setTimeout(() => {
        try { new Notification(t.title, { body, icon: '/icons/icon-192.png', tag: `${t.id}:${i}` }); } catch {}
      }, delay));
    });
  }
}

/* Snoozing, and opening the task a notification came from. */
async function handleNotificationAction(ln, event) {
  const taskId = event?.notification?.extra?.taskId;
  const title = event?.notification?.title || 'Task';

  if (event?.actionId === 'SNOOZE') {
    try {
      await ensureChannel(ln);
      await ensureActions(ln);
      const at = new Date(Date.now() + SNOOZE_MINUTES * 60000);
      await ln.schedule({
        notifications: [{
          id: (taskId ? taskHash(taskId) : Math.floor(Math.random() * BAND)) + BAND_SNOOZE,
          title,
          body: `Snoozed — still to do.`,
          schedule: { at, allowWhileIdle: true },
          channelId: CHANNEL_ID,
          actionTypeId: ACTION_TYPE,
          smallIcon: 'ic_launcher',
          extra: { taskId },
        }],
      });
      toast(`Snoozed for ${SNOOZE_MINUTES} minutes.`);
    } catch (err) {
      console.warn('[HomeBoard] snooze failed', err);
    }
    return;
  }

  if (taskId && state.tasks.some((t) => t.id === taskId)) openDetail(taskId);
}

/**
 * Clear the scheduled warnings, but leave snoozes alone — the app refreshes
 * every twenty seconds, and cancelling everything would silently throw away a
 * snooze the moment it was set.
 */
async function clearNative(ln, { includeSnoozes = false } = {}) {
  const pending = await ln.getPending();
  const list = (pending?.notifications || []).filter(
    (n) => includeSnoozes || n.id < BAND_SNOOZE
  );
  if (list.length) await ln.cancel({ notifications: list });
}

async function setReminders(on, { quiet = false } = {}) {
  const toggle = $('#reminders-toggle');

  if (!on) {
    localStorage.setItem('hb.reminders', '0');
    await scheduleReminders();
    toggle.checked = false;
    updateRemindersNote();
    $('#lead-field')?.classList.add('hidden');
    $('#battery-help')?.classList.add('hidden');
    return;
  }

  const ln = localNotifications();
  let granted = false;

  if (ln) {
    // Android 13 and later show the system prompt here. If the person has
    // already said no once, requestPermissions returns 'denied' without asking
    // again — the only way back is the app's settings screen.
    let state = (await ln.checkPermissions())?.display;
    if (state === 'prompt' || state === 'prompt-with-rationale') {
      state = (await ln.requestPermissions())?.display;
    }
    granted = state === 'granted';
  } else if ('Notification' in window) {
    granted = Notification.permission === 'granted'
      || (await Notification.requestPermission()) === 'granted';
  } else {
    toggle.checked = false;
    toast('This browser cannot show notifications.');
    return;
  }

  if (!granted) {
    toggle.checked = false;
    localStorage.setItem('hb.reminders', '0');
    toast(
      ln
        ? 'Android is blocking notifications for HomeBoard. Turn them on in Settings → Apps → HomeBoard → Notifications, then try again.'
        : 'Your browser is blocking notifications for this site. Allow them in the padlock menu, then try again.',
      null, 7000
    );
    return;
  }

  localStorage.setItem('hb.reminders', '1');
  toggle.checked = true;
  await scheduleReminders();
  updateRemindersNote();
  updateLeadHint();
  $('#lead-field')?.classList.remove('hidden');
  if (ln) $('#battery-help')?.classList.remove('hidden');

  // Granted, but Android 12+ still downgrades the alarm unless "Alarms &
  // reminders" is allowed. Better to say so than to quietly be ten minutes late.
  if (ln?.checkExactNotificationSetting) {
    try {
      const exact = await ln.checkExactNotificationSetting();
      if (exact?.exact_alarm !== 'granted') {
        toast('Reminders on — but they may arrive late.', {
          label: 'Fix',
          run: async () => {
            try { await ln.changeExactNotificationSetting(); } catch {}
          },
        });
        return;
      }
    } catch { /* older plugin builds don't have this; not worth failing over */ }
  }
  if (!quiet) toast('Reminders on.');
}

/**
 * The switch has to reflect the operating system, not just what we saved.
 * Someone can revoke notifications in Android settings while the app is closed,
 * and coming back to a switch that still says "on" would be a lie.
 */
async function syncRemindersToggle() {
  const toggle = $('#reminders-toggle');
  if (!toggle) return;
  let osAllows = true;
  const ln = localNotifications();
  try {
    if (ln) osAllows = (await ln.checkPermissions())?.display === 'granted';
    else if ('Notification' in window) osAllows = Notification.permission === 'granted';
    else osAllows = false;
  } catch { osAllows = false; }

  if (!osAllows && remindersOn()) {
    localStorage.setItem('hb.reminders', '0');
    await scheduleReminders();
  }
  toggle.checked = remindersOn() && osAllows;
  updateLeadHint();
  $('#lead-field')?.classList.toggle('hidden', !toggle.checked);
  $('#battery-help')?.classList.toggle('hidden', !(toggle.checked && localNotifications()));
  updateRemindersNote();
}

function updateRemindersNote() {
  const note = $('#reminders-note');
  if (!note) return;
  note.textContent = localNotifications()
    ? 'A notification when time runs out on anything assigned to you. Works with HomeBoard closed.'
    : 'A notification when time runs out on anything assigned to you. In a browser this only fires while HomeBoard is open — install the app for reminders that always arrive.';
}

$('#reminders-toggle').addEventListener('change', (e) => setReminders(e.target.checked));

$('#lead-minutes').addEventListener('change', async (e) => {
  localStorage.setItem('hb.leadMinutes', e.target.value);
  updateLeadHint();
  await scheduleReminders();
  const m = Number(e.target.value);
  toast(m ? `You'll be warned ${m} minutes before.` : 'Only reminding you at the due time.');
});

function updateLeadHint() {
  const sel = $('#lead-minutes');
  if (sel) sel.value = String(leadMinutes());
  const hint = $('#lead-hint');
  if (!hint) return;
  const m = leadMinutes();
  if (!m) {
    hint.innerHTML = `You'll only hear about it at the due time. Every reminder carries a <strong>Snooze ${SNOOZE_MINUTES} min</strong> button.`;
    return;
  }
  // Worked example beats an abstract description of the setting.
  const example = new Date();
  example.setHours(21, 30, 0, 0);
  const warn = new Date(example.getTime() - m * 60000);
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  hint.innerHTML =
    `A task due at ${hhmm(example)} warns you at <strong>${hhmm(warn)}</strong>, then again at ${hhmm(example)}. ` +
    `Both carry a <strong>Snooze ${SNOOZE_MINUTES} min</strong> button.`;
}

/* ───────────────────────── push: new tasks ───────────────────────── */

/*
 * A reminder is something the phone can schedule by itself. A task someone has
 * just put on your plate is not — the server has to tell the phone:
 *
 *   APK      Firebase Cloud Messaging via @capacitor/push-notifications. Android
 *            draws the notification itself, so it arrives with HomeBoard closed.
 *   Browser  Web Push. The browser wakes our service worker to show it, so no
 *            HomeBoard tab has to be open.
 *
 * Permission:
 *   APK      Android's own "Allow HomeBoard to send notifications?" dialog is
 *            shown straight after sign-in.
 *   Browser  Browsers (Chrome on Android above all) only show the prompt, or
 *            quietly block it, unless it comes from a tap. So straight after
 *            sign-in we show our own "Turn on notifications" sheet, and the tap
 *            on its button is what asks. It comes back on every launch until
 *            notifications are on.
 *
 * Backstop: while HomeBoard is open or in the background, anything newly put on
 * your plate also raises a local notification — so a device that could not
 * register for push (no Firebase in this APK, iPhone Safari tab, a blocked push
 * service) still hears about it whenever the app is alive.
 */
const pushNative = () => cap()?.PushNotifications || null;
const isNativeApp = () => Boolean(window.Capacitor?.isNativePlatform?.() || cap()?.LocalNotifications || cap()?.PushNotifications);
const FCM_BUILD = Boolean(window.HOMEBOARD_FCM);
const PUSH_CHANNEL_ID = 'homeboard-tasks';
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// 'on' | 'prompt' | 'denied' | 'unsupported' | 'ios-install' | 'no-fcm' | 'error' | 'unknown'
let pushState = 'unknown';
let pushError = '';
let pushCfg = null;
let pushListenersReady = false;
let pendingOpenTaskId = null;

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
const bytesToB64 = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pushConfig() {
  if (!pushCfg) pushCfg = await api('/push/config', { background: true });
  return pushCfg;
}

async function registerDevice(body) {
  const out = await api('/push/subscribe', { method: 'POST', body, background: true });
  // Sent back on every request, so adding a task for yourself on this device
  // buzzes your other devices but not this one.
  if (out?.id) localStorage.setItem('hb.pushDevice', out.id);
}

/** Once permission is there, reminders ride on it too unless someone turned them off. */
async function defaultRemindersOn() {
  if (localStorage.getItem('hb.reminders') !== null) return;
  // Same path as flipping the switch, so the "may arrive late" warning about
  // Android's exact-alarm setting still shows — just without "Reminders on."
  await setReminders(true, { quiet: true });
}

/* ── Android (APK) ── */

async function nativePermission(ask) {
  // Both plugins sit on the same Android permission (POST_NOTIFICATIONS).
  const pn = pushNative();
  const ln = localNotifications();
  const plugin = pn || ln;
  if (!plugin) return 'unsupported';
  const key = pn ? 'receive' : 'display';
  let perm = (await plugin.checkPermissions())?.[key];
  if ((perm === 'prompt' || perm === 'prompt-with-rationale') && ask) {
    perm = (await plugin.requestPermissions())?.[key];
  }
  return perm;
}

async function enableNativePush({ ask }) {
  const perm = await nativePermission(ask);
  if (perm !== 'granted') { pushState = perm === 'denied' ? 'denied' : 'prompt'; return; }
  defaultRemindersOn();

  // The channel new-task notifications arrive on — used by Firebase and by the
  // in-app backstop alike, so create it whichever plugin is present.
  const channel = {
    id: PUSH_CHANNEL_ID,
    name: 'New tasks',
    description: 'When someone puts a task on your plate.',
    importance: 5,
    visibility: 1,
    vibration: true,
    lights: true,
  };
  const pn = pushNative();
  try { await (pn || localNotifications())?.createChannel?.(channel); } catch { /* Android 7 and older */ }

  if (!pn || !FCM_BUILD) { pushState = 'no-fcm'; return; }
  setupNativeListeners(pn);

  await pn.register(); // the token arrives on the 'registration' listener
  pushState = 'on';
}

function setupNativeListeners(pn) {
  if (pushListenersReady || !pn?.addListener) return;
  pushListenersReady = true;

  pn.addListener('registration', async ({ value }) => {
    try {
      await registerDevice({ kind: 'fcm', token: value });
      localStorage.setItem('hb.fcmToken', value);
    } catch (err) {
      pushState = 'error';
      pushError = err.message;
      updatePushUi();
    }
  });

  pn.addListener('registrationError', (err) => {
    console.warn('[HomeBoard] push registration failed', err);
    pushState = 'error';
    pushError = err?.error || 'Firebase registration failed';
    updatePushUi();
  });

  // In the foreground Android does not draw FCM notifications, so we do.
  pn.addListener('pushNotificationReceived', (n) => {
    const d = n?.data || {};
    if (d.taskId) markNotified(d.taskId);
    serverChanged();
    showLocal({ id: d.taskId, title: n.title || 'New task', body: n.body || '' });
  });

  pn.addListener('pushNotificationActionPerformed', (a) => openTaskFromPush(a?.notification?.data?.taskId));
}

/* ── Browser ── */

async function enableWebPush({ ask }) {
  if (isIOS() && !isStandalone()) { pushState = 'ios-install'; return; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    pushState = 'unsupported';
    return;
  }

  // The permission request must be the first thing that awaits, while the tap
  // that led here still counts.
  let perm = Notification.permission;
  if (perm === 'default' && ask) {
    try { perm = await Notification.requestPermission(); } catch { perm = Notification.permission; }
  }
  if (perm !== 'granted') { pushState = perm === 'denied' ? 'denied' : 'prompt'; return; }
  defaultRemindersOn();

  const { webPublicKey } = await pushConfig();
  if (!webPublicKey) { pushState = 'error'; pushError = 'the server has no push key'; return; }

  await navigator.serviceWorker.register('/sw.js');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();

  // A subscription made against an older server key can never be delivered to.
  if (sub && sub.options?.applicationServerKey && bytesToB64(sub.options.applicationServerKey) !== webPublicKey) {
    try { await sub.unsubscribe(); } catch {}
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(webPublicKey) });
  }
  await registerDevice({ kind: 'web', subscription: sub.toJSON() });
  pushState = 'on';
}

/** Get this device ready to receive new-task notifications. Safe to call any time. */
let pushInFlight = null;
function enablePush(opts = {}) {
  // A tap on Allow runs at once: a browser prompt can sit unanswered for ever,
  // and the tap must not queue behind it. Registering twice is harmless.
  if (opts.ask) return doEnablePush(opts);
  if (!pushInFlight) pushInFlight = doEnablePush(opts).finally(() => { pushInFlight = null; });
  return pushInFlight;
}
async function doEnablePush({ ask = false } = {}) {
  if (!state.user) return;
  pushError = '';
  try {
    if (isNativeApp() || pushNative()) await enableNativePush({ ask });
    else await enableWebPush({ ask });
  } catch (err) {
    console.warn('[HomeBoard] could not turn on push', err);
    pushState = 'error';
    pushError = err?.message || String(err);
  }
  updatePushUi();
  if (pushState === 'on' && openSheet === $('#sheet-notify')) {
    closeSheet();
    toast('Notifications on. New tasks will reach you even with HomeBoard closed.');
  }
}

/*
 * Straight after sign-in. On Android the system dialog appears by itself; in
 * a browser our sheet appears, and its button asks.
 */
async function askForNotifications() {
  if (!state.user) return;
  if (isNativeApp() || pushNative()) { await enablePush({ ask: true }); return; }
  await enablePush({ ask: false }); // registers silently if already allowed
  if (!['prompt', 'ios-install', 'denied'].includes(pushState)) return;
  // Once per launch, and never on top of something the person has open —
  // the banner stays up either way.
  if (notifySheetShown) return;
  if (openSheet) { afterSheetClosed = askForNotifications; return; } // e.g. creating a first board
  notifySheetShown = true;
  showNotifySheet();
}
let notifySheetShown = false;

function showNotifySheet() {
  const s = pushState;
  $('#notify-title').textContent =
    s === 'denied' ? 'Notifications are blocked' :
    s === 'ios-install' ? 'Add HomeBoard to your Home Screen' :
    'Turn on notifications';
  $('#notify-text').innerHTML =
    s === 'denied' ? denyHelp() :
    s === 'ios-install'
      ? 'On iPhone, notifications only work from the Home Screen app. Tap <strong>Share</strong> ' +
        '<span aria-hidden="true">⎋</span> → <strong>Add to Home Screen</strong>, then open HomeBoard from there and sign in.'
      : 'So you know <strong>the moment someone adds a task for you</strong> — even with HomeBoard closed. ' +
        'Tap the button, then choose <strong>Allow</strong>.';
  $('#notify-go').classList.toggle('hidden', s !== 'prompt');
  sheet('#sheet-notify');
}

function denyHelp() {
  if (isNativeApp()) return 'Open <strong>Settings → Apps → HomeBoard → Notifications</strong> and switch them on, then come back to HomeBoard.';
  if (isStandalone()) return 'Long-press the HomeBoard icon → <strong>App info → Notifications</strong> → allow. Then reopen HomeBoard.';
  if (/Android/.test(navigator.userAgent)) return 'In Chrome, tap the <strong>ⓘ / padlock</strong> left of the address → <strong>Permissions → Notifications → Allow</strong>. Then reload.';
  return 'Click the <strong>padlock</strong> left of the address → <strong>Notifications → Allow</strong>. Then reload the page.';
}

/* ── Backstop: notice new tasks whenever the app is alive ── */

const SEEN_KEY = 'hb.seenTasks';
function seenTasks() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || 'null') || []); } catch { return null; }
}
function markNotified(taskId) {
  const seen = seenTasks() || new Set();
  seen.add(taskId);
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-300)));
}

async function showLocal({ id, title, body }) {
  if (document.visibilityState === 'visible') { toast(`${title} — ${body}`, id ? { label: 'Open', run: () => openTaskFromPush(id) } : null, 6000); return; }
  const ln = localNotifications();
  try {
    if (ln) {
      await ln.schedule({ notifications: [{
        id: (id ? taskHash(id) : Math.floor(Math.random() * BAND)) + BAND_SNOOZE + 1,
        title, body, channelId: PUSH_CHANNEL_ID, smallIcon: 'ic_launcher', extra: { taskId: id },
      }] });
      return;
    }
    if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
        tag: id ? `task:${id}` : undefined, data: { taskId: id }, vibrate: [200, 100, 200],
      });
    }
  } catch (err) { console.warn('[HomeBoard] local notification failed', err); }
}

/** Called after every refresh. Tells you about tasks newly on your plate. */
function noticeNewTasks() {
  if (!state.user) return;
  const mine = state.tasks.filter((t) => t.assigneeId === state.user.id);
  const seen = seenTasks();
  if (!seen) {
    // First run on this device: everything already here is old news.
    localStorage.setItem(SEEN_KEY, JSON.stringify(mine.map((t) => t.id)));
    return;
  }
  const fresh = mine.filter((t) => !seen.has(t.id));
  if (!fresh.length) return;
  fresh.forEach((t) => seen.add(t.id));
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-300)));

  // Push already told this device — don't say it twice.
  if (pushState === 'on') return;
  for (const t of fresh.slice(0, 5)) {
    const self = t.createdById === state.user.id;
    if (self && document.visibilityState === 'visible') continue;
    const who = t.createdBy?.name?.split(/\s+/)[0] || 'Someone';
    const board = state.projects.find((p) => p.id === t.projectId)?.name;
    showLocal({ id: t.id, title: self ? 'New task on your plate' : `New task from ${who}`, body: `${t.title}${board ? ` — ${board}` : ''}` });
  }
}

/* ── Opening a task from a notification ── */

async function openTaskFromPush(taskId) {
  if (!taskId) return;
  // Tapped with the app killed: this fires before sign-in has finished.
  if (!state.user || !state.projects.length) { pendingOpenTaskId = taskId; return; }
  if (!state.tasks.some((t) => t.id === taskId)) { try { await syncNow({ reason: 'open-task' }); } catch {} }
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) { toast('That task is no longer on the board.'); return; }
  if (task.projectId !== state.activeId) { state.activeId = task.projectId; localStorage.setItem('hb.board', task.projectId); render(); }
  openDetail(taskId);
}

async function disablePush() {
  try {
    const token = localStorage.getItem('hb.fcmToken');
    if (token) {
      await api('/push/unsubscribe', { method: 'POST', body: { kind: 'fcm', token }, background: true });
      localStorage.removeItem('hb.fcmToken');
    }
    if (!isNativeApp() && 'serviceWorker' in navigator && 'PushManager' in window) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api('/push/unsubscribe', { method: 'POST', body: { kind: 'web', subscription: sub.toJSON() }, background: true });
        await sub.unsubscribe();
      }
    }
  } catch { /* signing out goes ahead regardless */ }
  localStorage.removeItem('hb.pushDevice');
  localStorage.removeItem(SEEN_KEY);
  pushState = 'unknown';
  updatePushUi();
}

/* ── UI ── */

function updatePushUi() {
  const banner = $('#push-banner');
  const text = $('#push-banner-text');
  const bannerBtn = $('#push-banner-btn');
  const status = $('#push-status');
  const allow = $('#push-allow');
  const test = $('#push-test');
  const signedIn = Boolean(state.user);

  const copy = {
    on: 'On — you get a notification as soon as someone puts a task on your plate, even with HomeBoard closed.',
    prompt: 'Not on yet. Tap Allow notifications so new tasks reach you with HomeBoard closed.',
    denied: 'Blocked. ' + denyHelp().replace(/<[^>]+>/g, ''),
    'ios-install': 'On iPhone: Share → Add to Home Screen, then open HomeBoard from the Home Screen and allow notifications.',
    unsupported: 'This browser cannot receive push notifications. Use Chrome, Edge or Firefox, or install the app. You will still be told about new tasks while HomeBoard is open.',
    'no-fcm': 'This APK was built without Firebase, so new tasks only reach you while HomeBoard is open or in the background. For notifications with the app closed, rebuild it with the GOOGLE_SERVICES_JSON secret (README §7).',
    error: `Could not turn notifications on${pushError ? ` (${pushError})` : ''}. Tap Allow notifications to try again.`,
    unknown: 'Checking notifications…',
  };

  if (status) status.textContent = copy[pushState] || copy.unknown;
  allow?.classList.toggle('hidden', !(pushState === 'prompt' || pushState === 'error'));
  test?.classList.toggle('hidden', !(pushState === 'on' || pushState === 'no-fcm'));

  const showBanner = signedIn && ['prompt', 'denied', 'error', 'ios-install'].includes(pushState);
  banner?.classList.toggle('hidden', !showBanner);
  if (text) {
    text.textContent =
      pushState === 'denied' ? 'Notifications are blocked — tap Fix to see how to allow them.' :
      pushState === 'ios-install' ? 'Add HomeBoard to your Home Screen to get notifications.' :
      'So you hear about new tasks the moment they are put on your plate.';
  }
  if (bannerBtn) bannerBtn.textContent = pushState === 'prompt' || pushState === 'error' ? 'Allow' : 'Fix';
}

async function renderPushDiagnostics() {
  const box = $('#push-diag');
  if (!box || !state.user) return;
  const lines = [];
  lines.push(`This device: ${isNativeApp() ? `Android app${FCM_BUILD ? ' (Firebase)' : ' (no Firebase)'}` : isStandalone() ? 'installed web app' : 'browser tab'}`);
  if ('Notification' in window && !isNativeApp()) lines.push(`Browser permission: ${Notification.permission}`);
  lines.push(`Status: ${pushState}${pushError ? ` — ${pushError}` : ''}`);
  try {
    const s = await api('/push/status');
    lines.push(`Server: web push ${s.web ? 'on' : 'OFF'}, Android push ${s.fcm ? 'on' : 'OFF (no FCM_SERVICE_ACCOUNT)'}`);
    const me = localStorage.getItem('hb.pushDevice');
    if (!s.devices.length) lines.push('Registered devices: none');
    for (const d of s.devices) {
      const last = d.last ? `${d.last.ok ? 'last push delivered' : 'last push FAILED'} ${ago(d.last.at)}${d.last.ok ? '' : ` — ${d.last.detail}`}` : 'no push sent yet';
      lines.push(`• ${d.id === me ? 'this device' : 'another device'} (${d.kind === 'fcm' ? 'Android' : d.service}) — ${last}`);
    }
  } catch (err) {
    lines.push(`Server: ${err.message}`);
  }
  box.textContent = lines.join('\n');
}

$('#push-banner-btn').addEventListener('click', () => {
  if (pushState === 'prompt' || pushState === 'error') enablePush({ ask: true });
  else showNotifySheet();
});
$('#push-allow').addEventListener('click', () => enablePush({ ask: true }));
$('#notify-go').addEventListener('click', () => enablePush({ ask: true }));
$('#notify-later').addEventListener('click', () => closeSheet());
$('#push-test').addEventListener('click', async () => {
  try {
    const out = await api('/push/test', { method: 'POST' });
    toast(out.sent ? 'Sent — it should appear in a moment. Try it with the app closed, too.' : 'No device took it — see Troubleshoot below.');
    setTimeout(renderPushDiagnostics, 1500);
  } catch (err) { toast(err.message); }
});
$('#push-diag-wrap')?.addEventListener('toggle', (e) => { if (e.target.open) renderPushDiagnostics(); });

// Messages from the service worker.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type === 'hb-push') { if (msg.data?.taskId) markNotified(msg.data.taskId); serverChanged(); }
    else if (msg.type === 'hb-open-task') openTaskFromPush(msg.taskId);
    else if (msg.type === 'hb-resubscribe') enablePush({ ask: false });
  });

  // A new version of the app took over: reload once so the page runs the new
  // code instead of the copy the old worker served from its cache.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded || openSheet) return;
    reloaded = true;
    location.reload();
  });
}

// Coming back after changing the setting in Android or the browser.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user && pushState !== 'on') enablePush({ ask: false });
});

// Registered at startup, not after sign-in, so a tap that cold-started the app is not missed.
(function earlyNativeListeners() {
  const pn = pushNative();
  if (pn && FCM_BUILD) setupNativeListeners(pn);
})();

/* ───────────────────────── QR invites ───────────────────────── */

const joinLink = (project) => `${location.origin}/?join=${encodeURIComponent(project.inviteCode)}`;

function renderInviteQr(project) {
  const box = $('#invite-qr');
  if (!box) return;
  try {
    box.innerHTML = window.HomeBoardQR.toSvg(joinLink(project), {
      size: 184, margin: 2, dark: '#16302f', light: '#ffffff',
    });
  } catch (err) {
    box.innerHTML = `<p class="qr-note">${esc(err.message)}</p>`;
  }
}

$('#save-qr').addEventListener('click', () => {
  const project = activeProject();
  if (!project) return;
  const svg = window.HomeBoardQR.toSvg(joinLink(project), { size: 640, margin: 3 });
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `homeboard-${project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-invite.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('QR saved.');
});

/** Someone scanned a code, or opened an invite link. */
async function handleJoinLink() {
  const code = new URLSearchParams(location.search).get('join');
  if (!code) return;
  history.replaceState({}, '', location.pathname);

  if (!state.user) { localStorage.setItem('hb.pendingJoin', code); return; }
  try {
    const { project, message } = await api('/projects/join', { method: 'POST', body: { code } });
    state.activeId = project.id;
    await loadAll();
    toast(message);
  } catch (err) {
    toast(err.message);
  }
}

async function consumePendingJoin() {
  const code = localStorage.getItem('hb.pendingJoin');
  if (!code) return;
  localStorage.removeItem('hb.pendingJoin');
  try {
    const { project, message } = await api('/projects/join', { method: 'POST', body: { code } });
    state.activeId = project.id;
    await loadAll();
    toast(message);
  } catch (err) {
    toast(err.message);
  }
}

/* ───────────────────────── leaving for good ───────────────────────── */

$('#delete-account').addEventListener('click', async () => {
  if (!confirm('Delete your HomeBoard account?\n\nThis removes your account, any board only you are on, and every task on it. It cannot be undone.')) return;
  if (!confirm('Last check — this is permanent. Delete the account?')) return;
  try {
    const out = await api('/auth/me', { method: 'DELETE' });
    forgetLocal();
    bioOff({ server: false }); // the server already removed this account's keys
    localStorage.removeItem(PW_KEY);
    appVisible = false;
    setToken(null);
    state.user = null;
    state.projects = [];
    state.tasks = [];
    stopPolling();
    closeSheet();
    showAuth();
    toast(out.boardsDeleted ? `Account deleted, along with ${out.boardsDeleted} board${out.boardsDeleted === 1 ? '' : 's'}.` : 'Account deleted.');
  } catch (err) {
    alert(err.message);
  }
});

/* React to a notification being tapped or snoozed. */
(function notificationListeners() {
  const ln = localNotifications();
  if (!ln?.addListener) return;
  ln.addListener('localNotificationActionPerformed', (event) => handleNotificationAction(ln, event));
})();

/* Closing the app, and making the Android back button behave. */
(function androidShell() {
  const App = cap()?.App;
  if (!App) return;
  $('#exit-btn').classList.remove('hidden');
  $('#exit-btn').addEventListener('click', () => App.exitApp());
  App.addListener('backButton', () => {
    if (openSheet) { closeSheet(); return; }
    if (state.view !== 'mine' && state.user) {
      $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === 'mine')));
      state.view = 'mine';
      render();
      return;
    }
    App.exitApp();
  });
})();

/* ───────────────────────── fingerprint ───────────────────────── */

/*
 * Sign in with the password once, turn fingerprint on, and from then on the
 * fingerprint is enough — on the lock screen when HomeBoard opens, and on the
 * sign-in screen after signing out or when a session has run out.
 *
 *   APK      Android's own fingerprint prompt (@capgo/capacitor-native-biometric).
 *   Browser  WebAuthn with the phone's built-in authenticator (fingerprint,
 *            face, or screen lock) — Chrome on Android, Safari on iPhone.
 *
 * Turning it on gives this phone a device key from the server. The phone only
 * uses that key after the fingerprint matches, and swaps it for a session. The
 * fingerprint itself never leaves the phone. Turning it off deletes the key on
 * the server, so it stops working even if the phone is lost.
 */
const BIO_KEY = 'hb.bio';   // { userId, email, name, kind, credId?, deviceId, secret }
const BIO_DISMISSED = 'hb.bioDismissed';
const LOCK_AFTER_MS = 5 * 60 * 1000;
const nativeBio = () => cap()?.NativeBiometric || null;
const inApk = () => Boolean(window.Capacitor?.isNativePlatform?.()) || isNativeApp();

function bioSaved() { try { return JSON.parse(localStorage.getItem(BIO_KEY) || 'null'); } catch { return null; } }
const bioOnFor = (userId) => Boolean(userId) && bioSaved()?.userId === userId;

const NATIVE_UNAVAILABLE = {
  1: 'This phone has no fingerprint sensor HomeBoard can use.',
  2: 'Fingerprint is locked on this phone after too many tries. Unlock the phone with your PIN, then try again.',
  3: 'No fingerprint is set up on this phone. Add one in Android Settings → Security → Fingerprint, then come back.',
  4: 'Too many tries — fingerprint is paused for a moment. Try again shortly.',
  14: 'This phone has no screen lock. Set a PIN and a fingerprint in Android Settings first.',
};

/** { kind: 'native' | 'web' | null, reason } — reason says why not, in plain words. */
async function bioStatus() {
  const nb = nativeBio();
  if (nb) {
    try {
      const r = await nb.isAvailable();
      if (r?.isAvailable) return { kind: 'native', reason: '' };
      return { kind: null, reason: NATIVE_UNAVAILABLE[r?.errorCode] || 'Android says fingerprint is not available on this phone right now.' };
    } catch (err) {
      return { kind: null, reason: `Could not check the fingerprint sensor (${err?.message || err}).` };
    }
  }
  // Inside the APK the WebView can't do browser fingerprint (WebAuthn), so
  // without the plugin there is nothing to use — say so rather than try.
  if (inApk()) {
    return { kind: null, reason: 'This copy of the app was built without fingerprint support. Re-run "Build Android APK" on GitHub and reinstall it.' };
  }
  if (!window.isSecureContext) return { kind: null, reason: 'Fingerprint needs HomeBoard to be opened over https.' };
  if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) {
    return { kind: null, reason: 'This browser cannot use the phone\'s fingerprint. Try Chrome on Android or Safari on iPhone.' };
  }
  try {
    if (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) return { kind: 'web', reason: '' };
  } catch { /* fall through */ }
  return { kind: null, reason: 'No fingerprint or screen lock is set up on this device.' };
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/* Errors from the prompt, in plain words. `cancelled` = the person closed it. */
function bioError(err) {
  const code = String(err?.code ?? '');
  if (code === '16' || code === '15' || err?.name === 'AbortError') return { cancelled: true, text: 'The fingerprint prompt was closed.' };
  if (err?.name === 'NotAllowedError') {
    return { cancelled: true, text: 'The fingerprint prompt was closed or timed out. If no prompt appeared, check that a fingerprint and screen lock are set up on this phone.' };
  }
  if (code === '10') return { cancelled: false, text: 'Fingerprint not recognised.' };
  if (NATIVE_UNAVAILABLE[code]) return { cancelled: false, text: NATIVE_UNAVAILABLE[code] };
  if (err?.name === 'InvalidStateError') return { cancelled: false, text: 'This phone already has a HomeBoard fingerprint key. Turn it off and on again.' };
  if (err?.name === 'SecurityError') return { cancelled: false, text: 'The browser blocked fingerprint for this address (it needs https).' };
  return { cancelled: false, text: err?.message ? `Fingerprint failed: ${err.message}${code ? ` (code ${code})` : ''}` : 'Fingerprint failed.' };
}

/** Ask for the fingerprint. Resolves when it matched; throws otherwise. */
async function bioCheck(kind, credId, reason) {
  if (kind === 'native') {
    const nb = nativeBio();
    if (!nb) throw new Error('This copy of the app has no fingerprint support.');
    await nb.verifyIdentity({ reason, title: 'HomeBoard', subtitle: reason, negativeButtonText: 'Cancel', maxAttempts: 5 });
    return null;
  }
  if (kind === 'web') {
    const publicKey = credId
      ? {
          challenge: randomBytes(32),
          allowCredentials: [{ type: 'public-key', id: b64ToBytes(credId), transports: ['internal'] }],
          userVerification: 'required',
          timeout: 60000,
        }
      : null;
    if (publicKey) {
      const cred = await navigator.credentials.get({ publicKey });
      if (!cred) throw new Error('Not recognised.');
      // Flags byte: 0x04 = the person was verified (finger/face/screen lock), not just present.
      if (!(new Uint8Array(cred.response.authenticatorData)[32] & 0x04)) throw new Error('Your phone did not confirm it was you.');
      return null;
    }
    // First time: make this phone's key. Creating it already needs the finger.
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: 'HomeBoard' },
        user: {
          id: new TextEncoder().encode(state.user.id),
          name: state.user.email || state.user.name,
          displayName: state.user.name || state.user.email,
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000,
        attestation: 'none',
      },
    });
    if (!cred) throw new Error('Fingerprint setup was cancelled.');
    return bytesToB64(cred.rawId);
  }
  throw new Error('Fingerprint is not set up on this device.');
}

async function bioEnroll() {
  const { kind, reason } = await bioStatus();
  if (!kind) throw new Error(reason);
  const credId = await bioCheck(kind, null, 'Confirm to sign in with your fingerprint');
  const old = bioSaved();
  const { deviceId, secret } = await api('/auth/device', {
    method: 'POST',
    body: { label: navigator.userAgent.slice(0, 80), replaces: old?.userId === state.user.id ? old.deviceId : undefined },
  });
  localStorage.setItem(BIO_KEY, JSON.stringify({
    userId: state.user.id, email: state.user.email, name: state.user.name, user: state.user,
    kind, credId: credId || null, deviceId, secret,
  }));
}

function bioOff({ server = true } = {}) {
  const saved = bioSaved();
  localStorage.removeItem(BIO_KEY);
  if (server && saved?.deviceId && getToken()) {
    api(`/auth/device/${encodeURIComponent(saved.deviceId)}`, { method: 'DELETE', background: true }).catch(() => {});
  }
}

/** Swap the device key for a fresh session. */
async function bioSession(saved, { background = true } = {}) {
  try {
    const out = await api('/auth/device/signin', {
      method: 'POST', background, noSession: true, body: { deviceId: saved.deviceId, secret: saved.secret },
    });
    if (out?.token) setToken(out.token);
    if (out?.user?.id && state.user?.id === out.user.id) { state.user = out.user; saveLocal(); rememberBioUser(out.user); }
    return out;
  } catch (err) {
    if (err.status === 401) {
      bioOff({ server: false });
      updateBioUi();
      if (state.user) signOutHere(err.message);
    }
    throw err;
  }
}
/** The fingerprint's way to get a session: swap the device key. */
function bioGetter() {
  return async () => { const saved = bioSaved(); if (saved?.deviceId) await bioSession(saved); };
}
function rememberBioUser(user) {
  const saved = bioSaved();
  if (saved && saved.userId === user.id) localStorage.setItem(BIO_KEY, JSON.stringify({ ...saved, user, name: user.name, email: user.email }));
}

/** End the session on this phone only and show sign-in, with a reason. */
function signOutHere(message) {
  setToken(null);
  sessionGetter = null;
  stopPolling();
  appVisible = false;
  state.user = null;
  setAuthMode('signin');
  showAuth();
  if (message) {
    const box = $('#auth-alert');
    box.textContent = message;
    box.className = 'alert alert-error';
    box.classList.remove('hidden');
  }
}

/* ── lock screen: there is a session on the phone; the finger opens it ── */

let unlockWaiter = null;
let appVisible = false;

function waitForUnlock(user) {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.add('hidden');
  closeSheet();
  $('#lock-hello').textContent = `Welcome back${user?.name ? `, ${user.name.split(/\s+/)[0]}` : ''}`;
  $('#lock-sub').textContent = bioSaved()?.kind === 'web'
    ? 'Use your fingerprint (or screen lock) to open HomeBoard.'
    : 'Touch the fingerprint sensor to open HomeBoard.';
  $('#lock-alert').classList.add('hidden');
  $('#lock-screen').classList.remove('hidden');
  return new Promise((resolve) => {
    unlockWaiter = resolve;
    tryUnlock({ auto: true });
  });
}

async function tryUnlock({ auto = false } = {}) {
  const btn = $('#lock-unlock');
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  $('#lock-alert').classList.add('hidden');
  const saved = bioSaved();
  try {
    await bioCheck(saved?.kind, saved?.credId, 'Open HomeBoard');
    $('#lock-screen').classList.add('hidden');
    if (appVisible) $('#app-screen').classList.remove('hidden');
    const done = unlockWaiter;
    unlockWaiter = null;
    // A fresh session from the device key — so an old one never runs out.
    if (saved?.deviceId) { sessionGetter = bioGetter(); bioSession(saved).catch(() => {}); }
    done?.();
  } catch (err) {
    const e = bioError(err);
    // A browser may refuse a prompt that didn't come from a tap — that's what
    // the big button is for, so a cancelled automatic first try stays quiet.
    if (!(auto && e.cancelled)) {
      $('#lock-alert').textContent = `${e.text} Tap the fingerprint to try again, or use your password.`;
      $('#lock-alert').classList.remove('hidden');
    }
  } finally {
    btn.classList.remove('busy');
  }
}

$('#lock-unlock').addEventListener('click', () => tryUnlock());
$('#lock-password').addEventListener('click', () => {
  const email = state.user?.email;
  unlockWaiter = null;
  setToken(null);
  stopPolling();
  appVisible = false;
  state.user = null;
  $('#lock-screen').classList.add('hidden');
  setAuthMode('signin');
  if (email) $('#auth-form [name=email]').value = email;
  showAuth();
});

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  if (state.user && appVisible && bioOnFor(state.user.id) && !unlockWaiter
      && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) {
    waitForUnlock(state.user);
  }
});

/* ── sign-in screen: no session; the finger signs in ── */

function updateBioSignin() {
  const saved = bioSaved();
  const box = $('#bio-signin');
  if (!box) return;
  const show = Boolean(saved?.deviceId) && authMode === 'signin';
  box.classList.toggle('hidden', !show);
  if (show) $('#bio-signin-who').textContent = saved.name ? `${saved.name} · ${saved.email || ''}` : (saved.email || '');
}

async function bioSignin({ auto = false } = {}) {
  const saved = bioSaved();
  if (!saved?.deviceId) return;
  const btn = $('#bio-signin-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const alert = $('#auth-alert');
  alert.classList.add('hidden');
  try {
    await bioCheck(saved.kind, saved.credId, 'Sign in to HomeBoard');
    // In on the finger alone — the server session follows in the background.
    setToken(null);
    state.user = saved.user || { id: saved.userId, name: saved.name, email: saved.email };
    sessionGetter = bioGetter();
    await boot();
    sessionInBackground();
    handleJoinLink();
  } catch (err) {
    const e = err.status || err.offline ? { cancelled: false, text: err.message } : bioError(err);
    if (!(auto && e.cancelled)) {
      alert.textContent = e.text;
      alert.className = 'alert alert-error';
      alert.classList.remove('hidden');
    }
    updateBioSignin();
  } finally {
    btn.disabled = false;
  }
}
$('#bio-signin-btn').addEventListener('click', () => bioSignin());

/* ── turning it on and off ── */

async function updateBioUi() {
  const { kind, reason } = await bioStatus();
  const on = bioOnFor(state.user?.id);
  const toggle = $('#bio-toggle');
  if (toggle && !toggle.dataset.busy) {
    toggle.checked = on;
    toggle.disabled = !kind && !on;
  }
  const note = $('#bio-note');
  if (note) {
    note.textContent = !kind && !on ? reason
      : on ? 'On. Your fingerprint opens HomeBoard and signs you in — no password. The fingerprint stays on this phone.'
      : 'Sign in and open HomeBoard with your fingerprint instead of your password. The fingerprint stays on this phone.';
  }
  const banner = $('#bio-banner');
  if (banner) banner.classList.toggle('hidden', !(kind && !on && !localStorage.getItem(BIO_DISMISSED)));
  updateBioSignin();
}

async function turnBioOn() {
  const toggle = $('#bio-toggle');
  toggle.dataset.busy = '1';
  toggle.checked = true;
  try {
    await bioEnroll();
    toast('Fingerprint is on. Next time, just use your finger.');
  } catch (err) {
    const e = err.status || err.offline ? { text: err.message } : bioError(err);
    toast(`Fingerprint not turned on — ${e.text}`, null, 8000);
  } finally {
    delete toggle.dataset.busy;
    updateBioUi();
  }
}

$('#bio-toggle').addEventListener('change', (e) => {
  if (e.target.checked) turnBioOn();
  else { bioOff(); toast('Fingerprint is off on this phone.'); updateBioUi(); }
});
$('#bio-banner-on').addEventListener('click', () => turnBioOn());
$('#bio-banner-dismiss').addEventListener('click', () => {
  localStorage.setItem(BIO_DISMISSED, '1');
  $('#bio-banner').classList.add('hidden');
});

/* Turned on by the previous version (no device key yet): get one quietly. */
async function upgradeBioKey() {
  const saved = bioSaved();
  if (!saved || saved.deviceId || saved.userId !== state.user?.id) return;
  try {
    const { deviceId, secret } = await api('/auth/device', { method: 'POST', background: true, body: {} });
    localStorage.setItem(BIO_KEY, JSON.stringify({ ...saved, email: state.user.email, name: state.user.name, deviceId, secret }));
  } catch { /* next time */ }
}

/* ───────────────────────── boot ───────────────────────── */

async function boot() {
  if (!state.user?.id) { showAuth(); return; }
  $('#auth-screen').classList.add('hidden');
  $('#lock-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  appVisible = true;
  updateBioUi();
  upgradeBioKey();
  $('#my-avatar').style.background = state.user.avatarColor || '#0f766e';
  $('#my-avatar').textContent = initials(state.user.name);
  await syncRemindersToggle();
  // Draw from the copy on this device first — instant, and works with no signal.
  loadLocal();
  rebuild();
  render();
  updateSyncUi();
  // Nothing in boot waits for the server. The first download on a new phone,
  // and the sync-on-open, both run behind the board.
  if (!local.base) {
    syncNow({ reason: 'first' }).catch((err) => { local.lastError = err.message; render(); });
  } else if (syncOnEdges()) {
    autoSync('open');
  }
  noticeNewTasks();
  consumePendingJoin();
  scheduleReminders();
  startPolling();
  // Straight after sign-in: ask for notification permission.
  askForNotifications();
  if (pendingOpenTaskId) { const id = pendingOpenTaskId; pendingOpenTaskId = null; openTaskFromPush(id); }
  // Opened from a notification in a browser.
  const fromPush = new URLSearchParams(location.search).get('task');
  if (fromPush) {
    history.replaceState({}, '', location.pathname);
    openTaskFromPush(fromPush);
  }
}

(async function start() {
  if (!getToken()) {
    const code = new URLSearchParams(location.search).get('join');
    if (code) {
      localStorage.setItem('hb.pendingJoin', code);
      history.replaceState({}, '', location.pathname);
      setAuthMode('signup');
      $('#auth-note').textContent = 'Create your account and you will join the board straight away.';
      showAuth();
      return;
    }
    setAuthMode('signin'); showAuth();
    if (bioSaved()?.deviceId) bioSignin({ auto: true });
    return;
  }
  // Signed in before on this device: open straight from the local copy, then
  // check the session in the background. Only a real "signed out" (401) ends it.
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('hb.user') || 'null'); } catch {}
  if (cached?.id) {
    state.user = cached;
    if (bioOnFor(cached.id)) await waitForUnlock(cached);
    try { await boot(); } catch (err) { toast(err.offline ? 'Offline — showing what is on this device.' : err.message); }
    api('/auth/me', { background: true })
      .then(({ user }) => { if (user?.id && state.user?.id === user.id) { state.user = user; saveLocal(); } })
      .catch(() => {});
    handleJoinLink();
    return;
  }
  try {
    const { user } = await api('/auth/me');
    if (!user?.id) throw new Error('no account returned');
    state.user = user;
    await boot();
    await handleJoinLink();
  } catch (err) {
    setToken(null);
    setAuthMode('signin');
    showAuth();
    // A dead API base is worth saying out loud rather than silently showing a
    // sign-in box that can never succeed.
    if (/pointed at|did not send an account/.test(err.message || '')) {
      const box = $('#auth-alert');
      box.textContent = err.message;
      box.className = 'alert alert-error';
      box.classList.remove('hidden');
    }
  }
})();

})();
