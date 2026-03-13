'use strict';

const express    = require('express');
const { config } = require('../config');
const auth       = require('../middleware/auth');
const { rateLimitAuth } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/login', rateLimitAuth, async (req, res) => {
  const { password }    = req.body;
  const correctPassword = config.appPassword;

  if (!correctPassword) {
    // Sin contraseña configurada: acceso libre (dev mode)
    const token = auth.generateToken();
    await auth.createSession(token, req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress);
    return res.json({ ok: true, token });
  }

  if (!password || password !== correctPassword) {
    return setTimeout(
      () => res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' }),
      1000, // delay anti-brute force
    );
  }

  const token = auth.generateToken();
  const ip    = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  await auth.createSession(token, ip);
  console.log(`✓ Login desde ${ip}`);

  res.setHeader(
    'Set-Cookie',
    `cp_token=${token}; HttpOnly; SameSite=Strict; Max-Age=${config.sessionTtlMs / 1000}; Path=/`,
  );
  res.json({ ok: true, token });
});

router.post('/logout', async (req, res) => {
  const token = auth.getToken(req);
  if (token) await auth.destroySession(token);
  res.setHeader('Set-Cookie', 'cp_token=; HttpOnly; Max-Age=0; Path=/');
  res.json({ ok: true });
});

router.get('/check', (req, res) =>
  res.json({ authenticated: auth.isAuthenticated(req) }),
);

module.exports = router;
