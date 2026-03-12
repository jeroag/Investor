'use strict';

const express   = require('express');
const path      = require('path');
const WebSocket = require('ws');
const crypto    = require('crypto');

/* ══════════════════════════════════════════════════════════
   PRIORIDAD 4 — Validación de variables de entorno al arrancar
   ══════════════════════════════════════════════════════════ */
function validateEnv() {
  const warnings = [];
  if (!process.env.APP_PASSWORD)
    warnings.push('APP_PASSWORD no configurada — cualquiera puede acceder sin contraseña.');
  if (!process.env.ANTHROPIC_API_KEY)
    warnings.push('ANTHROPIC_API_KEY no configurada — el análisis IA no funcionará.');
  if (!process.env.BITUNIX_API_KEY || !process.env.BITUNIX_SECRET)
    warnings.push('BITUNIX_API_KEY / BITUNIX_SECRET no configuradas — trading real desactivado.');
  if (!process.env.DEBUG_TOKEN)
    warnings.push('DEBUG_TOKEN no configurada — endpoint /api/bitunix/debug solo accesible con sesión activa.');

  if (warnings.length) {
    console.warn('\n⚠️  ADVERTENCIAS DE CONFIGURACIÓN:');
    warnings.forEach(w => console.warn(`   • ${w}`));
    console.warn('');
  }
}
validateEnv();

/* ══════════════════════════════════════════════════════════
   PRIORIDAD 1 — Persistencia SQLite
   ══════════════════════════════════════════════════════════ */
let db;
try {
  const Database = require('better-sqlite3');
  const fs       = require('fs');
  const DB_PATH  = process.env.DB_PATH || path.join(__dirname, 'data', 'cryptoplan.db');
  const dir      = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_trades (
      id       TEXT PRIMARY KEY,
      data     TEXT NOT NULL,
      added_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS closed_trades (
      id        TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      closed_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  console.log('✓ SQLite conectado:', DB_PATH);
} catch (e) {
  console.warn('⚠️  better-sqlite3 no disponible — usando solo memoria.');
  console.warn('   Instala con: npm i better-sqlite3');
  db = null;
}

const dbHelpers = {
  loadActiveTrades() {
    if (!db) return [];
    try { return db.prepare('SELECT data FROM active_trades').all().map(r => JSON.parse(r.data)); }
    catch { return []; }
  },
  saveActiveTrade(trade) {
    if (!db) return;
    try { db.prepare('INSERT OR REPLACE INTO active_trades (id, data) VALUES (?, ?)').run(trade.id, JSON.stringify(trade)); }
    catch (e) { console.error('DB saveActiveTrade:', e.message); }
  },
  deleteActiveTrade(id) {
    if (!db) return;
    try { db.prepare('DELETE FROM active_trades WHERE id = ?').run(id); }
    catch (e) { console.error('DB deleteActiveTrade:', e.message); }
  },
  replaceActiveTrades(trades) {
    if (!db) return;
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM active_trades').run();
        const insert = db.prepare('INSERT INTO active_trades (id, data) VALUES (?, ?)');
        trades.forEach(t => insert.run(t.id, JSON.stringify(t)));
      })();
    } catch (e) { console.error('DB replaceActiveTrades:', e.message); }
  },
  loadClosedTrades() {
    if (!db) return [];
    try { return db.prepare('SELECT data FROM closed_trades ORDER BY closed_at DESC LIMIT 500').all().map(r => JSON.parse(r.data)); }
    catch { return []; }
  },
  saveClosedTrade(trade) {
    if (!db) return;
    try { db.prepare('INSERT OR REPLACE INTO closed_trades (id, data) VALUES (?, ?)').run(trade.id, JSON.stringify(trade)); }
    catch (e) { console.error('DB saveClosedTrade:', e.message); }
  },
  deleteClosedTrades(ids) {
    if (!db || !ids.length) return;
    try {
      const ph = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM closed_trades WHERE id IN (${ph})`).run(...ids);
    } catch (e) { console.error('DB deleteClosedTrades:', e.message); }
  },
};

/* ══════════════════════════════════════════════════════════
   ESTADO EN MEMORIA (restaurado desde SQLite al arrancar)
   ══════════════════════════════════════════════════════════ */
const serverState = {
  activeTrades: dbHelpers.loadActiveTrades(),
  closedTrades: dbHelpers.loadClosedTrades(),
  prices: {},
};
console.log(`✓ Estado restaurado: ${serverState.activeTrades.length} trades activos, ${serverState.closedTrades.length} cerrados.`);

/* ══════════════════════════════════════════════════════════
   APP EXPRESS
   ══════════════════════════════════════════════════════════ */
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

function getTokenFromRequest(req) {
  // Para WebSocket upgrade: cookie o query param
  const m = (req.headers['cookie'] || '').match(/cp_token=([^;]+)/);
  if (m) return m[1];
  try {
    return new URL('http://x' + req.url).searchParams.get('token') || null;
  } catch { return null; }
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
   PRIORIDAD 5 — WebSocket server: push de precios y eventos a clientes
   ══════════════════════════════════════════════════════════ */
const wss           = new WebSocket.Server({ noServer: true });
const clientSockets = new Set();

wss.on('connection', (ws) => {
  clientSockets.add(ws);
  // Enviar snapshot de precios al conectarse
  if (Object.keys(serverState.prices).length) {
    ws.send(JSON.stringify({ type: 'PRICES_SNAPSHOT', prices: serverState.prices }));
  }
  ws.on('close', () => clientSockets.delete(ws));
  ws.on('error', () => clientSockets.delete(ws));
});

function broadcast(event) {
  const msg = JSON.stringify(event);
  for (const client of clientSockets) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch {}
    }
  }
}

// Throttle de precios: no enviar más de 1 update por moneda cada 2s
const priceThrottle = new Map();
function broadcastPrice(coin, price) {
  const now = Date.now();
  if ((now - (priceThrottle.get(coin) || 0)) < 2000) return;
  priceThrottle.set(coin, now);
  broadcast({ type: 'PRICE_UPDATE', coin, price });
}

/* ══════════════════════════════════════════════════════════
   PRIORIDAD 3 — Binance WS: TODAS las monedas (antes solo 6)
   Sincronizado con ALL_COINS del frontend
   ══════════════════════════════════════════════════════════ */
const ALL_COINS = [
  'btcusdt','ethusdt','solusdt','xrpusdt','bnbusdt','dogeusdt',
  'avaxusdt','adausdt','maticusdt','dotusdt','linkusdt','ltcusdt',
  'uniusdt','atomusdt',
];
const WS_BINANCE_URL = 'wss://stream.binance.com:9443/stream?streams=' +
  ALL_COINS.map(s => s + '@miniTicker').join('/');

let binanceWs;
function connectBinanceWS() {
  binanceWs = new WebSocket(WS_BINANCE_URL);
  binanceWs.on('open',    () => console.log(`✓ Binance WS: ${ALL_COINS.length} monedas`));
  binanceWs.on('message', (raw) => {
    try {
      const { data: d } = JSON.parse(raw);
      if (!d) return;
      const coin  = d.s.replace('USDT', '');
      const price = parseFloat(d.c);
      serverState.prices[coin] = price;
      checkTPSL(coin, price);
      broadcastPrice(coin, price);
    } catch {}
  });
  binanceWs.on('close', () => setTimeout(connectBinanceWS, 5000));
  binanceWs.on('error', (e) => console.error('Binance WS error:', e.message));
}

/* ── TP/SL checker ───────────────────────────────────────────────────────── */
function coinOf(par) { return (par || '').split('/')[0]; }
function nowFull()   {
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
      const closed = { ...trade, result: hitTP?'WIN':'LOSS', pnl, closedAt: nowFull(), closedByServer: true };

      serverState.closedTrades.unshift(closed);
      dbHelpers.saveClosedTrade(closed);
      dbHelpers.deleteActiveTrade(trade.id);

      // Push inmediato — PRIORIDAD 5 (antes era solo polling cada 10s)
      broadcast({ type: 'TRADE_CLOSED', trade: closed });
      notifyTradeClosed(closed, closed.result, pnl);
      console.log(`[TP/SL] ${trade.par} ${closed.result} PnL:$${pnl.toFixed(2)}`);
      return false;
    }
    return true;
  });
}

/* ══════════════════════════════════════════════════════════
   BITUNIX API
   ══════════════════════════════════════════════════════════ */
const BITUNIX_BASE = 'https://fapi.bitunix.com';

function sha256(str) { return crypto.createHash('sha256').update(str,'utf8').digest('hex'); }
function generateNonce() { return crypto.randomBytes(16).toString('hex'); }

function bitunixSign(apiKey, secretKey, nonce, timestamp, queryParamsObj, bodyStr) {
  const qp     = Object.keys(queryParamsObj||{}).sort().map(k=>`${k}${queryParamsObj[k]}`).join('');
  const digest = sha256(`${nonce}${timestamp}${apiKey}${qp}${bodyStr||''}`);
  return sha256(`${digest}${secretKey}`);
}

async function bitunixRequest(method, endpoint, queryParams = {}, bodyObj = null) {
  const apiKey    = (process.env.BITUNIX_API_KEY || '').trim();
  const secretKey = (process.env.BITUNIX_SECRET  || '').trim();
  if (!apiKey || !secretKey) throw new Error('BITUNIX_API_KEY o BITUNIX_SECRET no configurados.');

  const nonce       = generateNonce();
  const timestamp   = Date.now().toString();
  const bodyStr     = bodyObj ? JSON.stringify(bodyObj) : '';
  const bodyForSign = bodyStr.replace(/\s+/g,'');
  const sign        = bitunixSign(apiKey, secretKey, nonce, timestamp, queryParams, bodyForSign);

  const qs = Object.keys(queryParams).length
    ? '?' + Object.keys(queryParams).sort().map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`).join('&')
    : '';

  const headers = { 'Content-Type':'application/json','api-key':apiKey,'nonce':nonce,'timestamp':timestamp,'sign':sign,'language':'en-US' };
  const options = { method, headers };
  if (bodyObj) options.body = bodyForSign;

  console.log(`[Bitunix] ${method} ${endpoint}${qs}`);
  const res  = await fetch(BITUNIX_BASE + endpoint + qs, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Respuesta no-JSON [HTTP ${res.status}]: ${text.slice(0,300)}`); }
  if (data.code !== 0) throw new Error(`Bitunix error [${data.code}]: ${data.msg || JSON.stringify(data)}`);
  return data;
}

/* ── PRIORIDAD 2 — Debug endpoint seguro (sin token hardcodeado) ────────── */
// El token ahora viene de la variable de entorno DEBUG_TOKEN de Railway
// Si no se configura, solo funciona con sesión activa
app.get('/api/bitunix/debug', async (req, res) => {
  const debugToken  = process.env.DEBUG_TOKEN;
  const tokenMatch  = debugToken && req.query.token === debugToken;
  if (!isAuthenticated(req) && !tokenMatch) {
    const hint = debugToken
      ? 'Autentícate o añade ?token=<DEBUG_TOKEN> configurado en Railway.'
      : 'Inicia sesión para acceder al debug. Opcionalmente configura DEBUG_TOKEN en Railway.';
    return res.status(401).json({ error: hint });
  }

  const apiKey    = (process.env.BITUNIX_API_KEY || '').trim();
  const secretKey = (process.env.BITUNIX_SECRET  || '').trim();
  if (!apiKey || !secretKey)
    return res.json({ ok: false, error: 'BITUNIX_API_KEY y BITUNIX_SECRET no configuradas.' });

  const results = {
    _keys_info: {
      apiKey_length: apiKey.length, secret_length: secretKey.length,
      apiKey_prefix: apiKey.slice(0,6)+'...', apiKey_suffix: '...'+apiKey.slice(-4),
      timestamp_ms: Date.now(), nodeVersion: process.version,
    }
  };

  async function tryEp(label, method, epPath, params, body) {
    const nonce = generateNonce(), ts = Date.now().toString();
    const bStr  = body ? JSON.stringify(body).replace(/\s+/g,'') : '';
    const sign  = bitunixSign(apiKey, secretKey, nonce, ts, params, bStr);
    const qsStr = Object.keys(params).length
      ? '?'+Object.keys(params).sort().map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&') : '';
    try {
      const r    = await fetch(BITUNIX_BASE+epPath+qsStr, {
        method, headers: { 'Content-Type':'application/json','api-key':apiKey,'nonce':nonce,'timestamp':ts,'sign':sign,'language':'en-US' },
        ...(body ? { body: bStr } : {}),
      });
      const txt = await r.text();
      let d; try { d = JSON.parse(txt); } catch { d = { raw: txt.slice(0,300) }; }
      results[label] = { httpStatus: r.status, code: d.code, msg: d.msg, ok: d.code===0, dataPreview: JSON.stringify(d.data).slice(0,200) };
    } catch(e) { results[label] = { error: e.message }; }
  }

  await tryEp('account',        'GET', '/api/v1/futures/account',                              { marginCoin:'USDT' });
  await tryEp('positions',      'GET', '/api/v1/futures/position/get_pending_positions',       {});
  await tryEp('history_orders', 'GET', '/api/v1/futures/trade/get_history_orders', { pageSize:'5', page:'1' });

  res.json({ ok: true, results });
});

/* ── Cuenta ──────────────────────────────────────────────────────────────── */
app.get('/api/bitunix/account', requireAuth, async (req, res) => {
  try {
    const data   = await bitunixRequest('GET', '/api/v1/futures/account', { marginCoin:'USDT' });
    const rawArr = data.data;
    const raw    = Array.isArray(rawArr) ? rawArr[0] : rawArr;
    if (!raw) return res.status(500).json({ ok:false, error:'Respuesta vacía de Bitunix' });
    const account = {
      available: raw.available??null, frozen: raw.frozen??null, margin: raw.margin??null,
      transfer: raw.transfer??null, crossUnrealizedPNL: raw.crossUnrealizedPNL??null,
      isolationUnrealizedPNL: raw.isolationUnrealizedPNL??null,
      unrealizedPnl: raw.crossUnrealizedPNL??raw.isolationUnrealizedPNL??null,
      bonus: raw.bonus??null, positionMode: raw.positionMode??null,
      marginCoin: raw.marginCoin??'USDT', equity: raw.available??null, balance: raw.available??null,
    };
    res.json({ ok:true, account });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

/* ── Posiciones abiertas ─────────────────────────────────────────────────── */
app.get('/api/bitunix/positions', requireAuth, async (req, res) => {
  try {
    const data      = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
    const positions = Array.isArray(data.data) ? data.data : [];
    res.json({ ok:true, positions });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

/* ── Colocar orden ───────────────────────────────────────────────────────── */
app.post('/api/bitunix/place-order', requireAuth, async (req, res) => {
  try {
    const { symbol, qty, side, leverage, orderType, price, tpPrice, slPrice, clientOrderId } = req.body;
    if (!symbol || !qty || !side) return res.status(400).json({ ok:false, error:'symbol, qty y side son obligatorios' });

    try {
      await bitunixRequest('POST', '/api/v1/futures/account/change_leverage', {}, {
        symbol, leverage: Number(leverage||1), marginCoin:'USDT',
      });
    } catch (e) { console.warn('change_leverage (no fatal):', e.message); }

    const orderBody = {
      symbol, qty: String(qty), side, tradeSide:'OPEN',
      orderType: orderType||'MARKET', reduceOnly: false,
      clientId: clientOrderId||`cp_${Date.now()}`,
    };
    if (orderType==='LIMIT' && price) orderBody.price = String(price);
    if (tpPrice) { orderBody.tpPrice=String(tpPrice); orderBody.tpStopType='LAST_PRICE'; orderBody.tpOrderType='MARKET'; }
    if (slPrice) { orderBody.slPrice=String(slPrice); orderBody.slStopType='LAST_PRICE'; orderBody.slOrderType='MARKET'; }

    const orderData = await bitunixRequest('POST', '/api/v1/futures/trade/place_order', {}, orderBody);
    const orderId   = orderData.data?.orderId;
    console.log(`[Bitunix order OK] ${symbol} ${side} qty=${qty} orderId=${orderId}`);
    // Notificar apertura por Telegram
    notifyTradeOpened({ par: symbol.replace('USDT','/USDT'), tipo: side==='BUY'?'LONG':'SHORT', leverage: leverage||1, entrada: price||'mercado', stopLoss: slPrice||'—', tp1: tpPrice||'—', tp2: null, riskUSD: 0, rr: '—' });
    res.json({ ok:true, orderId });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

/* ── Cerrar posición ─────────────────────────────────────────────────────── */
app.post('/api/bitunix/close-position', requireAuth, async (req, res) => {
  try {
    const { positionId, symbol } = req.body;
    if (!positionId) {
      if (!symbol) return res.status(400).json({ ok:false, error:'Necesito positionId o symbol' });
      const posData   = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
      const positions = Array.isArray(posData.data) ? posData.data : [];
      const pos       = positions.find(p => p.symbol===symbol);
      if (!pos) return res.status(404).json({ ok:false, error:`No hay posición abierta para ${symbol}` });
      const data = await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, { positionId: pos.positionId });
      return res.json({ ok:true, data:data.data });
    }
    const data = await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, { positionId });
    res.json({ ok:true, data:data.data });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

/* ── Actualizar SL de posición abierta (para breakeven) ─────────────────── */
app.post('/api/bitunix/update-sl', requireAuth, async (req, res) => {
  try {
    const { symbol, side, slPrice } = req.body;
    if (!symbol || !slPrice) return res.status(400).json({ ok:false, error:'symbol y slPrice requeridos' });

    // Obtener posición abierta para ese símbolo
    const posData   = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
    const positions = Array.isArray(posData.data) ? posData.data : [];
    const pos       = positions.find(p => p.symbol === symbol && (!side || p.side === side || p.positionSide === side));
    if (!pos) return res.status(404).json({ ok:false, error:`Sin posición abierta para ${symbol}` });

    // Actualizar SL en Bitunix
    const data = await bitunixRequest('POST', '/api/v1/futures/trade/set_risk_limit', {}, {
      positionId: pos.positionId,
      stopLoss:   String(slPrice),
    });
    res.json({ ok:true, data: data.data });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

/* ── Historial de órdenes ────────────────────────────────────────────────── */
app.get('/api/bitunix/history', requireAuth, async (req, res) => {
  try {
    const data   = await bitunixRequest('GET', '/api/v1/futures/trade/get_history_orders', { pageSize:'20', page:'1' });
    const orders = Array.isArray(data.data?.resultList) ? data.data.resultList
                 : Array.isArray(data.data?.list)       ? data.data.list
                 : Array.isArray(data.data)             ? data.data : [];
    res.json({ ok:true, orders });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

/* ── Estado de configuración ─────────────────────────────────────────────── */
app.get('/api/bitunix/status', requireAuth, (req, res) => {
  const configured = !!(process.env.BITUNIX_API_KEY && process.env.BITUNIX_SECRET);
  res.json({ configured, hasTradeKey: configured, canRead: configured });
});

/* ══════════════════════════════════════════════════════════
   API TRADES — con persistencia SQLite
   ══════════════════════════════════════════════════════════ */
function isValidTrade(t) {
  return t && typeof t.id==='string' && typeof t.par==='string' &&
    (t.tipo==='LONG'||t.tipo==='SHORT') &&
    typeof t.stopLoss==='number' && isFinite(t.stopLoss) &&
    typeof t.tp1==='number' && isFinite(t.tp1) &&
    typeof t.riskUSD==='number' && isFinite(t.riskUSD);
}

app.post('/api/trades/sync', requireAuth, (req, res) => {
  const { activeTrades } = req.body;
  if (!Array.isArray(activeTrades)) return res.status(400).json({ error:'activeTrades inválido' });

  const valid    = activeTrades.filter(isValidTrade);
  const existing = new Set(serverState.activeTrades.map(t => t.id));

  // Añadir nuevos trades
  for (const t of valid) {
    if (!existing.has(t.id)) {
      serverState.activeTrades.push(t);
      dbHelpers.saveActiveTrade(t);
    }
  }

  // Eliminar trades que el cliente ya no tiene activos
  const ids = new Set(valid.map(t => t.id));
  const removed = serverState.activeTrades.filter(t => !ids.has(t.id));
  serverState.activeTrades = serverState.activeTrades.filter(t => ids.has(t.id));
  removed.forEach(t => dbHelpers.deleteActiveTrade(t.id));

  res.json({ ok:true, watching: serverState.activeTrades.length });
});

app.get('/api/trades/closed-by-server', requireAuth, (req, res) => {
  res.json({ closed: [...serverState.closedTrades] });
});

app.post('/api/trades/confirm-closed', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error:'ids inválido' });
  serverState.closedTrades = serverState.closedTrades.filter(t => !ids.includes(t.id));
  dbHelpers.deleteClosedTrades(ids);
  res.json({ ok:true });
});

app.get('/api/prices', requireAuth, (req, res) => res.json(serverState.prices));

/* ── PRIORIDAD 6 — Exportar historial CSV ─────────────────────────────── */
app.get('/api/trades/export-csv', requireAuth, (req, res) => {
  const trades = serverState.closedTrades;
  if (!trades.length) return res.status(404).json({ error:'Sin trades cerrados para exportar.' });

  const header = 'ID,Par,Tipo,Entrada,StopLoss,TP1,TP2,Size,Leverage,Resultado,PnL_USD,Cerrado_En,Notas\n';
  const rows   = trades.map(t => {
    const v = x => (x == null ? '' : String(x).replace(/,/g,';'));
    return [
      v(t.id), v(t.par), v(t.tipo), v(t.entrada), v(t.stopLoss),
      v(t.tp1), v(t.tp2||''), v(t.size), v(t.leverage||1),
      v(t.result), v(t.pnl?.toFixed(2)), v(t.closedAt), v(t.notes||''),
    ].join(',');
  }).join('\n');

  const filename = `cryptoplan-${new Date().toISOString().slice(0,10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\ufeff' + header + rows); // BOM para Excel
});

/* ══════════════════════════════════════════════════════════
   PROXY CLAUDE API
   ══════════════════════════════════════════════════════════ */
app.post('/api/claude', requireAuth, rateLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error:'ANTHROPIC_API_KEY no configurada.' });
  const { model, max_tokens, system, messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error:'messages inválido.' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:model||'claude-sonnet-4-20250514', max_tokens:max_tokens||4000, system, messages }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error:data?.error?.message||'Error Anthropic.' });
    res.json(data);
  } catch (err) { res.status(500).json({ error:'Error interno: '+err.message }); }
});

/* ══════════════════════════════════════════════════════════
   ESCÁNER DE MERCADO SERVER-SIDE (24/7, sin navegador)
   ══════════════════════════════════════════════════════════ */
const scannerState = {
  enabled:       false,
  intervalMin:   15,           // minutos entre escaneos
  lastScan:      0,
  lastAlert:     null,
  pendingAlerts: [],           // alertas detectadas esperando que el usuario las vea
  timer:         null,
};

function buildServerTechContext() {
  const prices = serverState.prices;
  const coins  = Object.keys(prices);
  if (!coins.length) return 'Sin datos de precio disponibles.';
  return coins.map(coin => {
    const p = prices[coin];
    return `${coin}/USDT: $${p.toFixed ? p.toFixed(4) : p}`;
  }).join(' | ');
}

async function runServerScan(profile) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const techCtx    = buildServerTechContext();
  const recent     = scannerState.pendingAlerts.slice(-3)
    .map(a => `${a.par} ${a.tipo} @${a.entrada}`).join(' | ') || 'ninguna';
  const capital    = profile?.capital    || 100;
  const leverage   = profile?.leverage   || 1;
  const riskPct    = profile?.risk_pct   || 2;
  const style      = profile?.style      || 'swing';

  const prompt = `Eres un escáner de mercado automático 24/7. Analiza los precios actuales y decide si hay una oportunidad de trading clara.

━━━ PRECIOS EN TIEMPO REAL ━━━
${techCtx}

━━━ PERFIL ━━━
Capital: $${capital} | Riesgo/op: ${riskPct}% = $${(capital * riskPct / 100).toFixed(2)} | Leverage: ${leverage}x | Estilo: ${style}

━━━ ALERTAS RECIENTES (no duplicar) ━━━
${recent}

━━━ CRITERIOS (todos deben cumplirse) ━━━
1. Movimiento significativo: precio en zona clave (soporte/resistencia, ruptura, oversold/overbought)
2. R:R estimado ≥ 2.0 usando niveles técnicos básicos
3. No duplicar par+dirección de alertas recientes
4. Solo monedas con precio disponible en los datos

Responde SOLO JSON:
{"hay_oportunidad":true,"urgencia":"ALTA","par":"XRP/USDT","tipo":"LONG","setup":"descripcion breve","entrada":2.35,"stopLoss":2.18,"tp1":2.68,"tp2":2.90,"rr":"2.1","confianza":75,"signals_aligned":["señal1","señal2"],"razon":"explicacion concisa max 2 lineas","contexto_mercado":"resumen mercado"}
Si no hay oportunidad: {"hay_oportunidad":false,"razon":"motivo"}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-api-key':        apiKey,
        'anthropic-version':'2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 800,
        system:     'Eres escáner técnico de criptomonedas. Responde SOLO JSON válido sin markdown.',
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data?.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[Scanner] Error llamando a Claude:', e.message);
    return null;
  }
}

function startServerScanner(profile) {
  if (scannerState.timer) clearInterval(scannerState.timer);
  scannerState.enabled  = true;
  scannerState.intervalMin = profile?.scan_interval || 15;

  const doScan = async () => {
    if (!scannerState.enabled) return;
    console.log(`[Scanner] Escaneo iniciado — ${new Date().toLocaleTimeString('es-ES')}`);
    scannerState.lastScan = Date.now();
    const result = await runServerScan(profile);
    if (!result) return;

    if (result.hay_oportunidad) {
      const alert = {
        ...result,
        id:        `srv_${Date.now()}`,
        timestamp: new Date().toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' }),
        source:    'server',
        status:    'pending',
      };
      scannerState.lastAlert = alert;
      scannerState.pendingAlerts.unshift(alert);
      if (scannerState.pendingAlerts.length > 20) scannerState.pendingAlerts.pop();

      // Push inmediato al cliente via WebSocket
      broadcast({ type: 'SCANNER_ALERT', alert });
      notifyScannerAlert(alert);
      console.log(`[Scanner] 🚨 Oportunidad: ${alert.par} ${alert.tipo} entrada=${alert.entrada}`);
    } else {
      console.log(`[Scanner] Sin oportunidad — ${result.razon}`);
    }
  };

  doScan(); // primer escaneo inmediato
  scannerState.timer = setInterval(doScan, scannerState.intervalMin * 60 * 1000);
  console.log(`[Scanner] ✓ Activo — escaneo cada ${scannerState.intervalMin} min`);
}

function stopServerScanner() {
  if (scannerState.timer) clearInterval(scannerState.timer);
  scannerState.timer   = null;
  scannerState.enabled = false;
  console.log('[Scanner] ✗ Detenido');
}

/* Endpoints de control del escáner */
app.post('/api/scanner/start', requireAuth, (req, res) => {
  const { profile } = req.body || {};
  startServerScanner(profile);
  res.json({ ok: true, intervalMin: scannerState.intervalMin });
});

app.post('/api/scanner/stop', requireAuth, (req, res) => {
  stopServerScanner();
  res.json({ ok: true });
});

app.get('/api/scanner/status', requireAuth, (req, res) => {
  res.json({
    ok:          true,
    enabled:     scannerState.enabled,
    intervalMin: scannerState.intervalMin,
    lastScan:    scannerState.lastScan,
    pendingCount:scannerState.pendingAlerts.filter(a => a.status === 'pending').length,
    lastAlert:   scannerState.lastAlert,
  });
});

app.get('/api/scanner/alerts', requireAuth, (req, res) => {
  res.json({ ok: true, alerts: scannerState.pendingAlerts });
});


/* ══════════════════════════════════════════════════════════
   TELEGRAM NOTIFICACIONES
   Variables necesarias en Railway:
   TELEGRAM_BOT_TOKEN → token del bot (de @BotFather)
   TELEGRAM_CHAT_ID   → tu chat ID (de @userinfobot)
   ══════════════════════════════════════════════════════════ */
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.warn('[Telegram] Error:', e.message); }
}

function notifyTradeOpened(trade) {
  const dir = trade.tipo === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const lev = trade.leverage > 1 ? ` ${trade.leverage}x` : '';
  sendTelegram(
    `⚡ <b>TRADE ABIERTO</b>\n${dir}${lev} <b>${trade.par}</b>\n` +
    `Entrada: <code>${trade.entrada}</code>\nSL: <code>${trade.stopLoss}</code> | TP1: <code>${trade.tp1}</code>` +
    (trade.tp2 ? ` | TP2: <code>${trade.tp2}</code>` : '') +
    `\nRiesgo: $${(trade.riskUSD||0).toFixed(2)} | R:R 1:${trade.rr}`
  );
}

function notifyTradeClosed(trade, result, pnl) {
  const emoji  = result === 'WIN' ? '✅' : result === 'BREAKEVEN' ? '↔️' : '❌';
  const label  = result === 'WIN' ? 'GANADA' : result === 'BREAKEVEN' ? 'BREAKEVEN' : 'PÉRDIDA';
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  sendTelegram(`${emoji} <b>TRADE ${label}</b>\n<b>${trade.par}</b> ${trade.tipo}\nP&L: <b>${pnlStr}</b>`);
}

function notifyScannerAlert(alert) {
  const dir    = alert.tipo === 'LONG' ? '🟢' : '🔴';
  const urgent = alert.urgencia === 'ALTA' ? '🔥' : '⚡';
  const appUrl = process.env.APP_URL || 'tu app de Railway';
  sendTelegram(
    `${urgent} <b>OPORTUNIDAD DETECTADA</b>\n` +
    `${dir} <b>${alert.par} ${alert.tipo}</b> — ${alert.confianza}% confianza\n` +
    `Entrada: <code>${alert.entrada}</code> | SL: <code>${alert.stopLoss}</code> | TP1: <code>${alert.tp1}</code>\n` +
    `${alert.razon}\n<i>Abre la app para ejecutar → ${appUrl}</i>`
  );
}

function notifyBreakeven(trade) {
  sendTelegram(
    `🔒 <b>BREAKEVEN</b> — ${trade.par} ${trade.tipo}\n` +
    `SL movido a entrada: <code>${trade.entrada}</code>\n` +
    `<i>El trade ya no puede perder dinero.</i>`
  );
}

app.post('/api/telegram/test', requireAuth, async (req, res) => {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return res.json({ ok:false, error:'Configura TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en Railway' });
  await sendTelegram('✅ <b>CryptoPlan IA</b> — Notificaciones Telegram funcionando.');
  res.json({ ok:true });
});

app.get('/api/telegram/status', requireAuth, (req, res) => {
  res.json({ ok:true, configured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) });
});

app.get('*', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ══════════════════════════════════════════════════════════
   ARRANQUE DEL SERVIDOR + UPGRADE WS
   ══════════════════════════════════════════════════════════ */
const httpServer = app.listen(PORT, () => {
  console.log(`\n🚀 CryptoPlan IA en puerto ${PORT}\n`);
  connectBinanceWS();
});

// Upgrade HTTP → WebSocket en la ruta /ws
httpServer.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }

  const token   = getTokenFromRequest(req);
  const session = token ? sessions.get(token) : null;
  if (!session || Date.now() - session.createdAt > SESSION_TTL) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});