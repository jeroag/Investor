'use strict';

/**
 * Watchdog de salud del motor de trading.
 *
 *  1. PRECIOS CONGELADOS — si el WS de Binance deja de entregar precios
 *     (geo-bloqueo 451, caída de red…), el motor TP/SL queda ciego sin que
 *     nadie se entere. Si pasan >5 min sin precios, avisa por Telegram
 *     (cooldown de 30 min para no spamear).
 *
 *  2. RECONCILIACIÓN BITUNIX ↔ APP — cada 5 min compara las posiciones
 *     reales del exchange con los trades activos de la app. Si divergen
 *     (posición real sin vigilancia, o trade "fantasma" sin posición),
 *     avisa por Telegram.
 */

const { serverState } = require('../state');
const { bitunixRequest, isBitunixConfigured } = require('./bitunix');

const PRICE_STALL_MS = 5 * 60_000;
const WARN_COOLDOWN_MS = 30 * 60_000;

let lastPriceWarn = 0;
let lastReconWarn = 0;
let tick = 0;

async function checkPricesStall() {
  const last = serverState.lastPriceAt || 0;
  if (!last) return; // aún no ha llegado el primer precio tras el arranque
  const now = Date.now();
  if (now - last < PRICE_STALL_MS || now - lastPriceWarn < WARN_COOLDOWN_MS) return;
  lastPriceWarn = now;
  const mins = Math.round((now - last) / 60_000);
  const activos = serverState.activeTrades.length;
  console.warn(`[Watchdog] ⚠️ Sin precios desde hace ${mins} min`);
  const { sendTelegram } = require('./telegram');
  sendTelegram(
    `🚨 <b>WATCHDOG — SIN PRECIOS</b>\n\n` +
    `No llegan precios de Binance desde hace <b>${mins} min</b>.\n` +
    `El motor TP/SL está ciego${activos ? ` y hay <b>${activos}</b> trade(s) activo(s) SIN VIGILANCIA` : ''}.\n\n` +
    `Revisa los logs de Railway (¿error 451 / caída de red?).`
  ).catch(() => { });
}

async function reconcile() {
  if (!isBitunixConfigured()) return;
  const now = Date.now();
  if (now - lastReconWarn < WARN_COOLDOWN_MS) return;
  try {
    const data = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
    const positions = Array.isArray(data.data) ? data.data : [];
    const realSymbols = new Set(positions.map(p => p.symbol));
    // Solo trades que dicen tener posición real en Bitunix (paper trades excluidos)
    const appTrades = serverState.activeTrades.filter(t => t.bitunixSymbol || t.bitunixPos);
    const appSymbols = new Set(appTrades.map(t => t.bitunixSymbol || (t.par || '').replace('/', '')));
    const fantasmasApp = [...appSymbols].filter(s => !realSymbols.has(s)); // app cree que hay posición, Bitunix no
    const sinVigilar   = [...realSymbols].filter(s => !appSymbols.has(s)); // posición real que la app no vigila
    if (!fantasmasApp.length && !sinVigilar.length) return;
    lastReconWarn = now;
    console.warn(`[Watchdog] Reconciliación: fantasmas=${fantasmasApp.join(',') || '—'} | sin-vigilar=${sinVigilar.join(',') || '—'}`);
    const { sendTelegram } = require('./telegram');
    let msg = `⚠️ <b>RECONCILIACIÓN BITUNIX</b>\n`;
    if (sinVigilar.length)   msg += `\n📍 Posiciones reales SIN vigilancia de la app:\n<b>${sinVigilar.join(', ')}</b>\n`;
    if (fantasmasApp.length) msg += `\n👻 Trades de la app sin posición real en Bitunix:\n<b>${fantasmasApp.join(', ')}</b>\n`;
    msg += `\nRevisa la app y Bitunix — los estados han divergido.`;
    sendTelegram(msg).catch(() => { });
  } catch (e) {
    console.warn('[Watchdog] Reconciliación fallida:', e.message);
  }
}

let timer = null;
function startWatchdog() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick++;
    checkPricesStall().catch(() => { });
    if (tick % 5 === 0) reconcile().catch(() => { }); // cada 5 min
  }, 60_000);
  timer.unref();
  console.log('✓ Watchdog activo (precios: 1 min · reconciliación: 5 min)');
}

module.exports = { startWatchdog };
