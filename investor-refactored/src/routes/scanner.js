'use strict';

const express        = require('express');
const { requireAuth } = require('../middleware/auth');
const { scannerState } = require('../state');
const { startServerScanner, stopServerScanner } = require('../services/scanner');

const router = express.Router();

router.post('/start', requireAuth, (req, res) => {
  const { profile } = req.body || {};
  startServerScanner(profile);
  res.json({ ok: true, intervalMin: scannerState.intervalMin });
});

router.post('/stop', requireAuth, (req, res) => {
  stopServerScanner();
  res.json({ ok: true });
});

router.get('/status', requireAuth, (req, res) => {
  res.json({
    ok:           true,
    enabled:      scannerState.enabled,
    intervalMin:  scannerState.intervalMin,
    lastScan:     scannerState.lastScan,
    pendingCount: scannerState.pendingAlerts.filter(a => a.status === 'pending').length,
    lastAlert:    scannerState.lastAlert,
  });
});

router.get('/alerts', requireAuth, (req, res) => {
  res.json({ ok: true, alerts: scannerState.pendingAlerts });
});

module.exports = router;
