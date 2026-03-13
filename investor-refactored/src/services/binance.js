'use strict';

const WebSocket       = require('ws');
const { serverState } = require('../state');
const {
  calcRSI,
  calcEMA,
  calcSupportResistance,
  buildTechSummary,
} = require('./calculations');

/* ── Monedas vigiladas ───────────────────────────────────────────── */
const ALL_COINS = [
  'btcusdt','ethusdt','solusdt','xrpusdt','bnbusdt','dogeusdt',
  'avaxusdt','adausdt','maticusdt','dotusdt','linkusdt','ltcusdt',
  'uniusdt','atomusdt',
];

const WS_URL = 'wss://stream.binance.com:9443/stream?streams=' +
  ALL_COINS.map(s => s + '@miniTicker').join('/');

/* ── Callbacks registrados por otros módulos ─────────────────────── */
const onPriceCallbacks = [];
function onPrice(fn) { onPriceCallbacks.push(fn); }

/* ── WebSocket principal ─────────────────────────────────────────── */
let binanceWs;

function connectBinanceWS() {
  binanceWs = new WebSocket(WS_URL);

  binanceWs.on('open', () =>
    console.log(`✓ Binance WS conectado: ${ALL_COINS.length} monedas`));

  binanceWs.on('message', (raw) => {
    try {
      const { data: d } = JSON.parse(raw);
      if (!d) return;
      const coin  = d.s.replace('USDT', '');
      const price = parseFloat(d.c);
      serverState.prices[coin] = price;
      for (const fn of onPriceCallbacks) fn(coin, price);
    } catch { /* descartado */ }
  });

  binanceWs.on('close', () => {
    console.warn('[Binance WS] Desconectado, reconectando en 5s…');
    setTimeout(connectBinanceWS, 5_000);
  });

  binanceWs.on('error', (e) =>
    console.error('[Binance WS] Error:', e.message));
}

/* ── OHLCV REST (Klines) — para el escáner ──────────────────────── */
/**
 * Descarga velas OHLCV desde Binance REST.
 * @param {string[]} coins
 * @param {string}   interval  '15m' | '1h' | '4h' | '1d'
 * @param {number}   limit
 * @returns {Promise<Record<string, {t,o,h,l,c,v}[]>>}
 */
async function fetchOHLCV(coins, interval = '1h', limit = 50) {
  const results = {};
  const fetches = coins.map(async (coin) => {
    const symbol = coin.toUpperCase() + 'USDT';
    const url    = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const data = await res.json();
      if (!Array.isArray(data)) return;
      results[coin] = data.map(k => ({
        t: k[0],
        o: parseFloat(k[1]),
        h: parseFloat(k[2]),
        l: parseFloat(k[3]),
        c: parseFloat(k[4]),
        v: parseFloat(k[5]),
      }));
    } catch (e) {
      console.warn(`[OHLCV] ${coin}: ${e.message}`);
    }
  });
  await Promise.all(fetches);
  return results;
}

module.exports = {
  ALL_COINS,
  connectBinanceWS,
  onPrice,
  fetchOHLCV,
  // Re-export para compatibilidad con código que importe desde binance.js
  calcRSI,
  calcEMA,
  calcSupportResistance,
  buildTechSummary,
};
