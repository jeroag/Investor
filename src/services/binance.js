'use strict';

/**
 * CryptoPlan IA — services/binance.js v1.1 (AUDITADO)
 *
 * CORRECCIONES [MEDIO]:
 *
 * 1. Reconexión con backoff exponencial:
 *    La versión original usaba un delay fijo de 5s. Si Binance sufre una
 *    interrupción prolongada (mantenimiento, incidente), el servidor enviaría
 *    una petición de reconexión cada 5 segundos indefinidamente, saturando
 *    el log y consumiendo recursos.
 *    SOLUCIÓN: backoff exponencial con jitter (2s → 4s → 8s → … → máx 60s).
 *    El contador se resetea tras una conexión estable de > 30 segundos.
 *
 * 2. Ping/pong keepalive hacia Binance WS:
 *    Binance puede cerrar conexiones silenciosas que no envían frames en > 24h.
 *    En Railway, si el contenedor tiene poco tráfico de noche, la conexión puede
 *    caer sin disparar el evento 'close'. Se añade un ping cada 20 minutos.
 *    Si no hay respuesta en 10 segundos, se fuerza la reconexión.
 */

const WebSocket = require('ws');
const { serverState } = require('../state');
const {
  calcRSI,
  calcEMA,
  calcSupportResistance,
  buildTechSummary,
} = require('./calculations');

/* ── Monedas vigiladas ───────────────────────────────────────────── */
const ALL_COINS = [
  'btcusdt', 'ethusdt', 'solusdt', 'xrpusdt', 'bnbusdt', 'dogeusdt',
  'avaxusdt', 'adausdt', 'maticusdt', 'dotusdt', 'linkusdt', 'ltcusdt',
  'uniusdt', 'atomusdt',
];

// XAU no está en Binance spot — precio obtenido de Bitunix REST cada 10s
// Se inyecta en serverState.prices['XAU'] igual que el resto de monedas
const XAU_POLL_MS = 10_000;
let xauPollTimer = null;

async function _pollXAUPrice(onPriceCbs) {
  try {
    const res = await fetch(
      'https://api.bitunix.com/api/v1/futures/market/tickers?symbol=XAUUSDT',
      { signal: AbortSignal.timeout(5_000) }
    );
    const data = await res.json();
    const ticker = Array.isArray(data?.data) ? data.data[0] : data?.data;
    const price = ticker ? parseFloat(ticker.lastPrice || ticker.last || ticker.close || 0) : 0;
    if (price > 0) {
      serverState.prices['XAU'] = price;
      onPriceCbs.forEach(fn => fn('XAU', price));
    }
  } catch (e) {
    // silencioso — no interrumpe el flujo principal
  }
  xauPollTimer = setTimeout(() => _pollXAUPrice(onPriceCbs), XAU_POLL_MS);
}

function startXAUPolling(onPriceCbs) {
  if (xauPollTimer) return; // ya arrancado
  _pollXAUPrice(onPriceCbs);
}

const WS_URL = 'wss://stream.binance.com:9443/stream?streams=' +
  ALL_COINS.map(s => s + '@miniTicker').join('/');

/* ── Callbacks registrados por otros módulos ─────────────────────── */
const onPriceCallbacks = [];
function onPrice(fn) { onPriceCallbacks.push(fn); }

/* ── Estado de reconexión ────────────────────────────────────────── */
let binanceWs = null;
let reconnectAttempt = 0;
let connectTimestamp = 0;
let pingTimer = null;
let pingTimeout = null;

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const STABLE_CONN_MS = 30_000;  // conexión "estable" si dura > 30s
const PING_INTERVAL_MS = 20 * 60_000;  // ping cada 20 minutos
const PING_TIMEOUT_MS = 10_000;       // espera pong máx 10s

/* ── WebSocket principal ─────────────────────────────────────────── */

function connectBinanceWS() {
  // Limpiar timers anteriores si los hay
  _clearTimers();

  binanceWs = new WebSocket(WS_URL);

  binanceWs.on('open', () => {
    connectTimestamp = Date.now();
    console.log(`✓ Binance WS conectado: ${ALL_COINS.length} monedas (intento #${reconnectAttempt + 1})`);
    reconnectAttempt = 0; // reset backoff en cuanto conecta

    // Iniciar keepalive ping/pong
    _schedulePing();
  });

  binanceWs.on('message', (raw) => {
    try {
      const { data: d } = JSON.parse(raw);
      if (!d) return;
      const coin = d.s.replace('USDT', '');
      const price = parseFloat(d.c);
      serverState.prices[coin] = price;
      for (const fn of onPriceCallbacks) fn(coin, price);
    } catch { /* ignorar mensajes malformados */ }
  });

  // Binance envía pong frames nativos — confirmar recepción y cancelar timeout
  binanceWs.on('pong', () => {
    if (pingTimeout) { clearTimeout(pingTimeout); pingTimeout = null; }
    console.debug('[Binance WS] Pong recibido ✓');
  });

  binanceWs.on('close', (code, reason) => {
    _clearTimers();
    const stableConn = connectTimestamp && (Date.now() - connectTimestamp) > STABLE_CONN_MS;
    if (stableConn) reconnectAttempt = 0; // reset si conexión fue estable
    const delay = _backoffDelay();
    console.warn(`[Binance WS] Desconectado (${code} ${reason || ''}), reconectando en ${delay / 1000}s… (intento ${reconnectAttempt})`);
    setTimeout(connectBinanceWS, delay);
  });

  binanceWs.on('error', (e) => {
    // 'error' siempre va seguido de 'close' en ws — solo logeamos
    console.error('[Binance WS] Error:', e.message);
  });
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function _backoffDelay() {
  reconnectAttempt++;
  // Exponencial: 2s, 4s, 8s, 16s, 32s, 60s (cap)
  const exp = Math.min(reconnectAttempt - 1, 5);
  const base = RECONNECT_BASE_MS * Math.pow(2, exp);
  // Jitter ±20% para evitar thundering herd si hay múltiples instancias
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.min(base + jitter, RECONNECT_MAX_MS);
}

function _schedulePing() {
  pingTimer = setTimeout(() => {
    if (!binanceWs || binanceWs.readyState !== WebSocket.OPEN) return;

    // Enviar ping frame nativo WebSocket
    binanceWs.ping();
    console.debug('[Binance WS] Ping enviado…');

    // Si no llega pong en 10s, forzar reconexión
    pingTimeout = setTimeout(() => {
      console.warn('[Binance WS] Sin pong — forzando reconexión');
      binanceWs.terminate(); // dispara el evento 'close' → reconexión con backoff
    }, PING_TIMEOUT_MS);

    // Programar el siguiente ping si todo va bien
    pingTimer = null;
    // El siguiente ping se programa dentro del handler 'pong' no desde aquí
    // para no acumular timers. Re-programamos aquí solo por si el pong llega:
    binanceWs.once('pong', () => _schedulePing());
  }, PING_INTERVAL_MS);

  if (pingTimer && pingTimer.unref) pingTimer.unref();
}

function _clearTimers() {
  if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
  if (pingTimeout) { clearTimeout(pingTimeout); pingTimeout = null; }
}

/* ── OHLCV REST (Klines) — para el escáner ──────────────────────── */

async function fetchOHLCV(coins, interval = '1h', limit = 50) {
  const results = {};
  const fetches = coins.map(async (coin) => {
    const isXAU = coin.toUpperCase() === 'XAU';
    const symbol = coin.toUpperCase() + 'USDT';
    // XAU no existe en Binance spot — usar Binance Futures (fapi)
    const url = isXAU
      ? `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      : `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
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
  startXAUPolling,
  onPrice,
  onPriceCallbacks: onPriceCallbacks, // expuesto para XAU polling
  fetchOHLCV,
  // Re-export para compatibilidad
  calcRSI,
  calcEMA,
  calcSupportResistance,
  buildTechSummary,
};