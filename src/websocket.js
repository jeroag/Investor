'use strict';

/**
 * CryptoPlan IA — websocket.js v1.1 (AUDITADO)
 *
 * CORRECCIÓN [MEDIO] — Conexiones de cliente muertas acumuladas en Set:
 *   La versión original añadía cada cliente conectado a `clientSockets` y lo
 *   eliminaba en los eventos 'close' y 'error'. Sin embargo, si un cliente
 *   se desconecta de forma silenciosa (pérdida de red, dispositivo suspendido,
 *   Railway restartando un proxy), el evento 'close' puede no dispararse.
 *   Con el tiempo, `clientSockets` acumula sockets muertos en estado CLOSING,
 *   causando errores silenciosos en cada broadcast y un memory leak.
 *
 *   SOLUCIÓN: heartbeat activo cada 30 segundos.
 *   - El servidor envía un ping a cada cliente.
 *   - Los clientes que no respondan en el siguiente ciclo se terminan y eliminan.
 *   - Compatible con navegadores (ws library maneja ping/pong automáticamente
 *     a nivel de framing, el navegador no necesita código extra).
 *
 * CORRECCIÓN [MEDIO] — Token de sesión en query param de URL del WS:
 *   El modo alternativo de auth por ?token= expone el token en URLs que
 *   pueden quedar en logs de Railway, Cloudflare, o cualquier proxy intermedio.
 *   Se añade un warning al usarlo para que el operador sea consciente.
 */

const WebSocket = require('ws');
const { sessions } = require('./middleware/auth');
const { config } = require('./config');
const { serverState } = require('./state');

const wss = new WebSocket.Server({ noServer: true });
const clientSockets = new Set();

/* ── Heartbeat (ping/pong activo) ────────────────────────────────── */
// Cada cliente tiene un flag `isAlive`. El intervalo envía pings y marca
// como muertos a quienes no hayan respondido al ciclo anterior.
const HEARTBEAT_INTERVAL_MS = 30_000;

function heartbeat() {
  this.isAlive = true; // `this` = el socket que recibió el pong
}

const heartbeatTimer = setInterval(() => {
  for (const ws of clientSockets) {
    if (ws.isAlive === false) {
      // No respondió al último ping — eliminar silenciosamente
      clientSockets.delete(ws);
      ws.terminate();
      continue;
    }
    // Marcar como "pendiente de pong" y enviar ping
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

// No bloquear shutdown de Railway
heartbeatTimer.unref();

/* ── Throttle de precios (máx 1 update por moneda cada 2s) ────────── */
const priceThrottle = new Map();
const THROTTLE_CLEANUP = 5 * 60_000; // limpiar entradas antiguas cada 5 min

setInterval(() => {
  const cutoff = Date.now() - 10_000;
  for (const [coin, ts] of priceThrottle) {
    if (ts < cutoff) priceThrottle.delete(coin);
  }
}, THROTTLE_CLEANUP).unref();

function broadcastPrice(coin, price) {
  const now = Date.now();
  if ((now - (priceThrottle.get(coin) || 0)) < 2000) return;
  priceThrottle.set(coin, now);
  broadcast({ type: 'PRICE_UPDATE', coin, price });
}

function broadcast(event) {
  const msg = JSON.stringify(event);
  for (const client of clientSockets) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch { /* cliente cerrado */ }
    }
  }
}

wss.on('connection', (ws) => {
  // Inicializar heartbeat para este cliente
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  clientSockets.add(ws);

  // Snapshot de precios al conectarse
  if (Object.keys(serverState.prices).length) {
    ws.send(JSON.stringify({ type: 'PRICES_SNAPSHOT', prices: serverState.prices }));
  }

  ws.on('close', () => clientSockets.delete(ws));
  ws.on('error', () => { clientSockets.delete(ws); ws.terminate(); });
});

/**
 * Handler para el evento 'upgrade' del servidor HTTP.
 * Autenticación via cookie o query param ?token=
 *
 * NOTA DE SEGURIDAD: el modo ?token= es inseguro en producción porque la URL
 * queda en los logs de Railway y de cualquier proxy/CDN. Usar siempre la cookie.
 */
function handleUpgrade(req, socket, head) {
  if (!req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }

  let token;
  const cookieMatch = (req.headers['cookie'] || '').match(/cp_token=([^;]+)/);
  if (cookieMatch) {
    token = cookieMatch[1];
  } else {
    // Modo fallback por query param — solo para clientes que no soporten cookies
    try {
      token = new URL('http://x' + req.url).searchParams.get('token') || null;
    } catch { token = null; }
    if (token) {
      console.warn('[WS] Token de sesión recibido por URL query param — esto queda en logs. Usar cookie en su lugar.');
    }
  }

  const session = token ? sessions.get(token) : null;
  if (!session || Date.now() - session.createdAt > config.sessionTtlMs) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}

module.exports = { wss, broadcast, broadcastPrice, handleUpgrade };