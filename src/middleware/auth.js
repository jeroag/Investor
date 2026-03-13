'use strict';

const crypto     = require('crypto');
const { config } = require('../config');
const db         = require('../db/supabase');

/* ── Sesiones en memoria (caché sobre Supabase) ───────────────────────── */
// Map<token, { createdAt: number, ip?: string }>
const sessions = new Map();

/** Carga sesiones existentes de Supabase al arrancar */
async function restoreSessions() {
  const rows = await db.loadSessions();
  for (const row of rows) {
    sessions.set(row.token, { createdAt: row.created_at, ip: row.ip });
  }
  console.log(`✓ Sesiones restauradas desde Supabase: ${sessions.size}`);
}

/** Limpia sesiones expiradas de memoria y Supabase cada hora */
function scheduleSessionCleanup() {
  setInterval(async () => {
    const now = Date.now();
    for (const [token, s] of sessions) {
      if (now - s.createdAt > config.sessionTtlMs) sessions.delete(token);
    }
    await db.deleteExpiredSessions();
  }, 60 * 60 * 1000);
}

/* ── Helpers de token ─────────────────────────────────────────────────── */
function generateToken() {
  return crypto.randomBytes(64).toString('hex');
}

function getToken(req) {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const m = (req.headers['cookie'] || '').match(/cp_token=([^;]+)/);
  return m ? m[1] : null;
}

/** Para WebSocket upgrade: cookie o query param */
function getTokenFromRequest(req) {
  const m = (req.headers['cookie'] || '').match(/cp_token=([^;]+)/);
  if (m) return m[1];
  try {
    return new URL('http://x' + req.url).searchParams.get('token') || null;
  } catch { return null; }
}

function isAuthenticated(req) {
  const token   = getToken(req);
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > config.sessionTtlMs) {
    sessions.delete(token);
    db.deleteSession(token).catch(() => {});
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'No autorizado.' });
}

/** Crea sesión nueva y la persiste en Supabase */
async function createSession(token, ip) {
  const session = { createdAt: Date.now(), ip };
  sessions.set(token, session);
  await db.saveSession(token, session);
  return session;
}

/** Elimina sesión de memoria y Supabase */
async function destroySession(token) {
  sessions.delete(token);
  await db.deleteSession(token);
}

module.exports = {
  sessions,
  restoreSessions,
  scheduleSessionCleanup,
  generateToken,
  getToken,
  getTokenFromRequest,
  isAuthenticated,
  requireAuth,
  createSession,
  destroySession,
};
