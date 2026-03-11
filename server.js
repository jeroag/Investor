const express   = require('express');
const path      = require('path');
const WebSocket = require('ws');
const crypto    = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* ══════════════════════════════════════════════════════════
   AUTENTICACIÓN
   - Contraseña guardada en variable de entorno APP_PASSWORD
   - Sesiones en memoria (token aleatorio de 64 bytes)
   - Todas las rutas /api/* y el HTML principal requieren sesión
   ══════════════════════════════════════════════════════════ */

const sessions = new Map(); // token → { createdAt, ip }
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 horas

// Limpiar sesiones expiradas cada hora
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(token);
  }
}, 60 * 60 * 1000);

function generateToken() {
  return crypto.randomBytes(64).toString('hex');
}

function getToken(req) {
  // Acepta token en header Authorization: Bearer <token>  o en cookie cp_token
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers['cookie'] || '';
  const match  = cookie.match(/cp_token=([^;]+)/);
  return match ? match[1] : null;
}

function isAuthenticated(req) {
  const token = getToken(req);
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Middleware de autenticación para todas las rutas /api/*
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
}

// ── Login endpoint (público) ───────────────────────────────
app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  const correctPassword = process.env.APP_PASSWORD;

  if (!correctPassword) {
    // Si no hay contraseña configurada, advertir en consola pero permitir acceso
    console.warn('⚠️  APP_PASSWORD no configurada. Configúrala en las variables de entorno.');
    const token = generateToken();
    sessions.set(token, { createdAt: Date.now() });
    return res.json({ ok: true, token });
  }

  if (!password || password !== correctPassword) {
    // Delay de 1s para dificultar fuerza bruta
    return setTimeout(() => {
      res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' });
    }, 1000);
  }

  const token = generateToken();
  const ip    = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  sessions.set(token, { createdAt: Date.now(), ip });
  console.log(`✓ Login exitoso desde ${ip}`);

  // Configurar cookie segura (httpOnly) + devolver token para localStorage
  res.setHeader('Set-Cookie', `cp_token=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL/1000}; Path=/`);
  res.json({ ok: true, token });
});

// ── Logout endpoint ────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'cp_token=; HttpOnly; Max-Age=0; Path=/');
  res.json({ ok: true });
});

// ── Check session ──────────────────────────────────────────
app.get('/auth/check', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

// Servir login.html sin autenticación
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── Archivos estáticos: públicos (JS/CSS no contienen datos sensibles) ───────
// Los datos sensibles solo están en /api/* que SÍ está protegido
app.use(express.static(path.join(__dirname, 'public'), {
  // No servir index.html automáticamente — lo controlamos nosotros
  index: false,
}));

// Proteger el HTML principal — redirige a login si no hay sesión
app.get('/', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ══════════════════════════════════════════════════════════
   ESTADO EN MEMORIA
   ══════════════════════════════════════════════════════════ */
const serverState = {
  activeTrades:  [],
  closedTrades:  [],
  prices:        {},
};

/* ══════════════════════════════════════════════════════════
   RATE LIMITING
   ══════════════════════════════════════════════════════════ */
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
  for (const [ip, e] of rateLimitMap) {
    if (now - e.start > RATE_WINDOW) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

/* ══════════════════════════════════════════════════════════
   BINANCE WEBSOCKET (precios en servidor para TP/SL)
   ══════════════════════════════════════════════════════════ */
const COINS  = ['btcusdt','ethusdt','solusdt','xrpusdt','bnbusdt','dogeusdt'];
const WS_URL = 'wss://stream.binance.com:9443/stream?streams=' +
  COINS.map(s => s + '@miniTicker').join('/');
let binanceWs;

function connectBinanceWS() {
  binanceWs = new WebSocket(WS_URL);
  binanceWs.on('open',  () => console.log('Binance WS conectado'));
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
  binanceWs.on('close', () => setTimeout(connectBinanceWS, 5000));
  binanceWs.on('error', (e) => console.error('Binance WS error:', e.message));
}

/* ══════════════════════════════════════════════════════════
   TP/SL LOGIC
   ══════════════════════════════════════════════════════════ */
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
      const lev       = trade.leverage || 1;
      const exitPrice = hitTP ? (trade.tp2 || trade.tp1) : trade.stopLoss;
      const pnl       = trade.tipo === 'LONG'
        ? (exitPrice - trade.entrada) * trade.size * lev
        : (trade.entrada - exitPrice) * trade.size * lev;
      serverState.closedTrades.unshift({
        ...trade, result: hitTP ? 'WIN' : 'LOSS', pnl,
        closedAt: nowFull(), closedByServer: true,
      });
      console.log(`${trade.par} cerrada TP/SL: PnL ${pnl.toFixed(2)}`);
      return false;
    }
    return true;
  });
}

/* ══════════════════════════════════════════════════════════
   BITUNIX API INTEGRATION
   ══════════════════════════════════════════════════════════ */
const BITUNIX_BASE = 'https://fapi.bitunix.com';

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function generateNonce() {
  return crypto.randomBytes(16).toString('hex'); // 32 chars
}

/**
 * Firma una request Bitunix según su spec:
 * digest = SHA256(nonce + timestamp + apiKey + queryParams + body)
 * sign   = SHA256(digest + secretKey)
 *
 * queryParams: objeto de query params → ordenado por ASCII key, concatenado "k1v1k2v2"
 * body: string JSON sin espacios (o "" si no hay body)
 */
function bitunixSign(apiKey, secretKey, nonce, timestamp, queryParamsObj, bodyStr) {
  // 1. Ordenar query params por clave ASCII ascendente y concatenar
  const qp = Object.keys(queryParamsObj || {})
    .sort()
    .map(k => k + queryParamsObj[k])
    .join('');

  // 2. Asegurarse que el body no tiene espacios
  const body = bodyStr ? bodyStr.replace(/\s+/g, '') : '';

  // 3. Doble SHA256
  const digest = sha256(nonce + timestamp + apiKey + qp + body);
  const sign   = sha256(digest + secretKey);
  return sign;
}

/**
 * Llamada autenticada a Bitunix
 */
async function bitunixRequest(method, endpoint, queryParams = {}, bodyObj = null) {
  const apiKey    = process.env.BITUNIX_API_KEY;
  const secretKey = process.env.BITUNIX_SECRET;

  if (!apiKey || !secretKey) {
    throw new Error('BITUNIX_API_KEY o BITUNIX_SECRET no configurados en las variables de entorno.');
  }

  const nonce     = generateNonce();
  const timestamp = Date.now().toString();
  const bodyStr   = bodyObj ? JSON.stringify(bodyObj) : '';
  const sign      = bitunixSign(apiKey, secretKey, nonce, timestamp, queryParams, bodyStr);

  // Construir URL con query string
  const qs = Object.keys(queryParams).length
    ? '?' + Object.keys(queryParams).sort().map(k => `${k}=${encodeURIComponent(queryParams[k])}`).join('&')
    : '';

  const url = BITUNIX_BASE + endpoint + qs;

  const headers = {
    'Content-Type': 'application/json',
    'api-key':      apiKey,
    'nonce':        nonce,
    'timestamp':    timestamp,
    'sign':         sign,
  };

  const options = { method, headers };
  if (bodyObj) options.body = bodyStr;

  const res  = await fetch(url, options);
  const data = await res.json();

  if (!res.ok || data.code !== 0) {
    const msg = data?.msg || data?.message || JSON.stringify(data);
    throw new Error(`Bitunix API error [${data?.code}]: ${msg}`);
  }

  return data;
}

/* ── Endpoint: GET balance de futuros ─────────────────────── */
app.get('/api/bitunix/account', requireAuth, async (req, res) => {
  try {
    const data = await bitunixRequest('GET', '/api/v1/futures/account/singleAccount', { coin: 'USDT' });
    // Log raw response para debug
    console.log('[Bitunix account raw]', JSON.stringify(data.data));
    res.json({ ok: true, account: data.data, raw: data });
  } catch (err) {
    console.error('Bitunix account error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint de diagnóstico — devuelve respuesta cruda de Bitunix para ver campos reales
app.get('/api/bitunix/debug', requireAuth, async (req, res) => {
  try {
    const account   = await bitunixRequest('GET', '/api/v1/futures/account/singleAccount', { coin: 'USDT' });
    const positions = await bitunixRequest('GET', '/api/v1/futures/position/getPendingPositions', {});
    res.json({ ok: true, account: account.data, positions: positions.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Endpoint: GET posiciones abiertas ────────────────────── */
app.get('/api/bitunix/positions', requireAuth, async (req, res) => {
  try {
    const data = await bitunixRequest('GET', '/api/v1/futures/position/getPendingPositions', {});
    res.json({ ok: true, positions: data.data || [] });
  } catch (err) {
    console.error('Bitunix positions error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Endpoint: POST colocar orden ─────────────────────────── */
app.post('/api/bitunix/place-order', requireAuth, async (req, res) => {
  try {
    const { symbol, qty, side, leverage, orderType, price, tpPrice, slPrice, clientOrderId } = req.body;

    if (!symbol || !qty || !side) {
      return res.status(400).json({ ok: false, error: 'symbol, qty y side son obligatorios' });
    }

    // 1. Establecer apalancamiento
    try {
      await bitunixRequest('POST', '/api/v1/futures/account/changeLeverage', {}, {
        symbol,
        leverage: leverage || 1,
        marginType: 'CROSSED', // margin cruzado por defecto
      });
    } catch (levErr) {
      console.warn('No se pudo cambiar leverage (puede que ya esté configurado):', levErr.message);
    }

    // 2. Colocar orden de mercado
    const orderBody = {
      symbol,
      qty:         String(qty),
      side,             // BUY | SELL
      tradeSide:   'OPEN',
      orderType:   orderType || 'MARKET',
      reduceOnly:  false,
      clientId:    clientOrderId || `cp_${Date.now()}`,
    };
    if (orderType === 'LIMIT' && price) orderBody.price = String(price);

    const orderData = await bitunixRequest('POST', '/api/v1/futures/trade/placeOrder', {}, orderBody);
    const orderId   = orderData.data?.orderId;

    // 3. Colocar TP/SL si se proporcionaron
    let tpslResult = null;
    if ((tpPrice || slPrice) && orderId) {
      try {
        const tpslBody = {
          symbol,
          side:     side === 'BUY' ? 'SELL' : 'BUY', // dirección opuesta para cerrar
          tpPrice:  tpPrice  ? String(tpPrice)  : undefined,
          slPrice:  slPrice  ? String(slPrice)  : undefined,
          tpSize:   String(qty),
          slSize:   String(qty),
          tpOrderType: 'MARKET',
          slOrderType: 'MARKET',
        };
        // Eliminar campos undefined
        Object.keys(tpslBody).forEach(k => tpslBody[k] === undefined && delete tpslBody[k]);
        tpslResult = await bitunixRequest('POST', '/api/v1/futures/tpsl/placePositionTpSlOrder', {}, tpslBody);
      } catch (tpslErr) {
        console.warn('No se pudo colocar TP/SL:', tpslErr.message);
      }
    }

    res.json({ ok: true, orderId, tpsl: tpslResult?.data || null });
  } catch (err) {
    console.error('Bitunix place-order error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Endpoint: POST cerrar posición (flash close) ─────────── */
app.post('/api/bitunix/close-position', requireAuth, async (req, res) => {
  try {
    const { symbol, side } = req.body;
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol es obligatorio' });

    const data = await bitunixRequest('POST', '/api/v1/futures/trade/flashClosePosition', {}, {
      symbol,
      side: side || undefined, // LONG | SHORT, si no se pasa cierra todo
    });

    res.json({ ok: true, data: data.data });
  } catch (err) {
    console.error('Bitunix close-position error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Endpoint: GET historial órdenes de Bitunix ───────────── */
app.get('/api/bitunix/history', requireAuth, async (req, res) => {
  try {
    const data = await bitunixRequest('GET', '/api/v1/futures/trade/getHistoryOrders', {
      pageSize: '20',
      page:     '1',
    });
    res.json({ ok: true, orders: data.data?.resultList || [] });
  } catch (err) {
    console.error('Bitunix history error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Endpoint: estado de configuración Bitunix ────────────── */
app.get('/api/bitunix/status', requireAuth,  (req, res) => {
  const configured = !!(process.env.BITUNIX_API_KEY && process.env.BITUNIX_SECRET);
  res.json({ configured });
});

/* ══════════════════════════════════════════════════════════
   API TRADES (interno)
   ══════════════════════════════════════════════════════════ */
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

app.post('/api/trades/sync', requireAuth,  (req, res) => {
  const { activeTrades } = req.body;
  if (!Array.isArray(activeTrades)) return res.status(400).json({ error: 'activeTrades inválido' });
  const validTrades = activeTrades.filter(isValidTrade);
  const rejected    = activeTrades.length - validTrades.length;
  const existingIds = new Set(serverState.activeTrades.map(t => t.id));
  for (const trade of validTrades) {
    if (!existingIds.has(trade.id)) serverState.activeTrades.push(trade);
  }
  const frontendIds = new Set(validTrades.map(t => t.id));
  serverState.activeTrades = serverState.activeTrades.filter(t => frontendIds.has(t.id));
  res.json({ ok: true, watching: serverState.activeTrades.length, rejected });
});

app.get('/api/trades/closed-by-server', requireAuth,  (req, res) => {
  res.json({ closed: [...serverState.closedTrades] });
});

app.post('/api/trades/confirm-closed', requireAuth,  (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids inválido' });
  serverState.closedTrades = serverState.closedTrades.filter(t => !ids.includes(t.id));
  res.json({ ok: true, remaining: serverState.closedTrades.length });
});

app.get('/api/prices', requireAuth,  (req, res) => {
  res.json(serverState.prices);
});

/* ══════════════════════════════════════════════════════════
   PROXY CLAUDE API
   ══════════════════════════════════════════════════════════ */
app.post('/api/claude', requireAuth, rateLimit, async (req, res) => {
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
        model:      model      || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 4000,
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

/* ══════════════════════════════════════════════════════════
   FALLBACK
   ══════════════════════════════════════════════════════════ */
app.get('*', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CryptoPlan IA corriendo en puerto ${PORT}`);
  connectBinanceWS();
});