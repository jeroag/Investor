'use strict';

/**
 * CryptoPlan IA — Strategy Core (Day Trading Institucional)
 * Toda la lógica matemática de la estrategia vive aquí.
 *
 * Reglas base:
 *  - Activo principal: BTC/USDT (sesión NY 14:30–19:00 CET)
 *  - Riesgo: 1% del equity actual por operación
 *  - TP1 ratio: 1.2:1 | TP2: configurable (default 2.5:1)
 *  - Cierre parcial: 50% en TP1
 *  - Breakeven real: entrada ± comisiones (taker 0.06% + maker 0.02%)
 *  - Circuit breaker: 2 pérdidas consecutivas = stop operativo
 */

/* ═══════════════════════════════════════════════════════
   COMISIONES BITUNIX
   ═══════════════════════════════════════════════════════ */
const FEES = {
  TAKER: 0.0006,   // 0.06% — órdenes de mercado (entrada/salida rápida)
  MAKER: 0.0002,   // 0.02% — órdenes límite (SL/TP colocados)
  ROUND_TRIP: 0.0006 + 0.0002,  // 0.08% — apertura taker + cierre maker
};

/* ═══════════════════════════════════════════════════════
   SESIÓN DE NUEVA YORK
   14:30–19:00 CET = 13:30–18:00 UTC
   ═══════════════════════════════════════════════════════ */

/**
 * Comprueba si el momento actual está dentro de la ventana operativa NY.
 * @param {Date} [now]
 * @returns {{ inSession: boolean, reason: string }}
 */
function checkNYSession(now = new Date()) {
  const day = now.getUTCDay(); // 0=dom, 6=sab
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const mins = h * 60 + m;

  if (day === 0 || day === 6) {
    return { inSession: false, reason: 'Fin de semana — mercado institucional inactivo' };
  }

  // Cierre anticipado viernes: 17:30 UTC (18:30 CET)
  if (day === 5 && mins >= 17 * 60 + 30) {
    return { inSession: false, reason: 'Viernes tarde — liquidez institucional caída' };
  }

  // Ventana NY: 13:30–18:00 UTC
  const sessionStart = 13 * 60 + 30;
  const sessionEnd = 18 * 60;

  if (mins >= sessionStart && mins < sessionEnd) {
    const minutesLeft = sessionEnd - mins;
    return {
      inSession: true,
      reason: `Sesión NY activa — ${minutesLeft}min restantes`,
      minutesLeft,
    };
  }

  if (mins < sessionStart) {
    const minsToOpen = sessionStart - mins;
    return { inSession: false, reason: `Sesión NY abre en ${minsToOpen}min (13:30 UTC / 14:30 CET)` };
  }

  return { inSession: false, reason: 'Sesión NY cerrada (19:00 CET)' };
}

/**
 * Valida si se puede operar fuera de sesión aplicando filtro de volumen.
 * @param {number} currentVol     Volumen de la vela actual
 * @param {number[]} recentVols   Últimas 20 velas del mismo TF
 * @param {number} [multiplier]   Mínimo requerido (default 1.5×)
 * @returns {{ ok: boolean, ratio: number, reason: string }}
 */
function validateVolumeFilter(currentVol, recentVols, multiplier = 1.5) {
  if (!recentVols || recentVols.length < 5) {
    return { ok: false, ratio: 0, reason: 'Datos de volumen insuficientes' };
  }
  const avg = recentVols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(recentVols.length, 20);
  const ratio = avg > 0 ? currentVol / avg : 0;
  const ok = ratio >= multiplier;
  return {
    ok,
    ratio: parseFloat(ratio.toFixed(2)),
    reason: ok
      ? `Volumen válido: ${ratio.toFixed(2)}× avg20 (≥${multiplier}×)`
      : `Volumen insuficiente: ${ratio.toFixed(2)}× avg20 (mínimo ${multiplier}× requerido fuera de sesión)`,
  };
}

/* ═══════════════════════════════════════════════════════
   POSITION SIZING — 1% DINÁMICO
   ═══════════════════════════════════════════════════════ */

/**
 * Calcula el equity actual de la cuenta.
 * El riesgo siempre se aplica sobre el equity real, no el capital inicial.
 *
 * @param {number} capital       Capital base configurado
 * @param {number} closedPnl     P&L de trades cerrados
 * @param {number} activePnl     P&L latente de trades abiertos
 * @returns {number}
 */
function calcCurrentEquity(capital, closedPnl = 0, activePnl = 0) {
  return capital + closedPnl + activePnl;
}

/**
 * Calcula el riesgo en USD para el trade (1% del equity actual).
 * @param {number} equity
 * @param {number} [riskPct=1]  Porcentaje de riesgo (default 1%)
 * @returns {number}
 */
function calcRiskUSD(equity, riskPct = 1) {
  return equity * riskPct / 100;
}

/**
 * Calcula el tamaño de posición para arriesgar exactamente riskUSD.
 *
 * Fórmula: qty = riskUSD / |entrada - stopLoss|
 * El apalancamiento NO afecta qty, solo reduce el margen requerido.
 *
 * @param {number} riskUSD    Riesgo en dólares (1% equity)
 * @param {number} entry      Precio de entrada
 * @param {number} stopLoss   Precio del stop loss
 * @param {number} [leverage] Apalancamiento (default 1)
 * @returns {{ qty: number, margin: number, notional: number, slDist: number, slPct: number }}
 */
function calcPositionSize(riskUSD, entry, stopLoss, leverage = 1) {
  const slDist = Math.abs(entry - stopLoss);
  if (slDist === 0) return { qty: 0, margin: 0, notional: 0, slDist: 0, slPct: 0 };

  const qty = riskUSD / slDist;
  const notional = qty * entry;
  const margin = notional / leverage;
  const slPct = (slDist / entry) * 100;

  return {
    qty: parseFloat(qty.toFixed(6)),
    margin: parseFloat(margin.toFixed(2)),
    notional: parseFloat(notional.toFixed(2)),
    slDist: parseFloat(slDist.toFixed(6)),
    slPct: parseFloat(slPct.toFixed(3)),
  };
}

/* ═══════════════════════════════════════════════════════
   TARGETS — TP1, TP2, BREAKEVEN
   ═══════════════════════════════════════════════════════ */

/**
 * Calcula TP1 y TP2 a partir de entrada, SL y ratios objetivo.
 *
 * @param {number} entry
 * @param {number} stopLoss
 * @param {'LONG'|'SHORT'} tipo
 * @param {number} [tp1Ratio=1.2]   R:R del TP1 (default 1.2:1)
 * @param {number} [tp2Ratio=2.5]   R:R del TP2 (default 2.5:1)
 * @returns {{ tp1: number, tp2: number, rrFormatted: string }}
 */
function calcTargets(entry, stopLoss, tipo, tp1Ratio = 1.2, tp2Ratio = 2.5) {
  const slDist = Math.abs(entry - stopLoss);
  const dir = tipo === 'LONG' ? 1 : -1;

  const tp1 = parseFloat((entry + dir * slDist * tp1Ratio).toFixed(6));
  const tp2 = parseFloat((entry + dir * slDist * tp2Ratio).toFixed(6));

  return {
    tp1,
    tp2,
    rrFormatted: `1:${tp1Ratio} / 1:${tp2Ratio}`,
  };
}

/**
 * Calcula el precio de breakeven real incluyendo comisiones.
 * Al mover el SL a breakeven, queremos que en el peor caso el trade sea $0 real.
 *
 * LONG:  BE = entrada × (1 + TAKER_OPEN + MAKER_CLOSE) = entrada × 1.0008
 * SHORT: BE = entrada × (1 - TAKER_OPEN - MAKER_CLOSE) = entrada × 0.9992
 *
 * @param {number} entry
 * @param {'LONG'|'SHORT'} tipo
 * @returns {number} Precio de breakeven con fees
 */
function calcBreakevenPrice(entry, tipo) {
  const feeBuffer = FEES.ROUND_TRIP; // 0.0008
  if (tipo === 'LONG') {
    return parseFloat((entry * (1 + feeBuffer)).toFixed(6));
  }
  return parseFloat((entry * (1 - feeBuffer)).toFixed(6));
}

/**
 * Calcula el P&L real de un trade incluyendo comisiones (taker entrada + maker salida).
 *
 * @param {{ tipo: 'LONG'|'SHORT', entrada: number, size: number, leverage?: number }} trade
 * @param {number} exitPrice
 * @param {'taker'|'maker'} [exitFeeType='maker']
 * @returns {{ grossPnl: number, fees: number, netPnl: number }}
 */
function calcNetPnL(trade, exitPrice, exitFeeType = 'maker') {
  const lev = trade.leverage || 1;
  const notional = trade.entrada * trade.size;
  const exitNot = exitPrice * trade.size;

  const grossPnl = trade.tipo === 'LONG'
    ? (exitPrice - trade.entrada) * trade.size * lev
    : (trade.entrada - exitPrice) * trade.size * lev;

  const feeOpen = notional * FEES.TAKER;                               // apertura siempre taker
  const feeClose = exitNot * (exitFeeType === 'taker' ? FEES.TAKER : FEES.MAKER);
  const fees = parseFloat((feeOpen + feeClose).toFixed(4));
  const netPnl = parseFloat((grossPnl - fees).toFixed(4));

  return { grossPnl: parseFloat(grossPnl.toFixed(4)), fees, netPnl };
}

/* ═══════════════════════════════════════════════════════
   CIERRE PARCIAL — TP1
   ═══════════════════════════════════════════════════════ */

/**
 * Calcula los parámetros del cierre parcial en TP1.
 * Se cierra el 50% de la posición original.
 *
 * @param {object} trade         Trade activo
 * @param {number} [closePct=50] Porcentaje a cerrar en TP1
 * @returns {{ closeQty: number, remainQty: number, partialPnl: object }}
 */
function calcPartialClose(trade, closePct = 50) {
  const closeQty = parseFloat((trade.size * closePct / 100).toFixed(6));
  const remainQty = parseFloat((trade.size - closeQty).toFixed(6));

  const partialTrade = { ...trade, size: closeQty };
  const partialPnl = calcNetPnL(partialTrade, trade.tp1, 'maker');

  return { closeQty, remainQty, partialPnl, closePct };
}

/* ═══════════════════════════════════════════════════════
   CIRCUIT BREAKER
   ═══════════════════════════════════════════════════════ */

/**
 * Comprueba si las últimas N operaciones cerradas son todas LOSS.
 * Si es así, activa el circuit breaker y bloquea nuevas entradas.
 *
 * @param {object[]} closedTrades   Array de trades cerrados (más reciente primero)
 * @param {number}   [maxConsec=2]  Número de pérdidas consecutivas para bloquear
 * @returns {{ triggered: boolean, consecutiveLosses: number, reason: string }}
 */
function checkCircuitBreakerConsec(closedTrades, maxConsec = 2) {
  if (!closedTrades || closedTrades.length === 0) {
    return { triggered: false, consecutiveLosses: 0, reason: 'Sin historial' };
  }

  let count = 0;
  for (const t of closedTrades) {
    if (t.result === 'LOSS') count++;
    else break; // primera no-pérdida rompe la racha
  }

  const triggered = count >= maxConsec;
  return {
    triggered,
    consecutiveLosses: count,
    reason: triggered
      ? `⛔ Circuit Breaker: ${count} pérdidas consecutivas. Stop operativo hasta mañana.`
      : count > 0
        ? `⚠️ Alerta: ${count} pérdida(s) consecutiva(s). Máximo permitido: ${maxConsec}.`
        : 'OK',
  };
}

/**
 * Comprueba el P&L del día actual.
 * @param {object[]} closedTrades
 * @param {number}   dailyLossLimit   Límite de pérdida diaria en USD (positivo)
 * @returns {{ triggered: boolean, dailyPnl: number, reason: string }}
 */
function checkDailyLossLimit(closedTrades, dailyLossLimit) {
  if (!dailyLossLimit || dailyLossLimit <= 0) {
    return { triggered: false, dailyPnl: 0, reason: 'Sin límite diario configurado' };
  }
  const now = Date.now();
  const dayMs = 86_400_000;
  const today = closedTrades.filter(t => (now - new Date(t.closedAt || 0).getTime()) < dayMs);
  const dailyPnl = today.reduce((a, t) => a + (t.pnl || 0), 0);
  const triggered = dailyPnl <= -Math.abs(dailyLossLimit);

  return {
    triggered,
    dailyPnl: parseFloat(dailyPnl.toFixed(2)),
    reason: triggered
      ? `⛔ Límite diario alcanzado: P&L hoy ${dailyPnl.toFixed(2)} ≤ -$${dailyLossLimit}`
      : `P&L hoy: ${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)} (límite: -$${dailyLossLimit})`,
  };
}

/* ═══════════════════════════════════════════════════════
   FILTRO DE NOTICIAS
   ═══════════════════════════════════════════════════════ */

/**
 * Comprueba si el momento actual está en una ventana de noticias de alto impacto.
 * No operar 15min antes ni 30min después de eventos USD de alta importancia.
 *
 * @param {object[]} calendarEvents   Eventos del calendario económico
 * @param {Date}     [now]
 * @returns {{ blocked: boolean, event: object|null, reason: string }}
 */
function checkNewsFilter(calendarEvents, now = new Date()) {
  if (!calendarEvents || calendarEvents.length === 0) {
    return { blocked: false, event: null, reason: 'Sin eventos próximos' };
  }

  const nowMs = now.getTime();
  const beforeMs = 15 * 60 * 1000;  // 15 minutos
  const afterMs = 30 * 60 * 1000;  // 30 minutos

  for (const evt of calendarEvents) {
    if (evt.impact !== 'High') continue;
    if (!['USD', 'BTC'].includes(evt.currency)) continue; // solo USD y BTC relevantes

    let evtMs;
    try { evtMs = new Date(evt.date).getTime(); } catch { continue; }
    if (isNaN(evtMs)) continue;

    const diffMs = nowMs - evtMs;

    if (diffMs >= -beforeMs && diffMs <= afterMs) {
      const minsToEvent = Math.round(-diffMs / 60000);
      const minsAfter = Math.round(diffMs / 60000);
      return {
        blocked: true,
        event: evt,
        reason: diffMs < 0
          ? `⚠️ Evento de alto impacto en ${minsToEvent}min: ${evt.currency} ${evt.title}. Entrada bloqueada.`
          : `⚠️ ${minsAfter}min post-evento: ${evt.currency} ${evt.title}. Esperar a ${30 - minsAfter}min más.`,
      };
    }
  }

  return { blocked: false, event: null, reason: 'Sin eventos de riesgo próximos' };
}

/* ═══════════════════════════════════════════════════════
   VALIDACIÓN COMPLETA DE ENTRADA
   ═══════════════════════════════════════════════════════ */

/**
 * Valida todas las condiciones de la estrategia antes de abrir un trade.
 * Devuelve un resumen de todas las comprobaciones.
 *
 * @param {object} params
 * @param {number}   params.equity
 * @param {number}   params.entry
 * @param {number}   params.stopLoss
 * @param {'LONG'|'SHORT'} params.tipo
 * @param {object[]} params.closedTrades
 * @param {object[]} params.calendarEvents
 * @param {number}   params.dailyLossLimit
 * @param {number}   params.currentVol
 * @param {number[]} params.recentVols
 * @param {boolean}  [params.requireNYSession=true]
 * @returns {{ ok: boolean, checks: object, warnings: string[], errors: string[] }}
 */
function validateTradeEntry(params) {
  const {
    equity, entry, stopLoss, tipo,
    closedTrades = [], calendarEvents = [],
    dailyLossLimit = 0,
    currentVol = 0, recentVols = [],
    requireNYSession = true,
  } = params;

  const warnings = [];
  const errors = [];
  const checks = {};

  // 1. Sesión NY
  const session = checkNYSession();
  checks.session = session;
  if (!session.inSession) {
    if (requireNYSession) {
      // Fuera de sesión: aplicar filtro de volumen extra
      const volCheck = validateVolumeFilter(currentVol, recentVols);
      checks.volume = volCheck;
      if (!volCheck.ok) {
        errors.push(`${session.reason} — ${volCheck.reason}`);
      } else {
        warnings.push(`${session.reason} — Volume override: ${volCheck.ratio}×`);
      }
    }
  }

  // 2. Circuit breaker consecutivo
  const cbConsec = checkCircuitBreakerConsec(closedTrades, 2);
  checks.circuitBreakerConsec = cbConsec;
  if (cbConsec.triggered) {
    errors.push(cbConsec.reason);
  } else if (cbConsec.consecutiveLosses > 0) {
    warnings.push(cbConsec.reason);
  }

  // 3. Límite diario
  const cbDaily = checkDailyLossLimit(closedTrades, dailyLossLimit);
  checks.dailyLimit = cbDaily;
  if (cbDaily.triggered) errors.push(cbDaily.reason);

  // 4. Noticias
  const news = checkNewsFilter(calendarEvents);
  checks.news = news;
  if (news.blocked) errors.push(news.reason);

  // 5. SL razonable (no más del 5% del precio)
  const slPct = Math.abs(entry - stopLoss) / entry * 100;
  checks.slPct = slPct;
  if (slPct > 5) {
    warnings.push(`SL muy amplio: ${slPct.toFixed(2)}% del precio (recomendado <3%)`);
  }

  // 6. Equity mínimo
  if (equity < 50) {
    errors.push(`Equity insuficiente: $${equity.toFixed(2)} (mínimo $50)`);
  }

  return {
    ok: errors.length === 0,
    checks,
    warnings,
    errors,
  };
}

/* ═══════════════════════════════════════════════════════
   LEGACY / HELPERS (compatibilidad hacia atrás)
   ═══════════════════════════════════════════════════════ */

function calcPnL(trade, exit) {
  const lev = trade.leverage || 1;
  return trade.tipo === 'LONG'
    ? (exit - trade.entrada) * trade.size * lev
    : (trade.entrada - exit) * trade.size * lev;
}

function coinOf(par) { return (par || '').split('/')[0]; }

function nowFull() {
  return new Date().toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(6));
}

function calcSupportResistance(bars, period = 20) {
  const slice = bars.slice(-period);
  const lows = slice.map(b => b.l);
  const highs = slice.map(b => b.h);
  return {
    support: parseFloat(Math.min(...lows).toFixed(6)),
    resistance: parseFloat(Math.max(...highs).toFixed(6)),
  };
}

function calcMaxDrawdown(cumPnls) {
  let peak = -Infinity, maxDD = 0;
  for (const v of cumPnls) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  return parseFloat(maxDD.toFixed(2));
}

function buildTechSummary(coin, bars) {
  if (!bars || bars.length < 15) return `${coin}: datos insuficientes`;
  const closes = bars.map(b => b.c);
  const last = bars[bars.length - 1];
  const rsi = calcRSI(closes);
  const { support, resistance } = calcSupportResistance(bars, 20);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, Math.min(50, closes.length));
  const vol = last.v;
  const avgVol = bars.slice(-10).reduce((s, b) => s + b.v, 0) / 10;
  const volRatio = (vol / avgVol).toFixed(2);
  const trend = last.c > ema20 && ema20 > ema50 ? 'ALCISTA'
    : last.c < ema20 && ema20 < ema50 ? 'BAJISTA' : 'LATERAL';

  return (
    `${coin}/USDT: precio=$${last.c} | RSI14=${rsi} | trend=${trend} | ` +
    `ema20=$${ema20} ema50=$${ema50} | sup=$${support} res=$${resistance} | ` +
    `volRatio=${volRatio}x (${vol > avgVol ? 'alto' : 'normal'})`
  );
}

module.exports = {
  // Strategy core
  FEES,
  checkNYSession,
  validateVolumeFilter,
  calcCurrentEquity,
  calcRiskUSD,
  calcPositionSize,
  calcTargets,
  calcBreakevenPrice,
  calcNetPnL,
  calcPartialClose,
  checkCircuitBreakerConsec,
  checkDailyLossLimit,
  checkNewsFilter,
  validateTradeEntry,
  // Legacy / helpers
  calcPnL,
  coinOf,
  nowFull,
  calcRSI,
  calcEMA,
  calcSupportResistance,
  calcMaxDrawdown,
  buildTechSummary,
};