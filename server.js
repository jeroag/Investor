const express  = require('express');
const path     = require('path');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Estado en memoria del servidor ────────────────────────────────────────
const serverState = {
  activeTrades:  [],
  closedTrades:  [],
  prices:        {},
};

// ── Rate Limiting ─────────────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT   = 20;
const RATE_WINDOW  = 60_000;

function rateLimit(req, res, next) {
  const ip    = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const now   = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return next();
  }
  if (entry.count >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Demasiadas peticiones. Espera un minuto.' });
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.start > RATE_WINDOW) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

// ── Binance WebSocket (servidor) ──────────────────────────────────────────
const COINS  = ['btcusdt','ethusdt','solusdt','xrpusdt','bnbusdt','dogeusdt'];
const WS_URL = 'wss://stream.binance.com:9443/stream?streams=' +
  COINS.map(s => s + '@miniTicker').join('/');

let binanceWs;

function connectBinanceWS() {
  binanceWs = new WebSocket(WS_URL);
  binanceWs.on('open',  () => console.log('Binance WS conectado en servidor'));
  binanceWs.on('message', (raw) => {
    try {
      const { data: d } = JSON.parse(raw);
      if (!d) return;
      const coin  = d.s.replace('USDT', '');
      const price = parseFloat(d.c);
      serverState.prices[coin] = price;
      checkTPSL(coin, price);
    } catch {}
  });
  binanceWs.on('close', () => { setTimeout(connectBinanceWS, 5000); });
  binanceWs.on('error', (err) => console.error('Binance WS error:', err.message));
}

// ── Lógica TP/SL en servidor ──────────────────────────────────────────────
function coinOf(par) { return (par || '').split('/')[0]; }
function nowFull() {
  return new Date().toLocaleString('es-ES', {
    day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
  });
}

function checkTPSL(coin, price) {
  serverState.activeTrades = serverState.activeTrades.filter(trade => {
    if (coinOf(trade.par) !== coin) return true;
    const hitSL = trade.tipo === 'LONG' ? price <= trade.stopLoss : price >= trade.stopLoss;
    const hitTP = trade.tipo === 'LONG'
      ? price >= (trade.tp2 || trade.tp1)
      : price <= (trade.tp2 || trade.tp1);
    if (hitSL || hitTP) {
      const result     = hitTP ? 'WIN' : 'LOSS';
      const lev        = trade.leverage || 1;
      const exitPrice  = hitTP ? (trade.tp2 || trade.tp1) : trade.stopLoss;
      const pnl        = trade.tipo === 'LONG'
        ? (exitPrice - trade.entrada) * trade.size * lev
        : (trade.entrada - exitPrice) * trade.size * lev;
      const closed = { ...trade, result, pnl, closedAt: nowFull(), closedByServer: true };
      serverState.closedTrades.unshift(closed);
      console.log(`${trade.par} cerrada: ${result} Lev:${lev}x PnL:${pnl.toFixed(2)}`);
      return false;
    }
    return true;
  });
}

// ── API Trades ────────────────────────────────────────────────────────────
function isValidTrade(t) {
  return (
    t && typeof t.id === 'string' &&
    typeof t.par      === 'string' &&
    (t.tipo === 'LONG' || t.tipo === 'SHORT') &&
    typeof t.stopLoss === 'number' && isFinite(t.stopLoss) &&
    typeof t.tp1      === 'number' && isFinite(t.tp1) &&
    typeof t.riskUSD  === 'number' && isFinite(t.riskUSD)
  );
}

app.post('/api/trades/sync', (req, res) => {
  const { activeTrades } = req.body;
  if (!Array.isArray(activeTrades)) return res.status(400).json({ error: 'activeTrades inválido' });

  // Rechazar trades con campos faltantes o inválidos
  const validTrades = activeTrades.filter(isValidTrade);
  const rejected    = activeTrades.length - validTrades.length;
  if (rejected > 0) console.warn(`sync: ${rejected} trade(s) rechazados por validación`);

  const existingIds = new Set(serverState.activeTrades.map(t => t.id));
  for (const trade of validTrades) {
    if (!existingIds.has(trade.id)) serverState.activeTrades.push(trade);
  }
  const frontendIds = new Set(validTrades.map(t => t.id));
  serverState.activeTrades = serverState.activeTrades.filter(t => frontendIds.has(t.id));
  res.json({ ok: true, watching: serverState.activeTrades.length, rejected });
});

app.get('/api/trades/closed-by-server', (req, res) => {
  // Solo lee — NO borra. El cliente confirma la recepción antes de que borremos.
  res.json({ closed: [...serverState.closedTrades] });
});

app.post('/api/trades/confirm-closed', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids inválido' });
  // Solo borramos los trades cuya recepción confirmó el cliente
  serverState.closedTrades = serverState.closedTrades.filter(t => !ids.includes(t.id));
  res.json({ ok: true, remaining: serverState.closedTrades.length });
});

app.get('/api/prices', (req, res) => {
  res.json(serverState.prices);
});

// ── Proxy Claude API ──────────────────────────────────────────────────────
app.post('/api/claude', rateLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada.' });
  const { model, max_tokens, system, messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages inválido.' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      model      || 'claude-sonnet-4-6',
        max_tokens: max_tokens || 1000,
        system,
        messages,
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'Error Anthropic.' });
    res.json(data);
  } catch (err) {
    console.error('Error proxy Claude:', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ── Fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CryptoPlan IA corriendo en puerto ${PORT}`);
  connectBinanceWS();
});