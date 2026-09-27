'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const store = require('./store');

const SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === 'production'
    ? (() => {
        throw new Error('JWT_SECRET must be set in production');
      })()
    : 'homeboard-dev-secret-not-for-production');

const TOKEN_TTL = '30d';
const COOKIE = 'hb_token';

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

/** Short, unambiguous, human-typable invite code. No 0/O/1/I. */
function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

const normaliseEmail = (e) => String(e || '').trim().toLowerCase();

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
}

function readToken(req) {
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.[COOKIE] || null;
}

/** Express middleware: rejects anonymous requests, attaches req.user. */
async function requireAuth(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
    }
    const users = await store.read('users');
    const user = users.find((u) => u.id === payload.sub);
    if (!user) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Account not found.' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

const publicUser = (u) =>
  u ? { id: u.id, name: u.name, email: u.email, avatarColor: u.avatarColor, createdAt: u.createdAt } : null;

const AVATAR_COLORS = ['#0f766e', '#b45309', '#6d28d9', '#be123c', '#1d4ed8', '#4d7c0f', '#c2410c', '#0369a1'];
const pickColor = () => AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)];

module.exports = {
  bcrypt,
  newId,
  inviteCode,
  normaliseEmail,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  publicUser,
  pickColor,
  COOKIE,
};
