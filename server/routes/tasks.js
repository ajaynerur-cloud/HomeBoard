'use strict';
const express = require('express');
const store = require('../store');
const { newId, requireAuth, publicUser } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const PRIORITIES = ['low', 'normal', 'high'];

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

    const now = new Date().toISOString();
    const task = {
      id: newId('tsk'),
      projectId: project.id,
      title: title.slice(0, 120),
      details: String(req.body?.details || '').slice(0, 4000),
      checklist: sanitiseChecklist(req.body?.checklist),
      assigneeId,
      createdById: req.user.id,
      dueAt: sanitiseDue(req.body?.dueAt),
      priority: PRIORITIES.includes(req.body?.priority) ? req.body.priority : 'normal',
      comments: [],
      createdAt: now,
      updatedAt: now,
    };

    await store.update('tasks', (rows) => { rows.push(task); }, `HomeBoard: new task "${task.title}"`);
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
      t.updatedAt = new Date().toISOString();
      return { task: t };
    }, `HomeBoard: update task`);

    if (out.error) return res.status(out.code).json({ error: out.error });
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
      t.comments.push({ id: newId('cmt'), userId: req.user.id, text: text.slice(0, 1000), at: new Date().toISOString() });
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

    const entry = {
      id: newId('hst'),
      projectId: existing.projectId,
      title: existing.title,
      completedById: req.user.id,
      assignedToId: existing.assigneeId || null,
      completedAt: new Date().toISOString(),
      wasLate: existing.dueAt ? Date.now() > Date.parse(existing.dueAt) : false,
    };

    await store.update('tasks', (rows) => {
      const i = rows.findIndex((x) => x.id === req.params.id);
      if (i !== -1) rows.splice(i, 1);
    }, `HomeBoard: completed + purged "${existing.title}"`);

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
      purged: true,
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
      if (rows.some((t) => t.id === task.id)) return { code: 409, error: 'That task is already on the board.' };
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
