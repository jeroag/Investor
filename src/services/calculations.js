'use strict';

/**
 * Funciones de cálculo puras — sin dependencias externas.
 * Importadas tanto por los servicios del servidor como por los tests.
 */

/* ── PnL ─────────────────────────────────────────────────────────── */

/**
 * Calcula el PnL de un trade cerrado.
 * @param {{ tipo: 'LONG'|'SHORT', entrada: number, size: number, leverage?: number }} trade
 * @param {number} exit   Precio de salida
 * @returns {number}      PnL en USD
 */
function calcPnL(trade, exit) {
  const lev = trade.leverage || 1;
  if (trade.tipo === 'LONG') {
    return (exit - trade.entrada) * trade.size * lev;
  }
  return (trade.entrada - exit) * trade.size * lev;
}

/* ── Trade helpers ──────────────────────────────────────────────── */

function coinOf(par) { return (par || '').split('/')[0]; }

function nowFull() {
  return new Date().toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/* ── RSI ─────────────────────────────────────────────────────────── */

/**
 * Calcula RSI simple (período configurable).
 * @param {number[]} closes  Array de precios de cierre
 * @param {number}   period  Período (default 14)
 * @returns {number}
 */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

/* ── EMA ─────────────────────────────────────────────────────────── */

/**
 * Calcula EMA (Media Móvil Exponencial).
 * @param {number[]} closes
 * @param {number}   period
 * @returns {number}
 */
function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const k   = 2 / (period + 1);
  let   ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(6));
}

/* ── Soporte / Resistencia ──────────────────────────────────────── */

/**
 * @param {{ h: number, l: number }[]} bars
 * @param {number} period
 * @returns {{ support: number, resistance: number }}
 */
function calcSupportResistance(bars, period = 20) {
  const slice = bars.slice(-period);
  const lows  = slice.map(b => b.l);
  const highs = slice.map(b => b.h);
  return {
    support:    parseFloat(Math.min(...lows).toFixed(6)),
    resistance: parseFloat(Math.max(...highs).toFixed(6)),
  };
}

/* ── Max Drawdown ───────────────────────────────────────────────── */

/**
 * @param {number[]} cumPnls   Array de PnL acumulado (ordenado cronológicamente)
 * @returns {number}           Drawdown máximo (positivo)
 */
function calcMaxDrawdown(cumPnls) {
  let peak = -Infinity, maxDD = 0;
  for (const v of cumPnls) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  return parseFloat(maxDD.toFixed(2));
}

/* ── Resumen técnico de una moneda (para el escáner) ───────────── */

/**
 * Genera string de contexto técnico para el prompt de Claude.
 * @param {string} coin
 * @param {{ t,o,h,l,c,v }[]} bars
 * @returns {string}
 */
function buildTechSummary(coin, bars) {
  if (!bars || bars.length < 15) return `${coin}: datos insuficientes`;
  const closes = bars.map(b => b.c);
  const last   = bars[bars.length - 1];
  const rsi    = calcRSI(closes);
  const { support, resistance } = calcSupportResistance(bars, 20);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, Math.min(50, closes.length));
  const vol    = last.v;
  const avgVol = bars.slice(-10).reduce((s, b) => s + b.v, 0) / 10;
  const volRatio = (vol / avgVol).toFixed(2);

  const trend = last.c > ema20 && ema20 > ema50 ? 'ALCISTA'
              : last.c < ema20 && ema20 < ema50 ? 'BAJISTA'
              : 'LATERAL';

  return (
    `${coin}/USDT: precio=$${last.c} | RSI14=${rsi} | trend=${trend} | ` +
    `ema20=$${ema20} ema50=$${ema50} | sup=$${support} res=$${resistance} | ` +
    `volRatio=${volRatio}x (${vol > avgVol ? 'alto' : 'normal'})`
  );
}

module.exports = {
  calcPnL,
  coinOf,
  nowFull,
  calcRSI,
  calcEMA,
  calcSupportResistance,
  calcMaxDrawdown,
  buildTechSummary,
};
