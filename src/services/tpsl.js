'use strict';

/**
 * CryptoPlan IA — tpsl.js v3.1 (AUDITADO)
 *
 * CORRECCIÓN CRÍTICA: Se añade `processingTrades` (Set) como mutex ligero
 * para evitar que dos ticks de precio concurrentes cierren el mismo trade
 * dos veces en los caminos TP2 y SL (Race Condition).
 *
 * En Node.js single-threaded, la operación Set.add() es SÍNCRONA y ocurre
 * ANTES del primer `await`, lo que garantiza exclusión mutua sin librerías
 * externas (Mutex, semáforo, etc.) en el contexto del event loop.
 *
 * Flujo completo para un trade con TP1 + TP2:
 *   1. Precio toca TP1
 *      → Cierre parcial 50% en Bitunix (reduceOnly MARKET)
 *      → SL del restante → breakeven real (entrada ± 0.08% fees)
 *      → Broadcast PARTIAL_CLOSE al cliente
 *   2. Precio toca TP2
 *      → Cierre total del 50% restante (flash_close)
 *      → Broadcast TRADE_CLOSED
 *   3. Precio toca SL
 *      → Cierre total (flash_close)
 *      → Broadcast TRADE_CLOSED
 */

const { serverState } = require('../state');
const db = require('../db/supabase');
const telegram = require('./telegram');
const {
  calcPnL, coinOf, nowFull,
  calcBreakevenPrice, calcNetPnL,
} = require('./calculations');
const { bitunixRequest, isBitunixConfigured } = require('./bitunix');

let broadcastFn = null;
function setBroadcast(fn) { broadcastFn = fn; }

/* ═══════════════════════════════════════════════════════
   MUTEX LIGERO — previene doble cierre en TP2 / SL
   Set de IDs de trades que están siendo procesados ahora mismo.
   Como Node.js es single-threaded, .add() es atómico respecto
   al event loop: ocurre sincronamente antes del primer await.
   ═══════════════════════════════════════════════════════ */
const processingTrades = new Set();

/* ═══════════════════════════════════════════════════════
   MOTOR PRINCIPAL
   ═══════════════════════════════════════════════════════ */

async function checkTPSL(coin, price) {
  // Optimización: salida temprana si no hay trades activos
  if (!serverState.activeTrades.length) return;

  const toRemove = [];

  for (const trade of serverState.activeTrades) {
    if (coinOf(trade.par) !== coin) continue;

    // ── GUARD: si este trade ya está siendo procesado por otra
    //    llamada asíncrona concurrente, lo saltamos.
    if (processingTrades.has(trade.id)) continue;

    const isLong = trade.tipo === 'LONG';

    /* ── TP1: cierre parcial 50% + breakeven ──────────────────────── */
    if (trade.tp2 && !trade.tp1Hit) {
      const hitTP1 = isLong ? price >= trade.tp1 : price <= trade.tp1;
      if (hitTP1) {
        // _handleTP1 inicia con `trade.tp1Hit = true` de forma SÍNCRONA
        // antes de cualquier await — el guard por processingTrades es
        // redundante para TP1, pero lo añadimos por consistencia.
        processingTrades.add(trade.id);
        _handleTP1(trade, price).finally(() => processingTrades.delete(trade.id));
        continue; // trade sigue activo con el 50% restante
      }
    }

    /* ── TP1 sin TP2: cierre total ────────────────────────────────── */
    if (!trade.tp2 && !trade.tp1Hit) {
      const hitTP1 = isLong ? price >= trade.tp1 : price <= trade.tp1;
      if (hitTP1) {
        // ATÓMICO: add antes del primer await
        processingTrades.add(trade.id);
        const { net, fees } = calcNetPnL(trade, trade.tp1, 'maker');
        const total = net + (trade.partialClosePnl || 0);
        try {
          await _closeTrade(trade, trade.tp1, 'WIN', total, fees);
          toRemove.push(trade.id);
        } catch (e) {
          console.error(`[TP1-solo close] ${trade.id}: ${e.message}`);
        } finally {
          processingTrades.delete(trade.id);
        }
        continue;
      }
    }

    /* ── TP2: cierre total del restante ───────────────────────────── */
    if (trade.tp2 && trade.tp1Hit) {
      const hitTP2 = isLong ? price >= trade.tp2 : price <= trade.tp2;
      if (hitTP2) {
        // ATÓMICO: add antes del primer await — previene doble cierre
        processingTrades.add(trade.id);
        const { net, fees } = calcNetPnL(trade, trade.tp2, 'maker');
        const total = net + (trade.partialClosePnl || 0);
        try {
          await _closeTrade(trade, trade.tp2, 'WIN', total, fees);
          toRemove.push(trade.id);
        } catch (e) {
          console.error(`[TP2 close] ${trade.id}: ${e.message}`);
        } finally {
          processingTrades.delete(trade.id);
        }
        continue;
      }
    }

    /* ── Stop Loss ────────────────────────────────────────────────── */
    const hitSL = isLong ? price <= trade.stopLoss : price >= trade.stopLoss;
    if (hitSL) {
      // ATÓMICO: add antes del primer await — previene doble cierre
      processingTrades.add(trade.id);
      const { net, fees } = calcNetPnL(trade, trade.stopLoss, 'taker');
      const total = net + (trade.partialClosePnl || 0);
      const result = trade.breakevenSet
        ? (Math.abs(total) < 1 ? 'BREAKEVEN' : total > 0 ? 'WIN' : 'LOSS')
        : 'LOSS';
      try {
        await _closeTrade(trade, trade.stopLoss, result, total, fees);
        toRemove.push(trade.id);
      } catch (e) {
        console.error(`[SL close] ${trade.id}: ${e.message}`);
      } finally {
        processingTrades.delete(trade.id);
      }
    }
  }

  if (toRemove.length) {
    serverState.activeTrades = serverState.activeTrades.filter(
      t => !toRemove.includes(t.id),
    );
  }
}

/* ═══════════════════════════════════════════════════════
   TP1 — CIERRE PARCIAL + BREAKEVEN
   ═══════════════════════════════════════════════════════ */

async function _handleTP1(trade, currentPrice) {
  // IMPORTANTE: esta línea es síncrona — ocurre antes de cualquier await.
  // Esto garantiza que ningún otro tick llame a _handleTP1 para este trade.
  trade.tp1Hit = true;

  const closeQty = parseFloat((trade.size * 0.5).toFixed(6));
  const remainQty = parseFloat((trade.size * 0.5).toFixed(6));
  const pnlData = calcNetPnL({ ...trade, size: closeQty }, trade.tp1, 'maker');

  // 1. Ejecutar cierre parcial en Bitunix
  let bitunixOk = false;
  if (isBitunixConfigured() && trade.bitunixSymbol) {
    bitunixOk = await _bitunixPartialClose(trade, closeQty);
  }

  // 2. Calcular y mover SL a breakeven real
  const newSL = calcBreakevenPrice(trade.entrada, trade.tipo);
  trade.stopLoss = newSL;
  trade.size = remainQty;
  trade.breakevenSet = true;
  trade.partialClosed = true;
  trade.partialCloseQty = closeQty;
  trade.partialClosePnl = parseFloat(pnlData.net.toFixed(4));
  trade.partialClosePrice = trade.tp1;
  trade.partialCloseFees = parseFloat(pnlData.fees.toFixed(4));

  // 3. Actualizar SL en Bitunix (no bloquea — errores son warnings)
  if (isBitunixConfigured() && trade.bitunixSymbol) {
    _bitunixUpdateSL(trade, newSL).catch(e =>
      console.warn(`[TP1] SL update fallido: ${e.message}`)
    );
  }

  // 4. Persistir en Supabase
  await db.saveActiveTrade(trade).catch(() => { });

  // 5. Broadcast WS al cliente
  if (broadcastFn) {
    broadcastFn({
      type: 'PARTIAL_CLOSE',
      trade: { ...trade },
      partialQty: closeQty,
      partialPnl: pnlData.net,
      partialFees: pnlData.fees,
      newSL,
      bitunixOk,
    });
  }

  // 6. Telegram
  if (telegram.notifyPartialClose) {
    telegram.notifyPartialClose(trade, closeQty, pnlData.net, newSL).catch(() => { });
  }

  console.log(
    `[TP1/Parcial] ${trade.par}` +
    ` | Qty cerrada: ${closeQty} @ $${trade.tp1}` +
    ` | Neto: +$${pnlData.net.toFixed(2)} (fees: $${pnlData.fees.toFixed(2)})` +
    ` | SL → BE: $${newSL} | Resto: ${remainQty}` +
    ` | Bitunix: ${bitunixOk ? '✓ OK' : isBitunixConfigured() ? '✗ FALLO' : 'PAPER'}`
  );
}

/* ═══════════════════════════════════════════════════════
   CIERRE TOTAL
   ═══════════════════════════════════════════════════════ */

async function _closeTrade(trade, exitPrice, result, netPnl, fees) {
  const grossPnl = calcPnL(trade, exitPrice);
  const closed = {
    ...trade,
    result,
    pnl: parseFloat(netPnl.toFixed(4)),
    pnlGross: parseFloat(grossPnl.toFixed(4)),
    fees: parseFloat((fees || 0).toFixed(4)),
    exitPrice,
    closedAt: nowFull(),
    closedByServer: true,
  };

  // 1. Cerrar en Bitunix
  if (isBitunixConfigured() && (trade.bitunixPos || trade.bitunixSymbol)) {
    await _bitunixFlashClose(trade).catch(e =>
      console.warn(`[Close] flash_close fallido: ${e.message}`)
    );
  }

  // 2. Persistir
  serverState.closedTrades.unshift(closed);
  await db.saveClosedTrade(closed).catch(() => { });
  await db.deleteActiveTrade(trade.id).catch(() => { });

  // 3. Notificar
  if (broadcastFn) broadcastFn({ type: 'TRADE_CLOSED', trade: closed });
  telegram.notifyTradeClosed(closed, result, netPnl);

  const emoji = result === 'WIN' ? '✅' : result === 'BREAKEVEN' ? '↔' : '❌';
  console.log(
    `${emoji} [${result}] ${trade.par} @ $${exitPrice}` +
    ` | Neto: $${netPnl.toFixed(2)} (bruto: $${grossPnl.toFixed(2)}, fees: $${(fees || 0).toFixed(2)})` +
    `${trade.breakevenSet ? ' [BE activo]' : ''}` +
    `${trade.partialClosed ? ` [+$${(trade.partialClosePnl || 0).toFixed(2)} TP1 parcial]` : ''}`
  );
}

/* ═══════════════════════════════════════════════════════
   BITUNIX HELPERS
   ═══════════════════════════════════════════════════════ */

async function _bitunixPartialClose(trade, qty) {
  try {
    const symbol = trade.bitunixSymbol || trade.par.replace('/', '');
    const closeSide = trade.tipo === 'LONG' ? 'SELL' : 'BUY';
    const body = {
      symbol,
      qty: String(parseFloat(qty.toFixed(6))),
      side: closeSide,
      tradeSide: 'CLOSE',
      orderType: 'MARKET',
      reduceOnly: true,
      clientId: `cp_partial_${trade.id.slice(-8)}_${Date.now()}`,
    };
    const data = await bitunixRequest('POST', '/api/v1/futures/trade/place_order', {}, body);
    console.log(`[Bitunix partial] orderId=${data.data?.orderId}`);
    return true;
  } catch (e) {
    console.error(`[Bitunix partial] ${e.message}`);
    return false;
  }
}

async function _bitunixUpdateSL(trade, newSL) {
  const symbol = trade.bitunixSymbol || trade.par.replace('/', '');
  const side = trade.tipo === 'LONG' ? 'BUY' : 'SELL';
  const posData = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
  const positions = Array.isArray(posData.data) ? posData.data : [];
  const pos = positions.find(
    p => p.symbol === symbol && (p.side === side || p.positionSide === side)
  );
  if (!pos) throw new Error(`Sin posición ${symbol} en Bitunix`);
  await bitunixRequest('POST', '/api/v1/futures/trade/set_risk_limit', {}, {
    positionId: pos.positionId,
    stopLoss: String(newSL),
  });
  console.log(`[Bitunix SL] ${symbol} → $${newSL}`);
}

async function _bitunixFlashClose(trade) {
  const symbol = trade.bitunixSymbol || trade.par.replace('/', '');
  if (trade.bitunixPos) {
    await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, {
      positionId: trade.bitunixPos,
    });
    return;
  }
  const posData = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
  const positions = Array.isArray(posData.data) ? posData.data : [];
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) {
    console.warn(`[flash_close] ${symbol} no encontrada — posiblemente ya cerrada`);
    return;
  }
  await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, {
    positionId: pos.positionId,
  });
  console.log(`[Bitunix flash_close] ${symbol} ✓`);
}

/* ═══════════════════════════════════════════════════════
   CIRCUIT BREAKER
   ═══════════════════════════════════════════════════════ */

function getServerConsecutiveLosses() {
  let count = 0;
  for (const t of serverState.closedTrades) {
    if (t.result === 'LOSS') count++;
    else break;
  }
  return count;
}

function isServerCircuitBreakerActive(maxConsec = 2) {
  const losses = getServerConsecutiveLosses();
  return { active: losses >= maxConsec, losses, maxConsec };
}

module.exports = {
  setBroadcast,
  checkTPSL,
  getServerConsecutiveLosses,
  isServerCircuitBreakerActive,
  calcPnL,
  coinOf,
  nowFull,
};