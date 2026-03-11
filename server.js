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
const sessions    = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions)
    if (now - s.createdAt > SESSION_TTL) sessions.delete(token);
}, 60 * 60 * 1000);

function generateToken()  { return crypto.randomBytes(64).toString('hex'); }

function getToken(req) {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const m = (req.headers['cookie'] || '').match(/cp_token=([^;]+)/);
  return m ? m[1] : null;
}

function isAuthenticated(req) {
  const token   = getToken(req);
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL) { sessions.delete(token); return false; }
  return true;
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'No autorizado.' });
}

app.post('/auth/login', (req, res) => {
  const { password }    = req.body;
  const correctPassword = process.env.APP_PASSWORD;
  if (!correctPassword) {
    const token = generateToken();
    sessions.set(token, { createdAt: Date.now() });
    return res.json({ ok: true, token });
  }
  if (!password || password !== correctPassword)
    return setTimeout(() => res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' }), 1000);
  const token = generateToken();
  const ip    = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  sessions.set(token, { createdAt: Date.now(), ip });
  console.log(`✓ Login desde ${ip}`);
  res.setHeader('Set-Cookie', `cp_token=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL/1000}; Path=/`);
  res.json({ ok: true, token });
});

app.post('/auth/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'cp_token=; HttpOnly; Max-Age=0; Path=/');
  res.json({ ok: true });
});

app.get('/auth/check', (req, res) => res.json({ authenticated: isAuthenticated(req) }));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ══════════════════════════════════════════════════════════
   ESTADO EN MEMORIA
   ══════════════════════════════════════════════════════════ */
const serverState = { activeTrades: [], closedTrades: [], prices: {} };

/* ══════════════════════════════════════════════════════════
   RATE LIMITING
   ══════════════════════════════════════════════════════════ */
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip    = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const now   = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60_000) { rateLimitMap.set(ip, { count: 1, start: now }); return next(); }
  if (entry.count >= 20) return res.status(429).json({ error: 'Rate limit. Espera un minuto.' });
  entry.count++;
  rateLimitMap.set(ip, entry);
  next();
}

/* ══════════════════════════════════════════════════════════
   BINANCE WEBSOCKET (precios en tiempo real)
   ══════════════════════════════════════════════════════════ */
const COINS  = ['btcusdt','ethusdt','solusdt','xrpusdt','bnbusdt','dogeusdt'];
const WS_URL = 'wss://stream.binance.com:9443/stream?streams=' + COINS.map(s => s + '@miniTicker').join('/');
let binanceWs;

function connectBinanceWS() {
  binanceWs = new WebSocket(WS_URL);
  binanceWs.on('open',    () => console.log('Binance WS conectado'));
  binanceWs.on('message', (raw) => {
    try {
      const { data: d } = JSON.parse(raw);
      if (!d) return;
      const coin = d.s.replace('USDT', '');
      serverState.prices[coin] = parseFloat(d.c);
      checkTPSL(coin, serverState.prices[coin]);
    } catch {}
  });
  binanceWs.on('close', () => setTimeout(connectBinanceWS, 5000));
  binanceWs.on('error', (e) => console.error('Binance WS error:', e.message));
}

function coinOf(par) { return (par || '').split('/')[0]; }
function nowFull() {
  return new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function checkTPSL(coin, price) {
  serverState.activeTrades = serverState.activeTrades.filter(trade => {
    if (coinOf(trade.par) !== coin) return true;
    const hitSL = trade.tipo === 'LONG' ? price <= trade.stopLoss : price >= trade.stopLoss;
    const hitTP = trade.tipo === 'LONG' ? price >= (trade.tp2||trade.tp1) : price <= (trade.tp2||trade.tp1);
    if (hitSL || hitTP) {
      const lev  = trade.leverage || 1;
      const exit = hitTP ? (trade.tp2||trade.tp1) : trade.stopLoss;
      const pnl  = trade.tipo === 'LONG'
        ? (exit - trade.entrada) * trade.size * lev
        : (trade.entrada - exit) * trade.size * lev;
      serverState.closedTrades.unshift({ ...trade, result: hitTP?'WIN':'LOSS', pnl, closedAt: nowFull(), closedByServer: true });
      return false;
    }
    return true;
  });
}

/* ══════════════════════════════════════════════════════════
   BITUNIX API — ENDPOINTS CORRECTOS (snake_case)
   Fuente: https://openapidoc.bitunix.com
   ══════════════════════════════════════════════════════════ */
const BITUNIX_BASE = 'https://fapi.bitunix.com';

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
function generateNonce() {
  return crypto.randomBytes(16).toString('hex'); // 32 chars hex
}

/**
 * Firma Bitunix — doble SHA-256
 * queryParams: clave-valor ordenados por clave ASCII asc, sin = ni &
 *              Ejemplo: {symbol:'BTCUSDT', marginCoin:'USDT'} → "marginCoinUSDTsymbolBTCUSDT"
 * body:        JSON sin espacios
 * digest = SHA256(nonce + timestamp + apiKey + queryParamsStr + bodyStr)
 * sign   = SHA256(digest + secretKey)
 */
function bitunixSign(apiKey, secretKey, nonce, timestamp, queryParamsObj, bodyStr) {
  const qp = Object.keys(queryParamsObj || {})
    .sort()
    .map(k => `${k}${queryParamsObj[k]}`)
    .join('');
  const body   = bodyStr || '';
  const digest = sha256(`${nonce}${timestamp}${apiKey}${qp}${body}`);
  return sha256(`${digest}${secretKey}`);
}

async function bitunixRequest(method, endpoint, queryParams = {}, bodyObj = null) {
  const apiKey    = (process.env.BITUNIX_API_KEY    || '').trim();
  const secretKey = (process.env.BITUNIX_SECRET     || '').trim();
  if (!apiKey || !secretKey) throw new Error('BITUNIX_API_KEY o BITUNIX_SECRET no configurados en Railway.');

  const nonce     = generateNonce();
  const timestamp = Date.now().toString(); // milisegundos UTC
  const bodyStr   = bodyObj ? JSON.stringify(bodyObj) : '';

  // Para la firma: body sin espacios
  const bodyForSign = bodyStr.replace(/\s+/g, '');
  const sign        = bitunixSign(apiKey, secretKey, nonce, timestamp, queryParams, bodyForSign);

  // Query string para la URL (URL-encoded)
  const qs = Object.keys(queryParams).length
    ? '?' + Object.keys(queryParams).sort()
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
        .join('&')
    : '';

  const headers = {
    'Content-Type': 'application/json',
    'api-key':      apiKey,
    'nonce':        nonce,
    'timestamp':    timestamp,
    'sign':         sign,
    'language':     'en-US',
  };

  const options = { method, headers };
  if (bodyObj) options.body = bodyForSign; // enviar exactamente el mismo string que se firmó

  const url = BITUNIX_BASE + endpoint + qs;
  console.log(`[Bitunix] ${method} ${endpoint}${qs}`);

  const res  = await fetch(url, options);
  const text = await res.text();

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Respuesta no-JSON [HTTP ${res.status}]: ${text.slice(0,300)}`); }

  if (data.code !== 0) {
    throw new Error(`Bitunix error [${data.code}]: ${data.msg || JSON.stringify(data)}`);
  }
  return data;
}

/* ── Debug endpoint ──────────────────────────────────────── */
app.get('/api/bitunix/debug', requireAuth, async (req, res) => {
  const apiKey    = (process.env.BITUNIX_API_KEY || '').trim();
  const secretKey = (process.env.BITUNIX_SECRET  || '').trim();

  if (!apiKey || !secretKey)
    return res.json({ ok: false, error: 'Variables BITUNIX_API_KEY y BITUNIX_SECRET no configuradas.' });

  const results = {};

  // 1. Diagnóstico de las keys (sin exponer el valor real)
  results['_keys_info'] = {
    apiKey_length:    apiKey.length,
    secret_length:    secretKey.length,
    apiKey_prefix:    apiKey.slice(0,6) + '...',
    apiKey_suffix:    '...' + apiKey.slice(-4),
    secret_prefix:    secretKey.slice(0,4) + '...',
    apiKey_hasSpaces: apiKey !== (process.env.BITUNIX_API_KEY || ''),
    secret_hasSpaces: secretKey !== (process.env.BITUNIX_SECRET || ''),
    timestamp_ms:     Date.now(),
    nodeVersion:      process.version,
  };

  // 2. Muestra el string exacto que se firma (SIN el secret)
  const testNonce = '123456';
  const testTs    = Date.now().toString();
  const testQp    = 'marginCoinUSDT';
  const testBody  = '';
  const testDigestInput = `${testNonce}${testTs}${apiKey}${testQp}${testBody}`;
  results['_sign_preview'] = {
    nonce:       testNonce,
    timestamp:   testTs,
    qpString:    testQp,
    digestInput: testDigestInput,
    digest:      sha256(testDigestInput),
    // sign = sha256(digest + secretKey)  ← no se muestra el sign real para no exponer el secret
  };

  async function tryEp(label, method, path, params, body) {
    const nonce   = generateNonce();
    const ts      = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body).replace(/\s+/g,'') : '';
    const sign    = bitunixSign(apiKey, secretKey, nonce, ts, params, bodyStr);
    const qpStr   = Object.keys(params).sort().map(k=>`${k}${params[k]}`).join('');
    const qs      = Object.keys(params).length
      ? '?' + Object.keys(params).sort().map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
      : '';
    try {
      const r = await fetch(BITUNIX_BASE + path + qs, {
        method,
        headers: { 'Content-Type':'application/json','api-key':apiKey,'nonce':nonce,'timestamp':ts,'sign':sign,'language':'en-US' },
        ...(body ? { body: bodyStr } : {}),
      });
      const text = await r.text();
      let d; try { d = JSON.parse(text); } catch { d = { raw: text.slice(0,300) }; }
      results[label] = {
        httpStatus: r.status, code: d.code, msg: d.msg, ok: d.code === 0,
        dataPreview: JSON.stringify(d.data).slice(0,200),
        // debug: qué se firmó exactamente
        signed: { nonce, timestamp: ts, qpString: qpStr, bodyStr: bodyStr.slice(0,100) },
      };
    } catch(e) {
      results[label] = { error: e.message };
    }
  }

  await tryEp('account',        'GET', '/api/v1/futures/account', { marginCoin: 'USDT' });
  await tryEp('positions',      'GET', '/api/v1/futures/position/get_pending_positions', {});
  await tryEp('history_orders', 'GET', '/api/v1/futures/trade/get_history_orders', { pageSize:'5', page:'1' });

  res.json({ ok: true, results });
});

/* ── Cuenta ──────────────────────────────────────────────── */
// URL CORRECTA: GET /api/v1/futures/account?marginCoin=USDT
// Respuesta: data es un ARRAY → usar [0]
app.get('/api/bitunix/account', requireAuth, async (req, res) => {
  try {
    const data   = await bitunixRequest('GET', '/api/v1/futures/account', { marginCoin: 'USDT' });
    const rawArr = data.data;
    const raw    = Array.isArray(rawArr) ? rawArr[0] : rawArr;
    if (!raw) return res.status(500).json({ ok: false, error: 'Respuesta vacía de Bitunix' });

    const account = {
      available:              raw.available              ?? null,
      frozen:                 raw.frozen                 ?? null,
      margin:                 raw.margin                 ?? null,
      transfer:               raw.transfer               ?? null,
      crossUnrealizedPNL:     raw.crossUnrealizedPNL     ?? null,
      isolationUnrealizedPNL: raw.isolationUnrealizedPNL ?? null,
      unrealizedPnl:          raw.crossUnrealizedPNL     ?? raw.isolationUnrealizedPNL ?? null,
      bonus:                  raw.bonus                  ?? null,
      positionMode:           raw.positionMode           ?? null,
      marginCoin:             raw.marginCoin             ?? 'USDT',
      equity:                 raw.available              ?? null,
      balance:                raw.available              ?? null,
    };

    console.log('[Bitunix account OK] available:', account.available);
    res.json({ ok: true, account });
  } catch (err) {
    console.error('Bitunix account error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Posiciones abiertas ─────────────────────────────────── */
// URL CORRECTA: GET /api/v1/futures/position/get_pending_positions
app.get('/api/bitunix/positions', requireAuth, async (req, res) => {
  try {
    const data      = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
    const positions = Array.isArray(data.data) ? data.data : [];
    res.json({ ok: true, positions });
  } catch (err) {
    console.error('Bitunix positions error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Colocar orden ───────────────────────────────────────── */
// URL CORRECTA: POST /api/v1/futures/trade/place_order
// change_leverage: POST /api/v1/futures/account/change_leverage (leverage es number, no string)
app.post('/api/bitunix/place-order', requireAuth, async (req, res) => {
  try {
    const { symbol, qty, side, leverage, orderType, price, tpPrice, slPrice, clientOrderId } = req.body;
    if (!symbol || !qty || !side)
      return res.status(400).json({ ok: false, error: 'symbol, qty y side son obligatorios' });

    // 1. Cambiar apalancamiento
    try {
      await bitunixRequest('POST', '/api/v1/futures/account/change_leverage', {}, {
        symbol,
        leverage:   Number(leverage || 1),
        marginCoin: 'USDT',
      });
    } catch (e) {
      console.warn('change_leverage (no fatal):', e.message);
    }

    // 2. Colocar orden con TP/SL incluidos directamente
    const orderBody = {
      symbol,
      qty:       String(qty),
      side,
      tradeSide: 'OPEN',
      orderType: orderType || 'MARKET',
      reduceOnly: false,
      clientId:  clientOrderId || `cp_${Date.now()}`,
    };

    if (orderType === 'LIMIT' && price) orderBody.price = String(price);

    if (tpPrice) {
      orderBody.tpPrice     = String(tpPrice);
      orderBody.tpStopType  = 'LAST_PRICE';
      orderBody.tpOrderType = 'MARKET';
    }
    if (slPrice) {
      orderBody.slPrice     = String(slPrice);
      orderBody.slStopType  = 'LAST_PRICE';
      orderBody.slOrderType = 'MARKET';
    }

    const orderData = await bitunixRequest('POST', '/api/v1/futures/trade/place_order', {}, orderBody);
    const orderId   = orderData.data?.orderId;
    console.log(`[Bitunix order OK] ${symbol} ${side} qty=${qty} orderId=${orderId}`);
    res.json({ ok: true, orderId });
  } catch (err) {
    console.error('Bitunix place-order error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Cerrar posición (flash close) ──────────────────────── */
// URL CORRECTA: POST /api/v1/futures/trade/flash_close_position
// Requiere positionId (no symbol+side)
app.post('/api/bitunix/close-position', requireAuth, async (req, res) => {
  try {
    const { positionId, symbol } = req.body;

    if (!positionId) {
      if (!symbol) return res.status(400).json({ ok: false, error: 'Necesito positionId o symbol' });
      // Buscar positionId en posiciones abiertas
      const posData   = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
      const positions = Array.isArray(posData.data) ? posData.data : [];
      const pos       = positions.find(p => p.symbol === symbol);
      if (!pos) return res.status(404).json({ ok: false, error: `No hay posición abierta para ${symbol}` });
      const data = await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, { positionId: pos.positionId });
      return res.json({ ok: true, data: data.data });
    }

    const data = await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, { positionId });
    res.json({ ok: true, data: data.data });
  } catch (err) {
    console.error('Bitunix close-position error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Historial de órdenes ────────────────────────────────── */
// URL CORRECTA: GET /api/v1/futures/trade/get_history_orders
app.get('/api/bitunix/history', requireAuth, async (req, res) => {
  try {
    const data   = await bitunixRequest('GET', '/api/v1/futures/trade/get_history_orders', { pageSize: '20', page: '1' });
    const orders = Array.isArray(data.data?.resultList) ? data.data.resultList
                 : Array.isArray(data.data?.list)       ? data.data.list
                 : Array.isArray(data.data)             ? data.data
                 : [];
    res.json({ ok: true, orders });
  } catch (err) {
    console.error('Bitunix history error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── Estado de configuración ────────────────────────────── */
app.get('/api/bitunix/status', requireAuth, (req, res) => {
  const configured = !!(process.env.BITUNIX_API_KEY && process.env.BITUNIX_SECRET);
  res.json({ configured, hasTradeKey: configured, canRead: configured });
});

/* ══════════════════════════════════════════════════════════
   API TRADES (TP/SL server-side)
   ══════════════════════════════════════════════════════════ */
function isValidTrade(t) {
  return t && typeof t.id === 'string' && typeof t.par === 'string' &&
    (t.tipo === 'LONG' || t.tipo === 'SHORT') &&
    typeof t.stopLoss === 'number' && isFinite(t.stopLoss) &&
    typeof t.tp1      === 'number' && isFinite(t.tp1) &&
    typeof t.riskUSD  === 'number' && isFinite(t.riskUSD);
}

app.post('/api/trades/sync', requireAuth, (req, res) => {
  const { activeTrades } = req.body;
  if (!Array.isArray(activeTrades)) return res.status(400).json({ error: 'activeTrades inválido' });
  const valid    = activeTrades.filter(isValidTrade);
  const existing = new Set(serverState.activeTrades.map(t => t.id));
  for (const t of valid) if (!existing.has(t.id)) serverState.activeTrades.push(t);
  const ids = new Set(valid.map(t => t.id));
  serverState.activeTrades = serverState.activeTrades.filter(t => ids.has(t.id));
  res.json({ ok: true, watching: serverState.activeTrades.length });
});

app.get('/api/trades/closed-by-server', requireAuth, (req, res) => {
  res.json({ closed: [...serverState.closedTrades] });
});

app.post('/api/trades/confirm-closed', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids inválido' });
  serverState.closedTrades = serverState.closedTrades.filter(t => !ids.includes(t.id));
  res.json({ ok: true });
});

app.get('/api/prices', requireAuth, (req, res) => res.json(serverState.prices));

/* ══════════════════════════════════════════════════════════
   PROXY CLAUDE API
   ══════════════════════════════════════════════════════════ */
app.post('/api/claude', requireAuth, rateLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada.' });
  const { model, max_tokens, system, messages } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'messages inválido.' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model: model || 'claude-sonnet-4-20250514', max_tokens: max_tokens || 4000, system, messages }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'Error Anthropic.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error interno: ' + err.message });
  }
});

/* ── Fallback ────────────────────────────────────────────── */
app.get('*', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CryptoPlan IA en puerto ${PORT}`);
  connectBinanceWS();
});