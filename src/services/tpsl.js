'use strict';

const { serverState } = require('../state');
const db = require('../db/supabase');
const { notifyTradeClosed, notifyBreakeven, notifyPartialClose } = require('./telegram');
const {
  calcPnL, coinOf, nowFull,
  calcBreakevenPrice,
  calcNetPnL,
  FEES,
} = require('./calculations');

let broadcastFn = null;

function setBroadcast(fn) { broadcastFn = fn; }

/**
 * Verifica todos los trades activos contra el precio entrante.
 *
 * Lógica de salidas (estrategia institucional):
 *   1. Si se toca TP1 y hay TP2:
 *      a) Cierre PARCIAL: 50% de la posición a precio TP1
 *      b) SL → breakeven real (entrada ± fees 0.08%)
 *      c) El 50% restante sigue hacia TP2 con riesgo $0
 *   2. Si se toca TP1 sin TP2: cierre total
 *   3. Si se toca TP2: cierre total del restante
 *   4. Si se toca SL: cierre total (o breakeven si ya fue activado)
 */
async function checkTPSL(coin, price) {
  const toRemove = [];

  for (const trade of serverState.activeTrades) {
    if (coinOf(trade.par) !== coin) continue;

    // ── TP1 con cierre parcial y breakeven ──────────────────────────────
    if (trade.tp2 && !trade.tp1Hit) {
      const hitTP1 = trade.tipo === 'LONG' ? price >= trade.tp1 : price <= trade.tp1;

      if (hitTP1) {
        trade.tp1Hit = true;

        // Calcular cierre parcial (50%)
        const closeQty = parseFloat((trade.size * 0.5).toFixed(6));
        const remainQty = parseFloat((trade.size * 0.5).toFixed(6));
        const partialPnl = calcNetPnL({ ...trade, size: closeQty }, trade.tp1, 'maker');

        // Mover SL a breakeven real (entrada ± comisiones)
        const newSL = calcBreakevenPrice(trade.entrada, trade.tipo);
        trade.stopLoss = newSL;
        trade.size = remainQty;
        trade.breakevenSet = true;
        trade.partialClosed = true;
        trade.partialCloseQty = closeQty;
        trade.partialClosePnl = partialPnl.netPnl;
        trade.partialClosePrice = trade.tp1;

        await db.saveActiveTrade(trade).catch(() => { });

        // Notificaciones
        if (notifyPartialClose) {
          notifyPartialClose(trade, closeQty, partialPnl.netPnl, newSL).catch(() => { });
        }
        if (broadcastFn) {
          broadcastFn({
            type: 'PARTIAL_CLOSE',
            trade,
            partialQty: closeQty,
            partialPnl: partialPnl.netPnl,
            newSL,
          });
        }

        console.log(
          `[TP1/Parcial] ${trade.par} — Cerrado ${closeQty} @ ${trade.tp1}` +
          ` | P&L neto: $${partialPnl.netPnl.toFixed(2)}` +
          ` | SL → BE ${newSL} | Resto: ${remainQty}`
        );
        continue; // el trade sigue activo con el 50% restante
      }
    }

    // ── TP1 sin TP2 (cierre total) ───────────────────────────────────────
    if (!trade.tp2 && !trade.tp1Hit) {
      const hitTP1 = trade.tipo === 'LONG' ? price >= trade.tp1 : price <= trade.tp1;
      if (hitTP1) {
        trade.tp1Hit = true;
        const { netPnl, fees } = calcNetPnL(trade, trade.tp1, 'maker');
        const closed = _buildClosed(trade, trade.tp1, 'WIN', netPnl, fees, price);
        await _closeTrade(trade, closed);
        toRemove.push(trade.id);
        continue;
      }
    }

    // ── TP2 (cierre total del restante) ─────────────────────────────────
    if (trade.tp2) {
      const hitTP2 = trade.tipo === 'LONG' ? price >= trade.tp2 : price <= trade.tp2;
      if (hitTP2) {
        const { netPnl, fees } = calcNetPnL(trade, trade.tp2, 'maker');
        const totalNetPnl = netPnl + (trade.partialClosePnl || 0);
        const closed = _buildClosed(trade, trade.tp2, 'WIN', totalNetPnl, fees, price);
        closed.partialClosePnl = trade.partialClosePnl || 0;
        closed.partialCloseQty = trade.partialCloseQty || 0;
        await _closeTrade(trade, closed);
        toRemove.push(trade.id);
        continue;
      }
    }

    // ── Stop Loss ────────────────────────────────────────────────────────
    const hitSL = trade.tipo === 'LONG' ? price <= trade.stopLoss : price >= trade.stopLoss;
    if (hitSL) {
      const { netPnl, fees } = calcNetPnL(trade, trade.stopLoss, 'taker'); // SL = taker
      const result = trade.breakevenSet
        ? (Math.abs(netPnl) < 1 ? 'BREAKEVEN' : netPnl > 0 ? 'WIN' : 'LOSS')
        : 'LOSS';
      const totalNetPnl = netPnl + (trade.partialClosePnl || 0);
      const closed = _buildClosed(trade, trade.stopLoss, result, totalNetPnl, fees, price);
      await _closeTrade(trade, closed);
      toRemove.push(trade.id);
    }
  }

  if (toRemove.length) {
    serverState.activeTrades = serverState.activeTrades.filter(
      t => !toRemove.includes(t.id),
    );
  }
}

/* ── Helpers internos ──────────────────────────────────────────────────── */

function _buildClosed(trade, exitPrice, result, netPnl, fees, currentPrice) {
  return {
    ...trade,
    result,
    pnl: parseFloat(netPnl.toFixed(4)),
    pnlGross: parseFloat(calcPnL(trade, exitPrice).toFixed(4)),
    fees: parseFloat(fees.toFixed(4)),
    exitPrice,
    currentPrice,
    closedAt: nowFull(),
    closedByServer: true,
  };
}

async function _closeTrade(trade, closed) {
  serverState.closedTrades.unshift(closed);
  await db.saveClosedTrade(closed).catch(() => { });
  await db.deleteActiveTrade(trade.id).catch(() => { });

  if (broadcastFn) broadcastFn({ type: 'TRADE_CLOSED', trade: closed });
  notifyTradeClosed(closed, closed.result, closed.pnl);

  console.log(
    `[TP/SL] ${trade.par} → ${closed.result}` +
    ` | Neto: $${closed.pnl.toFixed(2)} (bruto: $${closed.pnlGross.toFixed(2)}, fees: $${closed.fees.toFixed(2)})` +
    `${trade.breakevenSet ? ' [BE activo]' : ''}`
  );
}

module.exports = { setBroadcast, checkTPSL, calcPnL, coinOf, nowFull };