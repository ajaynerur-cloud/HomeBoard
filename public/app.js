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

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

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
      if (elapsed < WAKE_DEADLINE_MS) {
        showWaking();
        await sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)]);
        attempt++;
        continue;
      }
      hideWaking();
      throw new Error(
        `Could not reach HomeBoard — ${lastReason}. If it has been asleep a while, give it a moment and try again.`
      );
    }

    hideWaking();

    let data = {};
    try { data = await res.json(); } catch { /* an empty body is fine */ }

    if (res.status === 401 && state.user) {
      setToken(null);
      state.user = null;
      showAuth();
      throw new Error(data.error || 'Please sign in again.');
    }
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
    return data;
  }
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
function closeSheet() {
  if (openSheet) openSheet.classList.remove('open');
  $('#scrim').classList.remove('open');
  openSheet = null;
  document.body.style.overflow = '';
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
    const data = await api(`/auth/${authMode}`, { method: 'POST', body: payload });
    if (!data?.token || !data?.user?.id) {
      throw new Error('The server replied but did not send an account back. Check that the app is pointed at your HomeBoard server.');
    }
    setToken(data.token);
    state.user = data.user;
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

/* ───────────────────────── data loading ───────────────────────── */

async function loadAll() {
  const [{ projects }, { tasks }, { history }] = await Promise.all([
    api('/projects'),
    api('/tasks'),
    api('/tasks/history/list'),
  ]);
  state.projects = projects;
  state.tasks = tasks;
  state.history = history;
  if (!state.projects.some((p) => p.id === state.activeId)) {
    state.activeId = state.projects[0]?.id || null;
  }
  render();
}

async function refreshTasks() {
  const [{ tasks }, { history }] = await Promise.all([api('/tasks'), api('/tasks/history/list')]);
  state.tasks = tasks;
  state.history = history;
  render();
  scheduleReminders();
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

$('#task-save').addEventListener('click', async () => {
  const form = $('#task-form');
  const btn = $('#task-save');
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
    checklist: state.draftChecks.filter((c) => c.text.trim()),
  };

  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    if (state.editing) await api(`/tasks/${state.editing.id}`, { method: 'PATCH', body: payload });
    else await api('/tasks', { method: 'POST', body: payload });
    closeSheet();
    await refreshTasks();
    const who = activeProject().members.find((m) => m.user.id === assigneeId)?.user;
    toast(
      state.editing ? 'Task updated.'
      : assigneeId === state.user.id ? 'Added to your list.'
      : `Sent to ${who?.name?.split(' ')[0] || 'them'}.`
    );
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
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
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { assigneeId: btn.dataset.uid } });
      await refreshTasks();
      renderDetail();
      const who = activeProject().members.find((m) => m.user.id === btn.dataset.uid)?.user;
      toast(btn.dataset.uid === state.user.id ? 'You took this on.' : `Passed to ${who?.name?.split(' ')[0]}.`);
    } catch (err) { toast(err.message); }
  });

  $('#detail-checks')?.addEventListener('change', async (e) => {
    if (e.target.type !== 'checkbox') return;
    const row = e.target.closest('.check');
    row.classList.toggle('done', e.target.checked);
    const next = steps.map((s) => (s.id === row.dataset.cid ? { ...s, done: e.target.checked } : s));
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { checklist: next } });
      await refreshTasks();
      renderDetail();
    } catch (err) { toast(err.message); }
  });

  $('#note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.elements.text;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await api(`/tasks/${task.id}/comments`, { method: 'POST', body: { text } });
      await refreshTasks();
      renderDetail();
    } catch (err) { toast(err.message); }
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
  try {
    await api(`/tasks/${task.id}`, { method: 'DELETE' });
    closeSheet();
    await refreshTasks();
    toast('Task deleted.');
  } catch (err) { toast(err.message); }
});

async function completeTask(id, title) {
  const card = $(`.task[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.add('completing');
  try {
    const res = await api(`/tasks/${id}/complete`, { method: 'POST' });
    await refreshTasks();
    // The server hands the task back once and keeps no copy. If Undo isn't
    // pressed before the toast goes, it really is gone.
    toast(`“${title}” done.`, {
      label: 'Undo',
      run: async () => {
        try {
          await api('/tasks/restore', { method: 'POST', body: { task: res.undo, historyId: res.history?.id } });
          await refreshTasks();
          toast('Put back.');
        } catch (err) { toast(err.message); }
      },
    });
  } catch (err) {
    card?.classList.remove('completing');
    toast(err.message);
  }
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
  const av = $('#acct-avatar');
  av.style.background = state.user.avatarColor || '#0f766e';
  av.textContent = initials(state.user.name);
  $('#acct-name').textContent = state.user.name;
  $('#acct-email').textContent = state.user.email;
  sheet('#sheet-account');
});

$('#signout-btn').addEventListener('click', async () => {
  try { await api('/auth/signout', { method: 'POST' }); } catch { /* sign out locally anyway */ }
  setToken(null);
  state.user = null;
  state.projects = [];
  state.tasks = [];
  stopPolling();
  closeSheet();
  showAuth();
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
const POLL_MS = 20000;
let pollTimer = null;
let refreshing = false;

async function refreshNow({ silent = false } = {}) {
  if (refreshing || !state.user) return;
  refreshing = true;
  const btn = $('#refresh-btn');
  if (!silent) btn?.classList.add('spinning');
  try {
    await loadAll();
    if (openSheet === $('#sheet-detail') && state.detailId) renderDetail();
    if (openSheet === $('#sheet-members')) renderMembers();
    scheduleReminders();
  } catch {
    // A failed poll is not worth interrupting anyone over; the next one retries.
  } finally {
    refreshing = false;
    if (!silent) setTimeout(() => btn?.classList.remove('spinning'), 350);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshNow({ silent: true });
  }, POLL_MS);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

$('#refresh-btn').addEventListener('click', async () => {
  await refreshNow();
  toast('Up to date.');
});

/* Pull down at the top of the list to refresh. */
(function pullToRefresh() {
  const main = document.querySelector('main');
  const indicator = document.createElement('div');
  indicator.className = 'pull';
  indicator.textContent = 'Pull to refresh';
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
    indicator.textContent = armed ? 'Release to refresh' : 'Pull to refresh';
  }, { passive: true });

  const end = async () => {
    if (!pulling) return;
    pulling = false;
    const armed = indicator.classList.contains('armed');
    indicator.style.height = '0px';
    indicator.classList.remove('armed');
    if (armed) { await refreshNow(); toast('Up to date.'); }
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

/** Stable 31-bit id per task, because the plugin wants integers. */
function notifId(taskId) {
  let h = 0;
  for (let i = 0; i < taskId.length; i++) h = (h * 31 + taskId.charCodeAt(i)) | 0;
  return Math.abs(h) % 2147483647;
}

const webTimers = new Map();

function myUpcoming() {
  return state.tasks.filter(
    (t) => t.assigneeId === state.user?.id && t.dueAt && Date.parse(t.dueAt) > Date.now()
  );
}

async function scheduleReminders() {
  if (!state.user) return;
  const ln = localNotifications();

  if (!remindersOn()) {
    if (ln) { try { await clearNative(ln); } catch {} }
    for (const t of webTimers.values()) clearTimeout(t);
    webTimers.clear();
    return;
  }

  if (ln) {
    try {
      await clearNative(ln);
      const notifications = myUpcoming().slice(0, 60).map((t) => ({
        id: notifId(t.id),
        title: t.title,
        body: t.details ? t.details.slice(0, 120) : 'Due now on HomeBoard.',
        schedule: { at: new Date(t.dueAt), allowWhileIdle: true },
        smallIcon: 'ic_launcher',
        extra: { taskId: t.id },
      }));
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
  for (const t of myUpcoming()) {
    const delay = Date.parse(t.dueAt) - Date.now();
    if (delay > 6 * 60 * 60 * 1000) continue;   // setTimeout that far out is unreliable
    webTimers.set(t.id, setTimeout(() => {
      try {
        new Notification(t.title, { body: 'Due now on HomeBoard.', icon: '/icons/icon-192.png', tag: t.id });
      } catch {}
    }, Math.max(0, delay)));
  }
}

async function clearNative(ln) {
  const pending = await ln.getPending();
  if (pending?.notifications?.length) await ln.cancel({ notifications: pending.notifications });
}

async function setReminders(on) {
  if (!on) {
    localStorage.setItem('hb.reminders', '0');
    await scheduleReminders();
    $('#reminders-toggle').checked = false;
    updateRemindersNote();
    return;
  }

  const ln = localNotifications();
  let granted = false;
  if (ln) {
    const res = await ln.requestPermissions();
    granted = res?.display === 'granted';
  } else if ('Notification' in window) {
    granted = (await Notification.requestPermission()) === 'granted';
  }

  if (!granted) {
    $('#reminders-toggle').checked = false;
    toast('Notifications are blocked. Turn them on for HomeBoard in your device settings.');
    return;
  }
  localStorage.setItem('hb.reminders', '1');
  await scheduleReminders();
  updateRemindersNote();
  toast('Reminders on.');
}

function updateRemindersNote() {
  const note = $('#reminders-note');
  if (!note) return;
  note.textContent = localNotifications()
    ? 'A notification when time runs out on anything assigned to you. Works with HomeBoard closed.'
    : 'A notification when time runs out on anything assigned to you. In a browser this only fires while HomeBoard is open — install the app for reminders that always arrive.';
}

$('#reminders-toggle').addEventListener('change', (e) => setReminders(e.target.checked));

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

/* ───────────────────────── boot ───────────────────────── */

async function boot() {
  if (!state.user?.id) { showAuth(); return; }
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  $('#my-avatar').style.background = state.user.avatarColor || '#0f766e';
  $('#my-avatar').textContent = initials(state.user.name);
  $('#reminders-toggle').checked = remindersOn();
  updateRemindersNote();
  await loadAll();
  await consumePendingJoin();
  scheduleReminders();
  startPolling();
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
    setAuthMode('signin'); showAuth(); return;
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

// Pull fresh data when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) refreshNow({ silent: true });
});
})();
