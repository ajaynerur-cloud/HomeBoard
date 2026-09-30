'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const store = require('./store');
const push = require('./push');

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most PaaS) sit behind a proxy; needed for secure cookies + rate limiting.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Capacitor's Android WebView serves the app from a different origin, so the
// API has to accept cross-origin calls with credentials from it.
const ALLOWED_ORIGINS = new Set(
  [
    process.env.APP_ORIGIN,
    'https://localhost',
    'http://localhost',
    'capacitor://localhost',
    'http://localhost:3000',
  ].filter(Boolean)
);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', (req, res) => {
  const p = push.config();
  res.json({
    ok: true, app: 'HomeBoard', storage: store.MODE,
    push: { web: Boolean(p.webPublicKey), fcm: p.fcm },
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/push', require('./routes/push'));

// Static front-end. The service worker must never be cached or updates stick.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, _next) => {
  console.error('[HomeBoard]', err);
  const message =
    process.env.NODE_ENV === 'production'
      ? 'Something went wrong on our side. Please try again.'
      : err.message;
  res.status(500).json({ error: message });
});

store
  .init()
  .then(async (info) => {
    const pushInfo = await push.init();
    app.listen(PORT, () => {
      console.log(`HomeBoard listening on :${PORT}`);
      console.log(
        info.mode === 'github'
          ? `  storage: GitHub repo ${info.repo} (branch ${info.branch}, folder ${info.dir}/)`
          : `  storage: local files in ${info.repo}  — set GITHUB_TOKEN + DATA_REPO to use the private repo`
      );
      console.log(
        `  push: web on${pushInfo.fcm ? ', Android (FCM) on' : ' — Android (FCM) off: set FCM_SERVICE_ACCOUNT to push to the APK'}`
      );
    });
  })
  .catch((err) => {
    console.error('HomeBoard could not start — storage is unreachable.');
    console.error(err.message);
    process.exit(1);
  });
