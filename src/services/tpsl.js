'use strict';

/**
 * CryptoPlan IA — tpsl.js v3
 *
 * Motor ÚNICO y autoritativo de TP/SL. El cliente nunca cierra trades —
 * solo escucha los eventos WS que emite este módulo.
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
   MOTOR PRINCIPAL
   ═══════════════════════════════════════════════════════ */

async function checkTPSL(coin, price) {
  const toRemove = [];

  for (const trade of serverState.activeTrades) {
    if (coinOf(trade.par) !== coin) continue;

    const isLong = trade.tipo === 'LONG';

    /* ── TP1: cierre parcial 50% + breakeven ──────────────────────── */
    if (trade.tp2 && !trade.tp1Hit) {
      const hitTP1 = isLong ? price >= trade.tp1 : price <= trade.tp1;
      if (hitTP1) {
        await _handleTP1(trade, price);
        continue; // trade sigue activo con el 50% restante
      }
    }

    /* ── TP1 sin TP2: cierre total ────────────────────────────────── */
    if (!trade.tp2 && !trade.tp1Hit) {
      const hitTP1 = isLong ? price >= trade.tp1 : price <= trade.tp1;
      if (hitTP1) {
        const { net, fees } = calcNetPnL(trade, trade.tp1, 'maker');
        const total = net + (trade.partialClosePnl || 0);
        await _closeTrade(trade, trade.tp1, 'WIN', total, fees);
        toRemove.push(trade.id);
        continue;
      }
    }

    /* ── TP2: cierre total del restante ───────────────────────────── */
    if (trade.tp2 && trade.tp1Hit) {
      const hitTP2 = isLong ? price >= trade.tp2 : price <= trade.tp2;
      if (hitTP2) {
        const { net, fees } = calcNetPnL(trade, trade.tp2, 'maker');
        const total = net + (trade.partialClosePnl || 0);
        await _closeTrade(trade, trade.tp2, 'WIN', total, fees);
        toRemove.push(trade.id);
        continue;
      }
    }

    /* ── Stop Loss ────────────────────────────────────────────────── */
    const hitSL = isLong ? price <= trade.stopLoss : price >= trade.stopLoss;
    if (hitSL) {
      const { net, fees } = calcNetPnL(trade, trade.stopLoss, 'taker');
      const total = net + (trade.partialClosePnl || 0);
      const result = trade.breakevenSet
        ? (Math.abs(total) < 1 ? 'BREAKEVEN' : total > 0 ? 'WIN' : 'LOSS')
        : 'LOSS';
      await _closeTrade(trade, trade.stopLoss, result, total, fees);
      toRemove.push(trade.id);
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

  // 3. Actualizar SL en Bitunix
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

/**
 * Cierre parcial: orden MARKET reduceOnly para cerrar `qty` contratos.
 * @returns {boolean} true si la orden fue aceptada por Bitunix
 */
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

/**
 * Actualiza el stop loss de la posición en Bitunix.
 */
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

/**
 * Cierra una posición completa via flash_close.
 */
async function _bitunixFlashClose(trade) {
  const symbol = trade.bitunixSymbol || trade.par.replace('/', '');

  // Intentar con positionId guardado primero
  if (trade.bitunixPos) {
    await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, {
      positionId: trade.bitunixPos,
    });
    return;
  }

  // Buscar posición activa por símbolo
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
   CIRCUIT BREAKER — persiste entre reinicios
   (lee desde closedTrades cargados de Supabase)
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