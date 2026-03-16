'use strict';

const express          = require('express');
const { requireAuth }  = require('../middleware/auth');
const { rateLimitGeneral } = require('../middleware/rateLimit');
const db               = require('../db/supabase');

const router = express.Router();

/* ── GET /api/profile ─────────────────────────────────────────────── */
router.get('/', requireAuth, async (req, res) => {
  try {
    const profile = await db.loadProfile();
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── POST /api/profile ────────────────────────────────────────────── */
router.post('/', requireAuth, rateLimitGeneral, async (req, res) => {
  const { profile } = req.body;
  if (!profile || typeof profile !== 'object')
    return res.status(400).json({ ok: false, error: 'profile inválido' });
  try {
    await db.saveProfile(profile);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;