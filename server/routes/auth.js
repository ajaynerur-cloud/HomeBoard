'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const store = require('../store');
const {
  bcrypt, newId, normaliseEmail, signToken, setAuthCookie,
  clearAuthCookie, requireAuth, publicUser, pickColor,
} = require('../auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
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

module.exports = router;
