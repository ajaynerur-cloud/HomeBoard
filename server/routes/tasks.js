'use strict';
const express = require('express');
const store = require('../store');
const { newId, requireAuth, publicUser } = require('../auth');
const push = require('../push');
const Repeat = require('../../public/repeat');

const router = express.Router();
router.use(requireAuth);

const PRIORITIES = ['low', 'normal', 'high'];

/*
 * Offline-first support. The app works from a copy on the device and sends its
 * changes when it syncs, so it makes ids itself and tells us when things
 * happened. Ids are accepted only in our own shape; times only if they are
 * real and not in the future. A replayed request (the reply was lost on a bad
 * signal and the app sent it again) is answered with what is already there
 * instead of making a duplicate.
 */
const clientId = (value, prefix) =>
  typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,48}$`).test(value) ? value : null;

function clientTime(value, { notBefore = 0 } = {}) {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const now = Date.now();
  if (t > now + 60 * 1000) return new Date(now).toISOString(); // device clock ahead
  if (t < notBefore || t < now - 90 * 24 * 3600 * 1000) return null;
  return new Date(t).toISOString();
}

async function loadProject(projectId, userId) {
  const projects = await store.read('projects');
  const project = projects.find((p) => p.id === projectId);
  if (!project) return { error: { code: 404, message: 'Board not found.' } };
  if (!project.members.some((m) => m.userId === userId))
    return { error: { code: 403, message: 'You are not on this board.' } };
  return { project };
}

async function decorate(tasks) {
  const users = await store.read('users');
  const byId = new Map(users.map((u) => [u.id, u]));
  return tasks.map((t) => ({
    ...t,
    assignee: publicUser(byId.get(t.assigneeId)),
    createdBy: publicUser(byId.get(t.createdById)),
    comments: (t.comments || []).map((c) => ({ ...c, author: publicUser(byId.get(c.userId)) })),
  }));
}

function sanitiseDue(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sanitiseChecklist(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map((item) => ({
    id: item?.id || newId('chk'),
    text: String(item?.text || '').slice(0, 200),
    done: Boolean(item?.done),
  })).filter((i) => i.text);
}

/** All live tasks on the boards this person belongs to. */
router.get('/', async (req, res, next) => {
  try {
    const projects = await store.read('projects');
    const myProjectIds = new Set(
      projects.filter((p) => p.members.some((m) => m.userId === req.user.id)).map((p) => p.id)
    );
    const all = await store.read('tasks');
    let mine = all.filter((t) => myProjectIds.has(t.projectId));
    if (req.query.projectId) mine = mine.filter((t) => t.projectId === req.query.projectId);
    mine.sort((a, b) => {
      const ad = a.dueAt ? Date.parse(a.dueAt) : Infinity;
      const bd = b.dueAt ? Date.parse(b.dueAt) : Infinity;
      if (ad !== bd) return ad - bd;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
    res.json({ tasks: await decorate(mine) });
  } catch (err) {
    next(err);
  }
});

/** Create a task — optionally pushing it straight onto someone else's plate. */
router.post('/', async (req, res, next) => {
  try {
    const { project, error } = await loadProject(String(req.body?.projectId || ''), req.user.id);
    if (error) return res.status(error.code).json({ error: error.message });

    const title = String(req.body?.title || '').trim();
    if (title.length < 2) return res.status(400).json({ error: 'Give the task a name.' });

    let assigneeId = req.body?.assigneeId ? String(req.body.assigneeId) : req.user.id;
    if (!project.members.some((m) => m.userId === assigneeId))
      return res.status(400).json({ error: 'That person is not on this board.' });

    // Made on a device while offline — it already has an id.
    const wantedId = clientId(req.body?.id, 'tsk');
    if (wantedId) {
      const already = (await store.read('tasks')).find((t) => t.id === wantedId);
      if (already) {
        if (already.createdById !== req.user.id || already.projectId !== project.id)
          return res.status(409).json({ error: 'That task id is taken.' });
        const [decorated] = await decorate([already]);
        return res.status(200).json({ task: decorated, replayed: true });
      }
    }

    const now = new Date().toISOString();
    const task = {
      id: wantedId || newId('tsk'),
      projectId: project.id,
      title: title.slice(0, 120),
      details: String(req.body?.details || '').slice(0, 4000),
      checklist: sanitiseChecklist(req.body?.checklist),
      assigneeId,
      createdById: req.user.id,
      dueAt: sanitiseDue(req.body?.dueAt),
      priority: PRIORITIES.includes(req.body?.priority) ? req.body.priority : 'normal',
      repeat: Repeat.sanitise(req.body?.repeat),
      comments: [],
      createdAt: clientTime(req.body?.createdAt) || now,
      updatedAt: now,
    };

    await store.update('tasks', (rows) => { if (!rows.some((t) => t.id === task.id)) rows.push(task); }, `HomeBoard: new task "${task.title}"`);

    // Tell the person it was pushed to, straight away. Not awaited: a slow push
    // service must never hold up the person creating the task.
    push.notifyAssigned(task, { byUser: req.user, projectName: project.name, fromDevice: req.get('x-hb-device') || null });
    const [decorated] = await decorate([task]);
    res.status(201).json({ task: decorated });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const tasks = await store.read('tasks');
    const existing = tasks.find((t) => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found.' });
    const { project, error } = await loadProject(existing.projectId, req.user.id);
    if (error) return res.status(error.code).json({ error: error.message });

    const body = req.body || {};
    if (body.assigneeId !== undefined && body.assigneeId !== null) {
      if (!project.members.some((m) => m.userId === String(body.assigneeId)))
        return res.status(400).json({ error: 'That person is not on this board.' });
    }

    const out = await store.update('tasks', (rows) => {
      const t = rows.find((x) => x.id === req.params.id);
      if (!t) return { code: 404, error: 'Task not found.' };
      if (body.title !== undefined) {
        const title = String(body.title).trim();
        if (title.length < 2) return { code: 400, error: 'Give the task a name.' };
        t.title = title.slice(0, 120);
      }
      if (body.details !== undefined) t.details = String(body.details).slice(0, 4000);
      if (body.checklist !== undefined) t.checklist = sanitiseChecklist(body.checklist);
      if (body.assigneeId !== undefined) t.assigneeId = body.assigneeId ? String(body.assigneeId) : null;
      if (body.dueAt !== undefined) t.dueAt = sanitiseDue(body.dueAt);
      if (body.priority !== undefined && PRIORITIES.includes(body.priority)) t.priority = body.priority;
      if (body.repeat !== undefined) t.repeat = Repeat.sanitise(body.repeat);
      t.updatedAt = new Date().toISOString();
      return { task: t };
    }, `HomeBoard: update task`);

    if (out.error) return res.status(out.code).json({ error: out.error });

    // Handed to someone new — that is a new task on their plate.
    if (out.task.assigneeId && out.task.assigneeId !== existing.assigneeId) {
      push.notifyAssigned(out.task, {
        byUser: req.user, projectName: project.name, reassigned: true, fromDevice: req.get('x-hb-device') || null,
      });
    }

    const [decorated] = await decorate([out.task]);
    res.json({ task: decorated });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/comments', async (req, res, next) => {
  try {
    const tasks = await store.read('tasks');
    const existing = tasks.find((t) => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found.' });
    const { error } = await loadProject(existing.projectId, req.user.id);
    if (error) return res.status(error.code).json({ error: error.message });

    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Write something first.' });

    const out = await store.update('tasks', (rows) => {
      const t = rows.find((x) => x.id === req.params.id);
      if (!t) return { code: 404, error: 'Task not found.' };
      t.comments = t.comments || [];
      const id = clientId(req.body?.id, 'cmt');
      if (id && t.comments.some((c) => c.id === id)) return { task: t }; // replayed
      t.comments.push({
        id: id || newId('cmt'), userId: req.user.id, text: text.slice(0, 1000),
        at: clientTime(req.body?.at) || new Date().toISOString(),
      });
      t.updatedAt = new Date().toISOString();
      return { task: t };
    }, 'HomeBoard: task note added');

    if (out.error) return res.status(out.code).json({ error: out.error });
    const [decorated] = await decorate([out.task]);
    res.json({ task: decorated });
  } catch (err) {
    next(err);
  }
});

/**
 * Complete a task.
 * The task row — details, notes, checklist, everything — is deleted outright.
 * A name-only line goes into history so the board still shows who did what.
 */
router.post('/:id/complete', async (req, res, next) => {
  try {
    const tasks = await store.read('tasks');
    const existing = tasks.find((t) => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found.' });
    const { error } = await loadProject(existing.projectId, req.user.id);
    if (error) return res.status(error.code).json({ error: error.message });

    // Finished offline: keep the moment it was really done, not when it synced.
    const completedAt = clientTime(req.body?.completedAt) || new Date().toISOString();
    const entry = {
      id: clientId(req.body?.historyId, 'hst') || newId('hst'),
      projectId: existing.projectId,
      title: existing.title,
      completedById: req.user.id,
      assignedToId: existing.assigneeId || null,
      completedAt,
      wasLate: existing.dueAt ? Date.parse(completedAt) > Date.parse(existing.dueAt) : false,
    };

    /*
     * A repeating task isn't deleted — it rolls on to its next due date, steps
     * unticked and notes cleared, ready for next time. The app works the date
     * out in its own time zone and sends it; we check it's sane, and fall back
     * to working it out here (in server time) for older apps.
     */
    let nextDueAt = null;
    if (existing.repeat) {
      const sent = Date.parse(req.body?.nextDueAt);
      const floor = Math.max(Date.parse(existing.dueAt) || 0, Date.parse(completedAt) - 60 * 1000);
      nextDueAt = Number.isFinite(sent) && sent > floor && sent < Date.now() + 400 * 24 * 3600 * 1000
        ? new Date(sent).toISOString()
        : Repeat.next(existing.dueAt, existing.repeat, { after: Date.parse(completedAt) });
    }

    await store.update('tasks', (rows) => {
      const i = rows.findIndex((x) => x.id === req.params.id);
      if (i === -1) return;
      if (nextDueAt) {
        const t = rows[i];
        t.dueAt = nextDueAt;
        t.checklist = (t.checklist || []).map((c) => ({ ...c, done: false }));
        t.comments = [];
        t.updatedAt = new Date().toISOString();
      } else {
        rows.splice(i, 1);
      }
    }, nextDueAt ? `HomeBoard: "${existing.title}" done — next one ${nextDueAt}` : `HomeBoard: completed + purged "${existing.title}"`);

    await store.update('history', (rows) => {
      rows.push(entry);
      // Keep history bounded — oldest 500 per board is plenty.
      const forBoard = rows.filter((r) => r.projectId === entry.projectId);
      if (forBoard.length > 500) {
        const cutoff = forBoard.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
          .slice(0, forBoard.length - 500).map((r) => r.id);
        for (let i = rows.length - 1; i >= 0; i--) if (cutoff.includes(rows[i].id)) rows.splice(i, 1);
      }
    }, `HomeBoard: history entry for "${existing.title}"`);

    const users = await store.read('users');
    const byId = new Map(users.map((u) => [u.id, u]));
    res.json({
      ok: true,
      purged: !nextDueAt,
      nextDueAt,
      history: { ...entry, completedBy: publicUser(byId.get(entry.completedById)) },
      // Handed back so the app can offer an Undo. It is not stored anywhere
      // once this response is sent — if the app doesn't use it, it's gone.
      undo: existing,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const tasks = await store.read('tasks');
    const existing = tasks.find((t) => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found.' });
    const { error } = await loadProject(existing.projectId, req.user.id);
    if (error) return res.status(error.code).json({ error: error.message });

    await store.update('tasks', (rows) => {
      const i = rows.findIndex((x) => x.id === req.params.id);
      if (i !== -1) rows.splice(i, 1);
    }, 'HomeBoard: task deleted');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Name-only record of what's been finished. */
router.get('/history/list', async (req, res, next) => {
  try {
    const projects = await store.read('projects');
    const myProjectIds = new Set(
      projects.filter((p) => p.members.some((m) => m.userId === req.user.id)).map((p) => p.id)
    );
    const rows = (await store.read('history')).filter((h) => myProjectIds.has(h.projectId));
    const scoped = req.query.projectId ? rows.filter((h) => h.projectId === req.query.projectId) : rows;
    scoped.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));

    const users = await store.read('users');
    const byId = new Map(users.map((u) => [u.id, u]));
    res.json({
      history: scoped.slice(0, 200).map((h) => ({
        ...h,
        completedBy: publicUser(byId.get(h.completedById)),
        assignedTo: publicUser(byId.get(h.assignedToId)),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Undo a completion: put the task back exactly as it was and remove the
 * history line. Only works while the app still holds the task it was given
 * back — nothing is kept server-side after the completion response.
 */
router.post('/restore', async (req, res, next) => {
  try {
    const task = req.body?.task;
    const historyId = String(req.body?.historyId || '');
    if (!task?.id || !task?.projectId) return res.status(400).json({ error: 'Nothing to restore.' });

    const { error } = await loadProject(task.projectId, req.user.id);
    if (error) return res.status(error.code).json({ error: error.message });

    const out = await store.update('tasks', (rows) => {
      const i = rows.findIndex((t) => t.id === task.id);
      // A repeating task stayed on the board and moved on — undo moves it back.
      if (i !== -1 && rows[i].repeat) { rows[i] = { ...task, updatedAt: new Date().toISOString() }; return { ok: true }; }
      if (i !== -1) return { code: 409, error: 'That task is already on the board.' };
      rows.push({ ...task, updatedAt: new Date().toISOString() });
      return { ok: true };
    }, `HomeBoard: restored "${String(task.title || '').slice(0, 60)}"`);
    if (out.error) return res.status(out.code).json({ error: out.error });

    if (historyId) {
      await store.update('history', (rows) => {
        const i = rows.findIndex((h) => h.id === historyId && h.projectId === task.projectId);
        if (i !== -1) rows.splice(i, 1);
      }, 'HomeBoard: history line removed by undo');
    }

    const [decorated] = await decorate([task]);
    res.json({ task: decorated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
