-- ═══════════════════════════════════════════════════════════════════
--  CryptoPlan IA — Supabase Schema
--  Ejecuta esto en el SQL Editor de tu proyecto Supabase:
--  https://supabase.com/dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════════

-- ── Sessions (antes en memoria, ahora persisten entre reinicios) ──
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  ip         TEXT
);

-- Auto-limpiar sesiones expiradas (12 h = 43200 s)
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

-- ── Active trades ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS active_trades (
  id       TEXT PRIMARY KEY,
  data     JSONB NOT NULL,
  added_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);

-- ── Closed trades ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS closed_trades (
  id        TEXT PRIMARY KEY,
  data      JSONB NOT NULL,
  closed_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);
CREATE INDEX IF NOT EXISTS idx_closed_trades_closed_at ON closed_trades(closed_at DESC);

-- ── Scanner alerts (persistir historial de alertas) ───────────────
CREATE TABLE IF NOT EXISTS scanner_alerts (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);
CREATE INDEX IF NOT EXISTS idx_scanner_alerts_created_at ON scanner_alerts(created_at DESC);

-- ── Row-Level Security (deshabilitar para acceso server-side con service_role) ──
ALTER TABLE sessions       DISABLE ROW LEVEL SECURITY;
ALTER TABLE active_trades  DISABLE ROW LEVEL SECURITY;
ALTER TABLE closed_trades  DISABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_alerts DISABLE ROW LEVEL SECURITY;
