'use strict';

const { serverState }              = require('../state');
const db                           = require('../db/supabase');
const { notifyTradeClosed }        = require('./telegram');
const { calcPnL, coinOf, nowFull } = require('./calculations');

let broadcastFn = null;

/** Inyectar función broadcast de WebSocket */
function setBroadcast(fn) { broadcastFn = fn; }

/**
 * Verifica todos los trades activos contra el precio entrante.
 * Cierra automáticamente si se alcanza TP2 (o TP1 si no hay TP2) o SL.
 */
async function checkTPSL(coin, price) {
  const toRemove = [];

  for (const trade of serverState.activeTrades) {
    if (coinOf(trade.par) !== coin) continue;

    const target = trade.tp2 || trade.tp1;
    const hitSL  = trade.tipo === 'LONG' ? price <= trade.stopLoss : price >= trade.stopLoss;
    const hitTP  = trade.tipo === 'LONG' ? price >= target         : price <= target;

    if (!hitSL && !hitTP) continue;

    const exit   = hitTP ? target : trade.stopLoss;
    const pnl    = calcPnL(trade, exit);
    const closed = {
      ...trade,
      result:         hitTP ? 'WIN' : 'LOSS',
      pnl,
      closedAt:       nowFull(),
      closedByServer: true,
    };

    serverState.closedTrades.unshift(closed);
    toRemove.push(trade.id);

    db.saveClosedTrade(closed).catch(() => {});
    db.deleteActiveTrade(trade.id).catch(() => {});

    if (broadcastFn) broadcastFn({ type: 'TRADE_CLOSED', trade: closed });
    notifyTradeClosed(closed, closed.result, pnl);
    console.log(`[TP/SL] ${trade.par} → ${closed.result} | PnL: $${pnl.toFixed(2)}`);
  }

  if (toRemove.length) {
    serverState.activeTrades = serverState.activeTrades.filter(
      t => !toRemove.includes(t.id),
    );
  }
}

module.exports = { setBroadcast, checkTPSL, calcPnL, coinOf, nowFull };
