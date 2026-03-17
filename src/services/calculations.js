'use strict';

/**
 * CryptoPlan IA — calculations.js v3
 * Toda la matemática pura de la estrategia institucional.
 * Sin dependencias externas — importable en servidor y tests.
 */

/* ── Comisiones Bitunix ─────────────────────────────────────────── */
const FEES = {
  TAKER: 0.0006,
  MAKER: 0.0002,
  ROUND_TRIP: 0.0008,  // taker apertura + maker cierre
};

/* ═══════════════════════════════════════════════════════
   POSITION SIZING — 1% DINÁMICO
   ═══════════════════════════════════════════════════════ */

function calcCurrentEquity(capital, closedPnl = 0, activePnl = 0) {
  return capital + closedPnl + activePnl;
}

function calcRiskUSD(equity, riskPct = 1) {
  return equity * riskPct / 100;
}

/**
 * qty = riskUSD / |entrada - stopLoss|
 * El apalancamiento NO afecta qty, solo reduce el margen.
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
   TARGETS — TP1 (1.2:1), TP2 (2.5:1), BREAKEVEN
   ═══════════════════════════════════════════════════════ */

function calcTargets(entry, stopLoss, tipo, tp1Ratio = 1.2, tp2Ratio = 2.5) {
  const slDist = Math.abs(entry - stopLoss);
  const dir = tipo === 'LONG' ? 1 : -1;
  const tp1 = parseFloat((entry + dir * slDist * tp1Ratio).toFixed(6));
  const tp2 = parseFloat((entry + dir * slDist * tp2Ratio).toFixed(6));
  return { tp1, tp2, slDist, tp1Ratio, tp2Ratio };
}

/**
 * Breakeven real con fees incluidas.
 * LONG:  BE = entrada × (1 + 0.0008)
 * SHORT: BE = entrada × (1 - 0.0008)
 */
function calcBreakevenPrice(entry, tipo) {
  const buf = FEES.ROUND_TRIP;
  return tipo === 'LONG'
    ? parseFloat((entry * (1 + buf)).toFixed(6))
    : parseFloat((entry * (1 - buf)).toFixed(6));
}

/**
 * P&L neto descontando comisiones.
 * Apertura siempre taker; cierre maker (TP) o taker (SL de mercado).
 */
function calcNetPnL(trade, exitPrice, exitFeeType = 'maker') {
  const lev = trade.leverage || 1;
  const gross = trade.tipo === 'LONG'
    ? (exitPrice - trade.entrada) * trade.size * lev
    : (trade.entrada - exitPrice) * trade.size * lev;
  const feeOpen = trade.entrada * trade.size * FEES.TAKER;
  const feeClose = exitPrice * trade.size * (exitFeeType === 'taker' ? FEES.TAKER : FEES.MAKER);
  const fees = feeOpen + feeClose;
  return {
    gross: parseFloat(gross.toFixed(4)),
    fees: parseFloat(fees.toFixed(4)),
    net: parseFloat((gross - fees).toFixed(4)),
  };
}

/* ═══════════════════════════════════════════════════════
   SESIÓN NY — 13:30–18:00 UTC (14:30–19:00 CET)
   ═══════════════════════════════════════════════════════ */

function checkNYSession(now = new Date()) {
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (day === 0 || day === 6)
    return { inSession: false, reason: 'Fin de semana — mercado institucional inactivo' };

  if (day === 5 && mins >= 17 * 60 + 30)
    return { inSession: false, reason: 'Viernes tarde — liquidez reducida' };

  const start = 13 * 60 + 30;
  const end = 18 * 60;

  if (mins >= start && mins < end) {
    return { inSession: true, reason: `Sesión NY activa — ${end - mins}min restantes`, minutesLeft: end - mins };
  }
  if (mins < start) {
    return { inSession: false, reason: `Sesión NY abre en ${start - mins}min (14:30 CET)` };
  }
  return { inSession: false, reason: 'Sesión NY cerrada (19:00 CET)' };
}

/* ═══════════════════════════════════════════════════════
   FILTRO DE VOLUMEN (fuera de sesión)
   ═══════════════════════════════════════════════════════ */

function validateVolumeFilter(currentVol, recentVols, multiplier = 1.5) {
  if (!recentVols || recentVols.length < 5)
    return { ok: false, ratio: 0, reason: 'Datos de volumen insuficientes' };
  const avg = recentVols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(recentVols.length, 20);
  const ratio = avg > 0 ? currentVol / avg : 0;
  const ok = ratio >= multiplier;
  return {
    ok, ratio: parseFloat(ratio.toFixed(2)),
    reason: ok
      ? `Volumen válido: ${ratio.toFixed(2)}× avg20`
      : `Volumen insuficiente: ${ratio.toFixed(2)}× avg20 (mín ${multiplier}×)`,
  };
}

/* ═══════════════════════════════════════════════════════
   CIRCUIT BREAKER — PÉRDIDAS CONSECUTIVAS
   ═══════════════════════════════════════════════════════ */

function checkCircuitBreakerConsec(closedTrades, maxConsec = 2) {
  if (!closedTrades || !closedTrades.length)
    return { triggered: false, consecutiveLosses: 0, reason: 'Sin historial' };
  let count = 0;
  for (const t of closedTrades) {
    if (t.result === 'LOSS') count++;
    else break;
  }
  const triggered = count >= maxConsec;
  return {
    triggered,
    consecutiveLosses: count,
    reason: triggered
      ? `⛔ Circuit Breaker: ${count} pérdidas consecutivas — stop operativo`
      : count > 0 ? `⚠️ ${count} pérdida(s) consecutiva(s) — máx ${maxConsec}` : null,
  };
}

/* ═══════════════════════════════════════════════════════
   FILTRO DE NOTICIAS
   ═══════════════════════════════════════════════════════ */

function checkNewsFilter(calendarEvents, now = new Date()) {
  if (!calendarEvents || !calendarEvents.length)
    return { blocked: false, reason: null };

  const nowMs = now.getTime();
  const beforeMs = 15 * 60 * 1000;
  const afterMs = 30 * 60 * 1000;

  for (const evt of calendarEvents) {
    if (evt.impact !== 'High') continue;
    if (!['USD', 'BTC'].includes(evt.currency)) continue;
    let evtMs;
    try { evtMs = new Date(evt.date).getTime(); } catch { continue; }
    if (isNaN(evtMs)) continue;
    const diff = nowMs - evtMs;
    if (diff >= -beforeMs && diff <= afterMs) {
      const mins = Math.round(Math.abs(diff) / 60000);
      return {
        blocked: true, event: evt,
        reason: diff < 0
          ? `⚠️ Noticias en ${mins}min: ${evt.currency} ${evt.title} — bloqueado`
          : `⚠️ Post-evento ${mins}min: ${evt.currency} ${evt.title}`,
      };
    }
  }
  return { blocked: false, reason: null };
}

/* ═══════════════════════════════════════════════════════
   VALIDACIÓN COMPLETA DE ENTRADA
   ═══════════════════════════════════════════════════════ */

function validateTradeEntry(params) {
  const {
    equity, entry, stopLoss, tipo,
    closedTrades = [], calendarEvents = [],
    dailyLossLimit = 0, currentVol = 0, recentVols = [],
    requireNYSession = true,
  } = params;

  const errors = [], warnings = [], checks = {};

  // 1. Sesión NY
  const session = checkNYSession();
  checks.session = session;
  if (!session.inSession && requireNYSession) {
    const vol = validateVolumeFilter(currentVol, recentVols);
    checks.volume = vol;
    if (!vol.ok) errors.push(`${session.reason} — ${vol.reason}`);
    else warnings.push(`Fuera de sesión — volume override: ${vol.ratio}×`);
  }

  // 2. Circuit breaker consecutivo
  const cb = checkCircuitBreakerConsec(closedTrades, 2);
  checks.circuitBreaker = cb;
  if (cb.triggered) errors.push(cb.reason);
  else if (cb.reason) warnings.push(cb.reason);

  // 3. Límite diario
  if (dailyLossLimit > 0) {
    const now = Date.now();
    const today = closedTrades.filter(t => (now - new Date(t.closedAt || 0).getTime()) < 86_400_000);
    const dpnl = today.reduce((a, t) => a + (t.pnl || 0), 0);
    checks.dailyLimit = { pnl: parseFloat(dpnl.toFixed(2)), limit: dailyLossLimit };
    if (dpnl <= -Math.abs(dailyLossLimit))
      errors.push(`⛔ Límite diario: P&L hoy $${dpnl.toFixed(2)} ≤ -$${dailyLossLimit}`);
  }

  // 4. Noticias
  const news = checkNewsFilter(calendarEvents);
  checks.news = news;
  if (news.blocked) errors.push(news.reason);

  // 5. SL razonable
  const slPct = Math.abs(entry - stopLoss) / entry * 100;
  checks.slPct = slPct;
  if (slPct > 5) warnings.push(`SL amplio: ${slPct.toFixed(2)}% del precio`);

  return { ok: errors.length === 0, checks, errors, warnings };
}

/* ═══════════════════════════════════════════════════════
   LEGACY / COMPATIBILIDAD
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
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
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
  return {
    support: parseFloat(Math.min(...slice.map(b => b.l)).toFixed(6)),
    resistance: parseFloat(Math.max(...slice.map(b => b.h)).toFixed(6)),
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
  const avgVol = bars.slice(-10).reduce((s, b) => s + b.v, 0) / 10;
  const volRatio = (last.v / avgVol).toFixed(2);
  const trend = last.c > ema20 && ema20 > ema50 ? 'ALCISTA'
    : last.c < ema20 && ema20 < ema50 ? 'BAJISTA' : 'LATERAL';
  return (
    `${coin}/USDT: precio=$${last.c} | RSI14=${rsi} | trend=${trend} | ` +
    `ema20=$${ema20} ema50=$${ema50} | sup=$${support} res=$${resistance} | ` +
    `volRatio=${volRatio}x`
  );
}

module.exports = {
  FEES,
  calcCurrentEquity, calcRiskUSD, calcPositionSize,
  calcTargets, calcBreakevenPrice, calcNetPnL,
  checkNYSession, validateVolumeFilter,
  checkCircuitBreakerConsec, checkNewsFilter,
  validateTradeEntry,
  calcPnL, coinOf, nowFull,
  calcRSI, calcEMA, calcSupportResistance,
  calcMaxDrawdown, buildTechSummary,
};