const express   = require('express');
const path      = require('path');
const WebSocket = require('ws');
const crypto    = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* ══════════════════════════════════════════════════════════
   AUTENTICACIÓN
   ══════════════════════════════════════════════════════════ */

const sessions = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

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

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
}

app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  const correctPassword = process.env.APP_PASSWORD;

  if (!correctPassword) {
    console.warn('⚠️  APP_PASSWORD no configurada.');
    const token = generateToken();
    sessions.set(token, { createdAt: Date.now() });
    return res.json({ ok: true, token });
  }

  if (!password || password !== correctPassword) {
    return setTimeout(() => {
      res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' });
    }, 1000);
  }

  const token = generateToken();
  const ip    = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  sessions.set(token, { createdAt: Date.now(), ip });
  console.log(`✓ Login exitoso desde ${ip}`);

  res.setHeader('Set-Cookie', `cp_token=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL/1000}; Path=/`);
  res.json({ ok: true, token });
});

app.post('/auth/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'cp_token=; HttpOnly; Max-Age=0; Path=/');
  res.json({ ok: true });
});

app.get('/auth/check', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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
   BINANCE WEBSOCKET
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
   BITUNIX API INTEGRATION — CORREGIDA
   ══════════════════════════════════════════════════════════ */
const BITUNIX_BASE = 'https://fapi.bitunix.com';

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function generateNonce() {
  // Bitunix espera nonce de exactamente 32 chars alfanuméricos
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Firma Bitunix:
 * 1. queryParams → ordenar por ASCII, concatenar "k1v1k2v2" (sin =, sin &)
 * 2. bodyStr → JSON sin espacios, o "" si no hay body
 * 3. digest = SHA256(nonce + timestamp + apiKey + queryParams + body)
 * 4. sign   = SHA256(digest + secretKey)
 */
function bitunixSign(apiKey, secretKey, nonce, timestamp, queryParamsObj, bodyStr) {
  const qp = Object.keys(queryParamsObj || {})
    .sort()
    .map(k => `${k}${queryParamsObj[k]}`)
    .join('');

  // El body NO debe tener espacios en blanco
  const body = bodyStr ? bodyStr.replace(/\s+/g, '') : '';

  const digest = sha256(`${nonce}${timestamp}${apiKey}${qp}${body}`);
  const sign   = sha256(`${digest}${secretKey}`);
  return sign;
}

/**
 * Llamada autenticada a Bitunix.
 *
 * FIX: Usamos timestamp en milisegundos (requerido por Bitunix).
 * FIX: Content-Type solo en requests con body (POST).
 * FIX: marginCoin=USDT incluido por defecto en endpoints de cuenta.
 */
async function bitunixRequest(method, endpoint, queryParams = {}, bodyObj = null, forceKey = null) {
  const tradeKey  = process.env.BITUNIX_API_KEY;
  const tradeSec  = process.env.BITUNIX_SECRET;
  const readKey   = process.env.BITUNIX_READ_KEY   || tradeKey;
  const readSec   = process.env.BITUNIX_READ_SECRET || tradeSec;

  if (!tradeKey || !tradeSec) {
    throw new Error('BITUNIX_API_KEY o BITUNIX_SECRET no configurados.');
  }

  const isReadOnly = method === 'GET';
  let apiKey, secretKey;
  if (forceKey === 'read' || (isReadOnly && forceKey !== 'trade')) {
    apiKey = readKey; secretKey = readSec;
  } else {
    apiKey = tradeKey; secretKey = tradeSec;
  }

  const nonce     = generateNonce();
  const timestamp = Date.now().toString(); // Bitunix usa milisegundos

  // Para la firma usamos los valores RAW (no URL-encoded)
  const bodyStr = bodyObj ? JSON.stringify(bodyObj).replace(/\s+/g, '') : '';
  const sign    = bitunixSign(apiKey, secretKey, nonce, timestamp, queryParams, bodyStr);

  // Para la URL sí hacemos encodeURIComponent
  const qs = Object.keys(queryParams).length
    ? '?' + Object.keys(queryParams).sort().map(k => `${k}=${encodeURIComponent(queryParams[k])}`).join('&')
    : '';

  const url = BITUNIX_BASE + endpoint + qs;

  const headers = {
    'api-key':   apiKey,
    'nonce':     nonce,
    'timestamp': timestamp,
    'sign':      sign,
  };
  // FIX: solo añadir Content-Type si hay body
  if (bodyObj) headers['Content-Type'] = 'application/json';

  const options = { method, headers };
  if (bodyObj) options.body = bodyStr;

  const res  = await fetch(url, options);
  const data = await res.json();

  if (!res.ok || (data.code !== undefined && data.code !== 0)) {
    const msg = data?.msg || data?.message || JSON.stringify(data);
    throw new Error(`Bitunix API error [${data?.code}]: ${msg}`);
  }

  return data;
}

/* ── Debug endpoint (diagnóstico completo) ────────────────── */
app.get('/api/bitunix/debug', requireAuth, async (req, res) => {
  const results = {};
  const tradeKey = process.env.BITUNIX_API_KEY;
  const tradeSec = process.env.BITUNIX_SECRET;
  const readKey  = process.env.BITUNIX_READ_KEY   || tradeKey;
  const readSec  = process.env.BITUNIX_READ_SECRET || tradeSec;

  if (!tradeKey || !tradeSec) {
    return res.json({ ok: false, error: 'API keys no configuradas en variables de entorno' });
  }

  async function tryEndpoint(label, key, sec, method, path, params, body) {
    const nonce = generateNonce();
    const ts    = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body).replace(/\s+/g,'') : '';
    const sign  = bitunixSign(key, sec, nonce, ts, params, bodyStr);
    const qs    = Object.keys(params).length
      ? '?' + Object.keys(params).sort().map(k=>`${k}=${encodeURIComponent(params[k])}`).join('&')
      : '';
    const headers = { 'api-key':key,'nonce':nonce,'timestamp':ts,'sign':sign };
    if (body) headers['Content-Type'] = 'application/json';
    try {
      const r = await fetch(BITUNIX_BASE + path + qs, {
        method, headers,
        ...(body ? { body: bodyStr } : {}),
      });
      const d = await r.json();
      results[label] = { httpStatus: r.status, code: d.code, msg: d.msg, data: d.data, ok: d.code === 0 };
    } catch(e) {
      results[label] = { error: e.message };
    }
  }

  // Test endpoints de cuenta con ambas keys
  await tryEndpoint('account_read',  readKey, readSec, 'GET', '/api/v1/futures/account/singleAccount', { marginCoin:'USDT' });
  await tryEndpoint('account_trade', tradeKey, tradeSec, 'GET', '/api/v1/futures/account/singleAccount', { marginCoin:'USDT' });
  await tryEndpoint('positions_read', readKey, readSec, 'GET', '/api/v1/futures/position/getPendingPositions', {});
  await tryEndpoint('history_orders', readKey, readSec, 'GET', '/api/v1/futures/trade/getHistoryOrders', { pageSize:'5', page:'1' });

  results['_config'] = {
    sameKey: readKey === tradeKey,
    tradeKeyPrefix: tradeKey?.slice(0,8) + '...',
    readKeyPrefix:  readKey?.slice(0,8) + '...',
    timestamp_ms: Date.now(),
    timestamp_s:  Math.floor(Date.now()/1000),
  };

  res.json({ ok: true, results });
});

/* ── GET saldo de futuros ─────────────────────────────────── */
app.get('/api/bitunix/account', requireAuth, async (req, res) => {
  // FIX: Usar directamente el endpoint correcto con marginCoin=USDT
  // que es el requerido por Bitunix para futuros USDT
  const endpoints = [
    { path: '/api/v1/futures/account/singleAccount', params: { marginCoin: 'USDT' } },
    { path: '/api/v1/futures/account/singleAccount', params: {} },
    { path: '/api/v1/futures/account/getAccount',    params: { marginCoin: 'USDT' } },
  ];

  for (const ep of endpoints) {
    try {
      const data = await bitunixRequest('GET', ep.path, ep.params);
      if (data.code === 0) {
        // Normalizar los campos del account para que el frontend
        // siempre reciba los mismos nombres de campo
        const raw = data.data || {};
        const account = {
          // Campos normalizados que el frontend lee
          available:      raw.available      ?? raw.availableBalance ?? raw.availAmt ?? raw.freeBalance ?? null,
          equity:         raw.equity         ?? raw.totalEquity      ?? raw.marginBalance ?? null,
          balance:        raw.balance        ?? raw.walletBalance    ?? raw.totalBalance   ?? null,
          unrealizedPnl:  raw.unrealizedPnl  ?? raw.crossUnPnl      ?? raw.unPnl          ?? null,
          // Guardar campos originales también
          ...raw,
        };
        console.log(`[Bitunix account OK] endpoint: ${ep.path}`, JSON.stringify(account));
        return res.json({ ok: true, account });
      }
    } catch (err) {
      console.warn(`[Bitunix account] ${ep.path} → ${err.message}`);
    }
  }

  res.status(500).json({
    ok: false,
    error: 'No se pudo obtener el saldo. Verifica:\n1. Que las API keys estén correctamente configuradas\n2. Que tengan permiso de LECTURA en futuros\n3. Que la IP de Railway esté en la whitelist de Bitunix'
  });
});

/* ── GET posiciones abiertas ──────────────────────────────── */
app.get('/api/bitunix/positions', requireAuth, async (req, res) => {
  try {
    const data = await bitunixRequest('GET', '/api/v1/futures/position/getPendingPositions', {});
    // Bitunix puede devolver la lista directamente o en data.resultList
    const positions = Array.isArray(data.data)
      ? data.data
      : (data.data?.resultList || data.data?.list || []);
    res.json({ ok: true, positions });
  } catch (err) {
    console.error('Bitunix positions error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── POST colocar orden ───────────────────────────────────── */
app.post('/api/bitunix/place-order', requireAuth, async (req, res) => {
  try {
    const { symbol, qty, side, leverage, orderType, price, tpPrice, slPrice, clientOrderId } = req.body;

    if (!symbol || !qty || !side) {
      return res.status(400).json({ ok: false, error: 'symbol, qty y side son obligatorios' });
    }

    // 1. Configurar apalancamiento
    // FIX: usar positionType (1=LONG si BUY, 2=SHORT si SELL)
    const positionType = side === 'BUY' ? 1 : 2;
    try {
      await bitunixRequest('POST', '/api/v1/futures/account/changeLeverage', {}, {
        symbol,
        leverage:     String(leverage || 1),
        positionType,   // 1 = LONG, 2 = SHORT
        marginCoin:  'USDT',
      });
    } catch (levErr) {
      console.warn('changeLeverage (puede que ya esté configurado):', levErr.message);
    }

    // 2. Colocar orden
    const orderBody = {
      symbol,
      qty:        String(qty),
      side,                            // BUY | SELL
      tradeSide:  'OPEN',
      orderType:  orderType || 'MARKET',
      reduceOnly: false,
      clientId:   clientOrderId || `cp_${Date.now()}`,
      marginCoin: 'USDT',
    };
    if (orderType === 'LIMIT' && price) orderBody.price = String(price);

    const orderData = await bitunixRequest('POST', '/api/v1/futures/trade/placeOrder', {}, orderBody);
    const orderId   = orderData.data?.orderId;

    // 3. TP/SL
    // FIX: usar positionSide (LONG/SHORT) para el endpoint de TP/SL
    let tpslResult = null;
    if ((tpPrice || slPrice) && orderId) {
      try {
        const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const tpslBody = {
          symbol,
          positionSide,              // FIX: campo correcto para este endpoint
          marginCoin: 'USDT',
        };
        if (tpPrice) {
          tpslBody.tpTriggerPrice = String(tpPrice);
          tpslBody.tpOrderType    = 'MARKET';  // cierre a mercado al tocar TP
        }
        if (slPrice) {
          tpslBody.slTriggerPrice = String(slPrice);
          tpslBody.slOrderType    = 'MARKET';  // cierre a mercado al tocar SL
        }
        tpslResult = await bitunixRequest('POST', '/api/v1/futures/tpsl/placePositionTpSlOrder', {}, tpslBody);
      } catch (tpslErr) {
        console.warn('TP/SL placement error:', tpslErr.message);
      }
    }

    res.json({ ok: true, orderId, tpsl: tpslResult?.data || null });
  } catch (err) {
    console.error('Bitunix place-order error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── POST cerrar posición ─────────────────────────────────── */
app.post('/api/bitunix/close-position', requireAuth, async (req, res) => {
  try {
    const { symbol, side } = req.body;
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol es obligatorio' });

    // FIX: flashClosePosition espera positionSide (LONG|SHORT), no BUY|SELL
    // El campo side del trade en el frontend ya es LONG|SHORT
    const body = { symbol, marginCoin: 'USDT' };
    if (side) body.side = side; // LONG | SHORT

    const data = await bitunixRequest('POST', '/api/v1/futures/trade/flashClosePosition', {}, body);
    res.json({ ok: true, data: data.data });
  } catch (err) {
    console.error('Bitunix close-position error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── GET historial órdenes ────────────────────────────────── */
app.get('/api/bitunix/history', requireAuth, async (req, res) => {
  try {
    const data = await bitunixRequest('GET', '/api/v1/futures/trade/getHistoryOrders', {
      pageSize: '20',
      page:     '1',
    });
    const orders = data.data?.resultList || data.data?.list || data.data || [];
    res.json({ ok: true, orders: Array.isArray(orders) ? orders : [] });
  } catch (err) {
    console.error('Bitunix history error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Estado de configuración Bitunix ──────────────────────── */
app.get('/api/bitunix/status', requireAuth, (req, res) => {
  const hasTradeKey = !!(process.env.BITUNIX_API_KEY && process.env.BITUNIX_SECRET);
  const hasReadKey  = !!(process.env.BITUNIX_READ_KEY && process.env.BITUNIX_READ_SECRET);
  res.json({
    configured: hasTradeKey,
    hasTradeKey,
    hasReadKey,
    canRead: hasTradeKey || hasReadKey,
  });
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

app.post('/api/trades/sync', requireAuth, (req, res) => {
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

app.get('/api/trades/closed-by-server', requireAuth, (req, res) => {
  res.json({ closed: [...serverState.closedTrades] });
});

app.post('/api/trades/confirm-closed', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids inválido' });
  serverState.closedTrades = serverState.closedTrades.filter(t => !ids.includes(t.id));
  res.json({ ok: true, remaining: serverState.closedTrades.length });
});

app.get('/api/prices', requireAuth, (req, res) => {
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
