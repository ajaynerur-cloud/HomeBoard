'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const store = require('../store');
const {
  bcrypt, newId, normaliseEmail, signToken, setAuthCookie,
  clearAuthCookie, requireAuth, publicUser, pickColor,
} = require('../auth');
const push = require('../push');
const crypto = require('crypto');

const router = express.Router();

/*
 * Brute-force protection that counts only FAILED attempts.
 *
 * Everyone in one household shares a public IP, so a flat cap on all auth
 * requests locks out the third person trying to sign up on the sofa. Counting
 * failures keeps the protection where it belongs — on guessing — and lets a
 * family get set up together.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT || 30),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed attempts. Try again in a few minutes.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/signup', loginLimiter, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = normaliseEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email address does not look right.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password needs at least 8 characters.' });

    const passwordHash = await bcrypt.hash(password, 10);

    const outcome = await store.update(
      'users',
      (users) => {
        if (users.some((u) => u.email === email)) return { conflict: true };
        const user = {
          id: newId('usr'),
          name,
          email,
          passwordHash,
          avatarColor: pickColor(),
          createdAt: new Date().toISOString(),
        };
        users.push(user);
        return { user };
      },
      `HomeBoard: new account ${email}`
    );

    if (outcome.conflict) {
      return res.status(409).json({ error: 'An account with that email already exists. Try signing in.' });
    }

    const token = signToken(outcome.user);
    setAuthCookie(res, token);
    res.status(201).json({ token, user: publicUser(outcome.user) });
  } catch (err) {
    next(err);
  }
});

router.post('/signin', loginLimiter, async (req, res, next) => {
  try {
    const email = normaliseEmail(req.body?.email);
    const password = String(req.body?.password || '');

    const users = await store.read('users');
    const user = users.find((u) => u.email === email);
    // Always run a compare so timing doesn't reveal whether the email exists.
    const ok = await bcrypt.compare(password, user?.passwordHash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok) return res.status(401).json({ error: 'Email or password is incorrect.' });

    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/signout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/**
 * Swap a still-valid session for a fresh 30-day one. The app calls this after
 * a fingerprint unlock, so someone who opens HomeBoard at least once a month
 * never has to type their password again on that phone.
 */
router.post('/refresh', requireAuth, (req, res) => {
  const token = signToken(req.user);
  setAuthCookie(res, token);
  res.json({ token, user: publicUser(req.user) });
});

/*
 * Fingerprint sign-in.
 *
 * Turning fingerprint on gives this phone a device key: a random secret the
 * phone keeps and only hands over after the fingerprint matches. The server
 * stores a SHA-256 of it, never the secret. Signing in with the fingerprint
 * swaps the key for a session — so it works from the sign-in screen, after
 * signing out, and after a session has expired. Turning fingerprint off (or
 * deleting the account) removes the key and it stops working everywhere.
 */
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const MAX_DEVICES_PER_USER = 10;

router.post('/device', requireAuth, async (req, res, next) => {
  try {
    const secret = crypto.randomBytes(32).toString('base64url');
    const device = {
      id: newId('dev'),
      userId: req.user.id,
      secretHash: sha256(secret),
      label: String(req.body?.label || '').slice(0, 80),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await store.update('devices', (rows) => {
      // Re-enrolling on the same phone replaces its old key.
      const replaces = String(req.body?.replaces || '');
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].userId === req.user.id && rows[i].id === replaces) rows.splice(i, 1);
      }
      rows.push(device);
      const mine = rows.filter((d) => d.userId === req.user.id);
      if (mine.length > MAX_DEVICES_PER_USER) {
        const oldest = mine.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
        rows.splice(rows.findIndex((d) => d.id === oldest.id), 1);
      }
    }, 'HomeBoard: fingerprint sign-in turned on for a device');
    res.status(201).json({ deviceId: device.id, secret });
  } catch (err) {
    next(err);
  }
});

router.post('/device/signin', loginLimiter, async (req, res, next) => {
  try {
    const id = String(req.body?.deviceId || '');
    const hash = sha256(req.body?.secret || '');
    const device = (await store.read('devices')).find((d) => d.id === id);
    const ok = device && crypto.timingSafeEqual(Buffer.from(device.secretHash, 'hex'), Buffer.from(hash, 'hex'));
    const user = ok && (await store.read('users')).find((u) => u.id === device.userId);
    if (!user) {
      return res.status(401).json({
        error: 'Fingerprint sign-in is no longer set up for this phone. Sign in with your password, then turn it on again.',
        deviceGone: true,
      });
    }
    store.update('devices', (rows) => {
      const d = rows.find((x) => x.id === id);
      if (d) d.lastUsedAt = new Date().toISOString();
    }, 'HomeBoard: fingerprint sign-in').catch(() => {});
    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.delete('/device/:id', requireAuth, async (req, res, next) => {
  try {
    await store.update('devices', (rows) => {
      const i = rows.findIndex((d) => d.id === req.params.id && d.userId === req.user.id);
      if (i !== -1) rows.splice(i, 1);
    }, 'HomeBoard: fingerprint sign-in turned off for a device');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete the account and everything tied to it.
 *
 * Boards you own alone go with you. Boards you own with other people do not —
 * we refuse and tell you to hand them over first, because silently deleting
 * somebody else's shared board would be indefensible.
 */
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const me = req.user.id;
    const projects = await store.read('projects');

    const ownedWithOthers = projects.filter((p) => p.ownerId === me && p.members.length > 1);
    if (ownedWithOthers.length) {
      return res.status(409).json({
        error:
          `You still own ${ownedWithOthers.length === 1 ? 'a board' : `${ownedWithOthers.length} boards`} with other people on ` +
          `${ownedWithOthers.length === 1 ? 'it' : 'them'}: ${ownedWithOthers.map((p) => `"${p.name}"`).join(', ')}. ` +
          'Hand ownership over, or remove everyone else, then delete your account.',
        boards: ownedWithOthers.map((p) => ({ id: p.id, name: p.name })),
      });
    }

    const soleBoards = projects.filter((p) => p.ownerId === me).map((p) => p.id);

    await store.update('projects', (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (soleBoards.includes(rows[i].id)) { rows.splice(i, 1); continue; }
        rows[i].members = rows[i].members.filter((m) => m.userId !== me);
      }
    }, 'HomeBoard: account deleted — memberships removed');

    await store.update('tasks', (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (soleBoards.includes(rows[i].projectId)) { rows.splice(i, 1); continue; }
        if (rows[i].assigneeId === me) rows[i].assigneeId = null;
      }
    }, 'HomeBoard: account deleted — tasks cleared');

    await store.update('history', (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (soleBoards.includes(rows[i].projectId)) rows.splice(i, 1);
      }
    }, 'HomeBoard: account deleted — history cleared');

    await push.removeUser(me);

    await store.update('devices', (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === me) rows.splice(i, 1);
    }, 'HomeBoard: account deleted — fingerprint keys removed');

    await store.update('users', (rows) => {
      const i = rows.findIndex((u) => u.id === me);
      if (i !== -1) rows.splice(i, 1);
    }, 'HomeBoard: account deleted');

    clearAuthCookie(res);
    res.json({ ok: true, boardsDeleted: soleBoards.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
