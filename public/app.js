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

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach HomeBoard. Check your connection.');
  }

  let data = {};
  try { data = await res.json(); } catch { /* empty body is fine */ }

  if (res.status === 401 && state.user) {
    setToken(null);
    state.user = null;
    showAuth();
    throw new Error(data.error || 'Please sign in again.');
  }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
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
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
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

  return `
    <div class="task pri-${esc(task.priority)}${r.ms < 0 ? ' overdue' : ''}" data-id="${esc(task.id)}">
      <button class="tick" data-complete="${esc(task.id)}" aria-label="Mark “${esc(task.title)}” done">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--teal-700)" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      </button>
      <button class="task-body" data-open="${esc(task.id)}">
        <div class="task-title">${esc(task.title)}</div>
        <div class="task-meta">${bits.join('')}</div>
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
    await api(`/tasks/${id}/complete`, { method: 'POST' });
    await refreshTasks();
    toast(`“${title}” done — details wiped.`);
  } catch (err) {
    card?.classList.remove('completing');
    toast(err.message);
  }
}

$('#view').addEventListener('click', (e) => {
  const tick = e.target.closest('[data-complete]');
  if (tick) {
    const task = state.tasks.find((t) => t.id === tick.dataset.complete);
    if (task) completeTask(task.id, task.title);
    return;
  }
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
      ${(iAmOwner && m.role !== 'owner') || m.user.id === state.user.id
        ? `<button class="btn btn-ghost btn-sm" data-remove="${esc(m.user.id)}">${m.user.id === state.user.id ? 'Leave' : 'Remove'}</button>` : ''}
    </div>`).join('');

  $('#invite-code').textContent = project.inviteCode;
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
  const text = `Join my HomeBoard “${project.name}” — go to ${location.origin} and enter code ${project.inviteCode}`;
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

/* ───────────────────────── boot ───────────────────────── */

async function boot() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  $('#my-avatar').style.background = state.user.avatarColor || '#0f766e';
  $('#my-avatar').textContent = initials(state.user.name);
  await loadAll();
}

(async function start() {
  if (!getToken()) { setAuthMode('signin'); showAuth(); return; }
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    await boot();
  } catch {
    setToken(null);
    setAuthMode('signin');
    showAuth();
  }
})();

// Pull fresh data when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) refreshTasks().catch(() => {});
});
})();
