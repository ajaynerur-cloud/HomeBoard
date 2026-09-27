'use strict';
const express = require('express');
const store = require('../store');
const { newId, inviteCode, normaliseEmail, requireAuth, publicUser } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const isMember = (project, userId) => project.members.some((m) => m.userId === userId);
const isOwner = (project, userId) => project.ownerId === userId;

/** Attach resolved member objects so the UI can render names/colours directly. */
async function decorate(projects) {
  const users = await store.read('users');
  const byId = new Map(users.map((u) => [u.id, u]));
  return projects.map((p) => ({
    ...p,
    members: p.members.map((m) => ({ ...m, user: publicUser(byId.get(m.userId)) })).filter((m) => m.user),
  }));
}

router.get('/', async (req, res, next) => {
  try {
    const all = await store.read('projects');
    const mine = all.filter((p) => isMember(p, req.user.id));
    res.json({ projects: await decorate(mine) });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'Give the board a name.' });
    if (name.length > 60) return res.status(400).json({ error: 'That name is a bit long — keep it under 60 characters.' });

    const project = {
      id: newId('prj'),
      name,
      emoji: String(req.body?.emoji || '🏠').slice(0, 4),
      ownerId: req.user.id,
      members: [{ userId: req.user.id, role: 'owner', joinedAt: new Date().toISOString() }],
      inviteCode: inviteCode(),
      createdAt: new Date().toISOString(),
    };

    await store.update('projects', (rows) => { rows.push(project); }, `HomeBoard: new board "${name}"`);
    const [decorated] = await decorate([project]);
    res.status(201).json({ project: decorated });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const out = await store.update('projects', (rows) => {
      const p = rows.find((x) => x.id === req.params.id);
      if (!p) return { code: 404, error: 'Board not found.' };
      if (!isOwner(p, req.user.id)) return { code: 403, error: 'Only the board owner can rename it.' };
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim();
        if (name.length < 2) return { code: 400, error: 'Give the board a name.' };
        p.name = name.slice(0, 60);
      }
      if (req.body?.emoji !== undefined) p.emoji = String(req.body.emoji).slice(0, 4);
      return { project: p };
    }, 'HomeBoard: update board');

    if (out.error) return res.status(out.code).json({ error: out.error });
    const [decorated] = await decorate([out.project]);
    res.json({ project: decorated });
  } catch (err) {
    next(err);
  }
});

/** Invite by email. Adds the person straight away if they already have an account. */
router.post('/:id/invite', async (req, res, next) => {
  try {
    const email = normaliseEmail(req.body?.email);
    const projects = await store.read('projects');
    const project = projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Board not found.' });
    if (!isMember(project, req.user.id)) return res.status(403).json({ error: 'You are not on this board.' });

    if (!email) {
      return res.json({ pending: true, inviteCode: project.inviteCode, message: 'Share the join code below.' });
    }

    const users = await store.read('users');
    const invitee = users.find((u) => u.email === email);

    if (!invitee) {
      return res.json({
        pending: true,
        inviteCode: project.inviteCode,
        message: `No HomeBoard account for ${email} yet. Send them the join code — they can enter it right after signing up.`,
      });
    }
    if (isMember(project, invitee.id)) {
      return res.status(409).json({ error: `${invitee.name} is already on this board.` });
    }

    const out = await store.update('projects', (rows) => {
      const p = rows.find((x) => x.id === req.params.id);
      if (!p) return { code: 404, error: 'Board not found.' };
      if (p.members.some((m) => m.userId === invitee.id)) return { code: 409, error: 'Already a member.' };
      p.members.push({ userId: invitee.id, role: 'member', joinedAt: new Date().toISOString() });
      return { project: p };
    }, `HomeBoard: ${invitee.email} joined "${project.name}"`);

    if (out.error) return res.status(out.code).json({ error: out.error });
    const [decorated] = await decorate([out.project]);
    res.json({ project: decorated, added: publicUser(invitee), message: `${invitee.name} was added to the board.` });
  } catch (err) {
    next(err);
  }
});

/** Join a board using a code someone shared. */
router.post('/join', async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Enter a join code.' });

    const out = await store.update('projects', (rows) => {
      const p = rows.find((x) => x.inviteCode.toUpperCase() === code);
      if (!p) return { code: 404, error: 'That join code does not match any board.' };
      if (p.members.some((m) => m.userId === req.user.id)) return { already: true, project: p };
      p.members.push({ userId: req.user.id, role: 'member', joinedAt: new Date().toISOString() });
      return { project: p };
    }, 'HomeBoard: member joined via code');

    if (out.error) return res.status(out.code).json({ error: out.error });
    const [decorated] = await decorate([out.project]);
    res.json({
      project: decorated,
      message: out.already ? `You are already on ${out.project.name}.` : `Welcome to ${out.project.name}.`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/rotate-code', async (req, res, next) => {
  try {
    const out = await store.update('projects', (rows) => {
      const p = rows.find((x) => x.id === req.params.id);
      if (!p) return { code: 404, error: 'Board not found.' };
      if (!isOwner(p, req.user.id)) return { code: 403, error: 'Only the owner can reset the join code.' };
      p.inviteCode = inviteCode();
      return { project: p };
    }, 'HomeBoard: rotate join code');
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.json({ inviteCode: out.project.inviteCode });
  } catch (err) {
    next(err);
  }
});

/** Remove a member, or leave the board yourself. */
router.delete('/:id/members/:userId', async (req, res, next) => {
  try {
    const { id, userId } = req.params;
    const out = await store.update('projects', (rows) => {
      const p = rows.find((x) => x.id === id);
      if (!p) return { code: 404, error: 'Board not found.' };
      const self = userId === req.user.id;
      if (!self && !isOwner(p, req.user.id)) return { code: 403, error: 'Only the owner can remove people.' };
      if (userId === p.ownerId) return { code: 400, error: 'The owner cannot be removed. Delete the board instead.' };
      p.members = p.members.filter((m) => m.userId !== userId);
      return { ok: true };
    }, 'HomeBoard: membership change');
    if (out.error) return res.status(out.code).json({ error: out.error });

    // Unassign anything that person was holding on this board.
    await store.update('tasks', (rows) => {
      for (const t of rows) if (t.projectId === id && t.assigneeId === userId) t.assigneeId = null;
    }, 'HomeBoard: unassign tasks of removed member');

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const out = await store.update('projects', (rows) => {
      const i = rows.findIndex((x) => x.id === req.params.id);
      if (i === -1) return { code: 404, error: 'Board not found.' };
      if (!isOwner(rows[i], req.user.id)) return { code: 403, error: 'Only the owner can delete this board.' };
      rows.splice(i, 1);
      return { ok: true };
    }, 'HomeBoard: delete board');
    if (out.error) return res.status(out.code).json({ error: out.error });

    await store.update('tasks', (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].projectId === req.params.id) rows.splice(i, 1);
    }, 'HomeBoard: purge tasks of deleted board');
    await store.update('history', (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].projectId === req.params.id) rows.splice(i, 1);
    }, 'HomeBoard: purge history of deleted board');

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
