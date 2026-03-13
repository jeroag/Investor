'use strict';

const { createClient } = require('@supabase/supabase-js');
const { config }       = require('../config');

/* ── Cliente Supabase (service_role — acceso total, solo server-side) ──── */
const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false },
});

/* ════════════════════════════════════════════════════════════════════
   HELPERS — Active Trades
   ════════════════════════════════════════════════════════════════════ */
async function loadActiveTrades() {
  const { data, error } = await supabase
    .from('active_trades')
    .select('data');
  if (error) { console.error('[DB] loadActiveTrades:', error.message); return []; }
  return (data || []).map(r => r.data);
}

async function saveActiveTrade(trade) {
  const { error } = await supabase
    .from('active_trades')
    .upsert({ id: trade.id, data: trade, added_at: Date.now() });
  if (error) console.error('[DB] saveActiveTrade:', error.message);
}

async function deleteActiveTrade(id) {
  const { error } = await supabase
    .from('active_trades')
    .delete()
    .eq('id', id);
  if (error) console.error('[DB] deleteActiveTrade:', error.message);
}

async function replaceActiveTrades(trades) {
  // Borra todo y reinserta — equivalente a la transacción SQLite
  const { error: delErr } = await supabase.from('active_trades').delete().neq('id', '__never__');
  if (delErr) { console.error('[DB] replaceActiveTrades (delete):', delErr.message); return; }
  if (!trades.length) return;
  const rows = trades.map(t => ({ id: t.id, data: t, added_at: Date.now() }));
  const { error } = await supabase.from('active_trades').insert(rows);
  if (error) console.error('[DB] replaceActiveTrades (insert):', error.message);
}

/* ════════════════════════════════════════════════════════════════════
   HELPERS — Closed Trades
   ════════════════════════════════════════════════════════════════════ */
async function loadClosedTrades(limit = 500) {
  const { data, error } = await supabase
    .from('closed_trades')
    .select('data')
    .order('closed_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('[DB] loadClosedTrades:', error.message); return []; }
  return (data || []).map(r => r.data);
}

async function saveClosedTrade(trade) {
  const { error } = await supabase
    .from('closed_trades')
    .upsert({ id: trade.id, data: trade, closed_at: Date.now() });
  if (error) console.error('[DB] saveClosedTrade:', error.message);
}

async function deleteClosedTrades(ids) {
  if (!ids.length) return;
  const { error } = await supabase
    .from('closed_trades')
    .delete()
    .in('id', ids);
  if (error) console.error('[DB] deleteClosedTrades:', error.message);
}

/* ════════════════════════════════════════════════════════════════════
   HELPERS — Sessions (persistencia entre reinicios)
   ════════════════════════════════════════════════════════════════════ */
async function loadSessions() {
  const cutoff = Date.now() - config.sessionTtlMs;
  // Borrar expiradas antes de cargar
  await supabase.from('sessions').delete().lt('created_at', cutoff);
  const { data, error } = await supabase.from('sessions').select('*');
  if (error) { console.error('[DB] loadSessions:', error.message); return []; }
  return data || [];
}

async function saveSession(token, session) {
  const { error } = await supabase
    .from('sessions')
    .upsert({ token, created_at: session.createdAt, ip: session.ip || null });
  if (error) console.error('[DB] saveSession:', error.message);
}

async function deleteSession(token) {
  const { error } = await supabase.from('sessions').delete().eq('token', token);
  if (error) console.error('[DB] deleteSession:', error.message);
}

async function deleteExpiredSessions() {
  const cutoff = Date.now() - config.sessionTtlMs;
  const { error } = await supabase.from('sessions').delete().lt('created_at', cutoff);
  if (error) console.error('[DB] deleteExpiredSessions:', error.message);
}

/* ════════════════════════════════════════════════════════════════════
   HELPERS — Scanner Alerts
   ════════════════════════════════════════════════════════════════════ */
async function saveAlert(alert) {
  const { error } = await supabase
    .from('scanner_alerts')
    .upsert({ id: alert.id, data: alert, created_at: Date.now() });
  if (error) console.error('[DB] saveAlert:', error.message);
}

async function loadRecentAlerts(limit = 50) {
  const { data, error } = await supabase
    .from('scanner_alerts')
    .select('data')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('[DB] loadRecentAlerts:', error.message); return []; }
  return (data || []).map(r => r.data);
}

module.exports = {
  supabase,
  // Active trades
  loadActiveTrades, saveActiveTrade, deleteActiveTrade, replaceActiveTrades,
  // Closed trades
  loadClosedTrades, saveClosedTrade, deleteClosedTrades,
  // Sessions
  loadSessions, saveSession, deleteSession, deleteExpiredSessions,
  // Alerts
  saveAlert, loadRecentAlerts,
};
