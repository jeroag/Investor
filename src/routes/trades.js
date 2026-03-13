'use strict';

const express        = require('express');
const { requireAuth } = require('../middleware/auth');
const { serverState } = require('../state');
const db             = require('../db/supabase');
const { rateLimitGeneral } = require('../middleware/rateLimit');

const router = express.Router();

/* ── Validación ───────────────────────────────────────────────────── */
function isValidTrade(t) {
  return t &&
    typeof t.id       === 'string' &&
    typeof t.par      === 'string' &&
    (t.tipo === 'LONG' || t.tipo === 'SHORT') &&
    typeof t.stopLoss === 'number' && isFinite(t.stopLoss) &&
    typeof t.tp1      === 'number' && isFinite(t.tp1) &&
    typeof t.riskUSD  === 'number' && isFinite(t.riskUSD);
}

/* ── Sync de trades activos (cliente → servidor) ──────────────────── */
router.post('/sync', requireAuth, rateLimitGeneral, async (req, res) => {
  const { activeTrades } = req.body;
  if (!Array.isArray(activeTrades))
    return res.status(400).json({ error: 'activeTrades inválido' });

  const valid    = activeTrades.filter(isValidTrade);
  const existing = new Set(serverState.activeTrades.map(t => t.id));

  // Añadir nuevos trades
  const inserts = [];
  for (const t of valid) {
    if (!existing.has(t.id)) {
      serverState.activeTrades.push(t);
      inserts.push(db.saveActiveTrade(t));
    }
  }

  // Eliminar trades que el cliente ya no tiene activos
  const ids     = new Set(valid.map(t => t.id));
  const removed = serverState.activeTrades.filter(t => !ids.has(t.id));
  serverState.activeTrades = serverState.activeTrades.filter(t => ids.has(t.id));
  const deletes = removed.map(t => db.deleteActiveTrade(t.id));

  await Promise.all([...inserts, ...deletes]);
  res.json({ ok: true, watching: serverState.activeTrades.length });
});

/* ── Trades cerrados por el servidor ──────────────────────────────── */
router.get('/closed-by-server', requireAuth, (req, res) => {
  res.json({ closed: [...serverState.closedTrades] });
});

/* ── Confirmar recepción de trades cerrados ───────────────────────── */
router.post('/confirm-closed', requireAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids inválido' });
  serverState.closedTrades = serverState.closedTrades.filter(t => !ids.includes(t.id));
  await db.deleteClosedTrades(ids);
  res.json({ ok: true });
});

/* ── Cerrar trade manualmente (guarda en Supabase) ───────────────── */
router.post('/close', requireAuth, async (req, res) => {
  const { trade } = req.body;
  if (!trade || !trade.id) return res.status(400).json({ error: 'trade inválido' });

  try {
    // Eliminar de activos en memoria y Supabase
    serverState.activeTrades = serverState.activeTrades.filter(t => t.id !== trade.id);
    await db.deleteActiveTrade(trade.id);

    // Guardar como cerrado en memoria y Supabase
    const exists = serverState.closedTrades.some(t => t.id === trade.id);
    if (!exists) {
      serverState.closedTrades.unshift(trade);
    }
    await db.saveClosedTrade(trade);

    res.json({ ok: true });
  } catch (err) {
    console.error('[trades/close]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Precios actuales ─────────────────────────────────────────────── */
router.get('/prices', requireAuth, (req, res) =>
  res.json(serverState.prices),
);

/* ── Exportar historial CSV ───────────────────────────────────────── */
router.get('/export-csv', requireAuth, (req, res) => {
  const trades = serverState.closedTrades;
  if (!trades.length)
    return res.status(404).json({ error: 'Sin trades cerrados para exportar.' });

  const header = 'ID,Par,Tipo,Entrada,StopLoss,TP1,TP2,Size,Leverage,Resultado,PnL_USD,Cerrado_En,Notas\n';
  const rows   = trades.map(t => {
    const v = x => (x == null ? '' : String(x).replace(/,/g, ';'));
    return [
      v(t.id), v(t.par), v(t.tipo), v(t.entrada), v(t.stopLoss),
      v(t.tp1), v(t.tp2 || ''), v(t.size), v(t.leverage || 1),
      v(t.result), v(t.pnl?.toFixed(2)), v(t.closedAt), v(t.notes || ''),
    ].join(',');
  }).join('\n');

  const filename = `cryptoplan-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\ufeff' + header + rows); // BOM para Excel
});

/* ── Equity Curve ────────────────────────────────────────────────────
   Devuelve la curva de equity acumulada a lo largo del tiempo.
   Cada punto: { date, pnl, cumPnl, result, par, tipo }
   ──────────────────────────────────────────────────────────────────── */
router.get('/equity-curve', requireAuth, (req, res) => {
  const trades = [...serverState.closedTrades].reverse(); // cronológico
  if (!trades.length) return res.json({ points: [], summary: {} });

  let cumPnl = 0;
  const points = trades.map((t, i) => {
    cumPnl += t.pnl || 0;
    return {
      index:    i + 1,
      date:     t.closedAt || `Trade ${i + 1}`,
      pnl:      parseFloat((t.pnl || 0).toFixed(2)),
      cumPnl:   parseFloat(cumPnl.toFixed(2)),
      result:   t.result,
      par:      t.par,
      tipo:     t.tipo,
    };
  });

  const wins      = trades.filter(t => t.result === 'WIN').length;
  const losses    = trades.length - wins;
  const winRate   = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0;
  const totalPnl  = parseFloat(cumPnl.toFixed(2));
  const avgWin    = wins > 0
    ? parseFloat((trades.filter(t => t.result === 'WIN').reduce((a, t) => a + (t.pnl || 0), 0) / wins).toFixed(2))
    : 0;
  const avgLoss   = losses > 0
    ? parseFloat((trades.filter(t => t.result !== 'WIN').reduce((a, t) => a + (t.pnl || 0), 0) / losses).toFixed(2))
    : 0;
  const maxDrawdown = calcMaxDrawdown(points.map(p => p.cumPnl));

  res.json({
    points,
    summary: { total: trades.length, wins, losses, winRate, totalPnl, avgWin, avgLoss, maxDrawdown },
  });
});

function calcMaxDrawdown(cumPnls) {
  let peak = -Infinity, maxDD = 0;
  for (const v of cumPnls) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  return parseFloat(maxDD.toFixed(2));
}

module.exports = router;