'use strict';

const express          = require('express');
const { requireAuth }  = require('../middleware/auth');
const { rateLimitGeneral } = require('../middleware/rateLimit');
const alertsSvc        = require('../services/pricealerts');

const router = express.Router();

/* ── GET /api/price-alerts ──────────────────────────────────────── */
router.get('/', requireAuth, (req, res) => {
  res.json({ ok: true, alerts: alertsSvc.getAlerts() });
});

/* ── POST /api/price-alerts ─────────────────────────────────────── */
router.post('/', requireAuth, rateLimitGeneral, async (req, res) => {
  const { alert } = req.body;
  if (!alert || !alert.id || !alert.coin || alert.targetPrice == null)
    return res.status(400).json({ ok: false, error: 'alert inválida' });
  try {
    await alertsSvc.addAlert(alert);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── DELETE /api/price-alerts/:id ───────────────────────────────── */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await alertsSvc.removeAlert(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
