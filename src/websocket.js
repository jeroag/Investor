'use strict';

const WebSocket    = require('ws');
const { sessions } = require('./middleware/auth');
const { config }   = require('./config');
const { serverState } = require('./state');

const wss           = new WebSocket.Server({ noServer: true });
const clientSockets = new Set();

/* ── Throttle de precios (máx 1 update por moneda cada 2s) ────────── */
const priceThrottle = new Map();

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
  clientSockets.add(ws);

  // Snapshot de precios al conectarse
  if (Object.keys(serverState.prices).length) {
    ws.send(JSON.stringify({ type: 'PRICES_SNAPSHOT', prices: serverState.prices }));
  }

  ws.on('close', () => clientSockets.delete(ws));
  ws.on('error', () => clientSockets.delete(ws));
});

/**
 * Handler para el evento 'upgrade' del servidor HTTP.
 * Autenticación via cookie o query param ?token=
 */
function handleUpgrade(req, socket, head) {
  if (!req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }

  // Leer token de cookie o query
  let token;
  const cookieMatch = (req.headers['cookie'] || '').match(/cp_token=([^;]+)/);
  if (cookieMatch) {
    token = cookieMatch[1];
  } else {
    try {
      token = new URL('http://x' + req.url).searchParams.get('token') || null;
    } catch { token = null; }
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
