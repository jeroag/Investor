'use strict';

/**
 * Auth routes — v1.1 (AUDITADO)
 *
 * CORRECCIÓN [ALTO] — Cookie de sesión sin flag `Secure`:
 *   La cookie `cp_token` se emitía sin el atributo `Secure`, lo que permitía
 *   que el token de sesión viajara en claro sobre HTTP (aunque Railway use HTTPS,
 *   cualquier redirección o misconfiguration podría exponer el token).
 *   Se añade `Secure` dinámicamente: activo en producción (NODE_ENV=production
 *   o cuando la petición llega por HTTPS), omitido en localhost para desarrollo.
 *
 * CORRECCIÓN [ALTO] — El endpoint de logout no tenía `SameSite` en la cookie
 *   de limpieza, lo que podría dejar la cookie activa en algunos navegadores.
 */

const express = require('express');
const { config } = require('../config');
const auth = require('../middleware/auth');
const { rateLimitAuth } = require('../middleware/rateLimit');

const router = express.Router();

/**
 * Construye la cabecera Set-Cookie con o sin `Secure` según el entorno.
 * En Railway (HTTPS) siempre añade Secure.
 * En localhost (HTTP) lo omite para no bloquear el desarrollo.
 */
function buildCookieHeader(token, maxAgeSeconds, req) {
  const isSecure = process.env.NODE_ENV === 'production'
    || req.headers['x-forwarded-proto'] === 'https'
    || req.secure;

  const parts = [
    `cp_token=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    'Path=/',
  ];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}

router.post('/login', rateLimitAuth, async (req, res) => {
  const { password } = req.body;
  const correctPassword = config.appPassword;

  if (!correctPassword) {
    // Sin contraseña configurada: acceso libre (dev mode)
    const token = auth.generateToken();
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    await auth.createSession(token, ip);
    res.setHeader('Set-Cookie', buildCookieHeader(token, config.sessionTtlMs / 1000, req));
    return res.json({ ok: true, token });
  }

  if (!password || password !== correctPassword) {
    return setTimeout(
      () => res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' }),
      1000, // delay anti-brute force
    );
  }

  const token = auth.generateToken();
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  await auth.createSession(token, ip);
  console.log(`✓ Login desde ${ip}`);

  res.setHeader('Set-Cookie', buildCookieHeader(token, config.sessionTtlMs / 1000, req));
  res.json({ ok: true, token });
});

router.post('/logout', async (req, res) => {
  const token = auth.getToken(req);
  if (token) await auth.destroySession(token);
  // Limpiar cookie con los mismos atributos que al crearla
  res.setHeader('Set-Cookie', 'cp_token=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/; Secure');
  res.json({ ok: true });
});

router.get('/check', (req, res) =>
  res.json({ authenticated: auth.isAuthenticated(req) }),
);

module.exports = router;