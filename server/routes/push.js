'use strict';
const express = require('express');
const push = require('../push');
const { requireAuth } = require('../auth');

const router = express.Router();

/** Public: what the app needs to subscribe. No secrets in here. */
router.get('/config', (req, res) => res.json(push.config()));

router.post('/subscribe', requireAuth, async (req, res, next) => {
  try {
    const out = await push.addDevice(req.user.id, req.body);
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json({ ok: true, id: out.id });
  } catch (err) {
    next(err);
  }
});

router.post('/unsubscribe', requireAuth, async (req, res, next) => {
  try {
    await push.removeDevice(req.user.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Send yourself a test notification — lets people check it works with the app closed. */
router.post('/test', requireAuth, async (req, res, next) => {
  try {
    const out = await push.sendToUser(req.user.id, {
      title: 'HomeBoard notifications are on',
      body: 'New tasks put on your plate will show up like this, even with the app closed.',
      data: { kind: 'test' },
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
