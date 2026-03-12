/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — app.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── Auth helpers ─────────────────────────────────────────────────────────── */

/** Devuelve el token de sesión guardado en sessionStorage */
function getAuthToken() {
  return sessionStorage.getItem('cp_token') || '';
}

/**
 * Wrapper de fetch que inyecta el token en todas las peticiones a /api/*
 * Uso: authFetch('/api/...', options)  →  igual que fetch pero autenticado
 * Si el servidor devuelve 401, redirige al login automáticamente.
 */
async function authFetch(url, options = {}) {
  const token = getAuthToken();
  options.headers = options.headers || {};
  if (token) options.headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, options);
  if (res.status === 401) {
    // Sesión expirada — ir al login
    sessionStorage.removeItem('cp_token');
    window.location.href = '/login';
    throw new Error('Sesión expirada. Redirigiendo al login...');
  }
  return res;
}

/** Cierra sesión: borra token local, llama al servidor y redirige al login */
async function doLogout() {
  try {
    await authFetch('/auth/logout', { method: 'POST' });
  } catch {}
  sessionStorage.removeItem('cp_token');
  window.location.href = '/login';
}

/* ── Constants ───────────────────────────────────────────────────────────── */
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// Todas las monedas disponibles
const ALL_COINS = ['BTC','ETH','SOL','XRP','BNB','DOGE','AVAX','ADA','MATIC','DOT','LINK','LTC','UNI','ATOM'];

const COIN_NAMES = {
  BTC:   'Bitcoin',    ETH:  'Ethereum',  SOL:  'Solana',
  XRP:   'XRP',        BNB:  'BNB',       DOGE: 'Dogecoin',
  AVAX:  'Avalanche',  ADA:  'Cardano',   MATIC:'Polygon',
  DOT:   'Polkadot',   LINK: 'Chainlink', LTC:  'Litecoin',
  UNI:   'Uniswap',    ATOM: 'Cosmos',
};

// Cantidades mínimas de Bitunix Futures por moneda (en unidades base)
// Fuente: documentación Bitunix — se usan para filtrar qué monedas son ejecutables
const BITUNIX_MIN_QTY = {
  BTC:   0.001,   // ~$83  a $83k
  ETH:   0.01,    // ~$18  a $1800
  SOL:   0.1,     // ~$13  a $130
  XRP:   1,       // ~$2.4 a $2.4
  BNB:   0.01,    // ~$6   a $600
  DOGE:  10,      // ~$1.7 a $0.17
  AVAX:  0.1,     // ~$2   a $20
  ADA:   1,       // ~$0.4 a $0.4
  MATIC: 1,       // ~$0.5 a $0.5
  DOT:   0.1,     // ~$0.4 a $4
  LINK:  0.1,     // ~$1.4 a $14
  LTC:   0.01,    // ~$0.9 a $90
  UNI:   0.1,     // ~$0.6 a $6
  ATOM:  0.1,     // ~$0.5 a $5
};

/**
 * Calcula qué monedas son ejecutables en Bitunix dado el capital y configuración actual.
 * Devuelve un array de objetos con info de cada moneda factible.
 *
 * Lógica: con el capital, riesgo y leverage, ¿la qty calculada supera el mínimo de Bitunix?
 * Se asume un SL típico del 2% del precio de entrada (conservador).
 */
function buildFeasibleCoins() {
  const { profile, prices, watchedCoins } = state;
  const capital  = profile.capital  || 0;
  const riskPct  = profile.risk_pct || 2;
  const leverage = profile.leverage || 1;
  const riskUSD  = capital * riskPct / 100;

  const feasible   = [];
  const infeasible = [];

  const coinsToCheck = watchedCoins.length ? watchedCoins : ALL_COINS;

  coinsToCheck.forEach(coin => {
    const price  = prices[coin];
    const minQty = BITUNIX_MIN_QTY[coin] ?? 1;
    if (!price || price <= 0) return;

    // SL típico = 2% del precio (ajustado a la volatilidad por tipo de moneda)
    const slPct   = coin === 'BTC' ? 0.02 : coin === 'ETH' ? 0.025 : 0.03;
    const slDist  = price * slPct;
    const qty     = riskUSD / (slDist * leverage);
    const minNotional = minQty * price;
    const myNotional  = qty * price;
    const margin      = myNotional / leverage;

    if (qty >= minQty) {
      feasible.push({
        coin,
        price,
        qty:       parseFloat(qty.toFixed(4)),
        minQty,
        margin:    parseFloat(margin.toFixed(2)),
        notional:  parseFloat(myNotional.toFixed(2)),
        marginPct: parseFloat((margin / capital * 100).toFixed(1)),
      });
    } else {
      // Calcular cuánto capital mínimo necesitaría
      const minCapitalNeeded = (minQty * slDist * leverage) / (riskPct / 100);
      infeasible.push({ coin, price, minQty, minNotional: parseFloat(minNotional.toFixed(2)), minCapitalNeeded: parseFloat(minCapitalNeeded.toFixed(2)) });
    }
  });

  return { feasible, infeasible, riskUSD, capital, leverage };
}

/**
 * Genera el bloque de texto para inyectar en el prompt de IA,
 * informando qué monedas puede y no puede operar con su capital.
 */
function buildFeasibleCoinsContext() {
  if (!bitunix.configured) return ''; // Sin Bitunix no aplicamos restricción

  const { feasible, infeasible, riskUSD, capital, leverage } = buildFeasibleCoins();

  if (feasible.length === 0) {
    return `\n⛔ RESTRICCIÓN CRÍTICA DE CAPITAL:\nCon $${capital} de capital, ${riskUSD.toFixed(2)}$ de riesgo/op y ${leverage}x leverage, NINGUNA moneda disponible cumple el mínimo de Bitunix. No generes propuestas. Informa al usuario que necesita más capital o mayor leverage.`;
  }

  const feasibleList = feasible
    .map(f => `${f.coin} (precio $${f.price.toLocaleString()}, margen necesario ~$${f.margin}, posición ~$${f.notional})`)
    .join(', ');

  const infeasibleList = infeasible.length
    ? infeasible.map(f => `${f.coin} (mín. $${f.minCapitalNeeded} capital)`).join(', ')
    : 'ninguna';

  return `
━━━ RESTRICCIÓN DE CAPITAL — BITUNIX MÍNIMOS ━━━
Capital: $${capital} | Riesgo/op: $${riskUSD.toFixed(2)} | Leverage: ${leverage}x

✅ MONEDAS EJECUTABLES (qty supera mínimo Bitunix):
${feasibleList}

❌ MONEDAS NO EJECUTABLES (capital insuficiente para el mínimo):
${infeasibleList}

⚠️ REGLA ABSOLUTA: Solo propón trades de las monedas EJECUTABLES. Ignorar esta regla causará que la orden sea rechazada por el exchange.`;
}


const DEFAULT_WATCHED_COINS = ['BTC','ETH','SOL','XRP','BNB','DOGE'];

function buildWsUrl(coins) {
  return 'wss://stream.binance.com:9443/stream?streams=' +
    coins.map(c => c.toLowerCase() + 'usdt@miniTicker').join('/');
}

const STORAGE_KEYS = {
  activeTrades:  'cp:activeTrades',
  closedTrades:  'cp:closedTrades',
  alerts:        'cp:alerts',
  strategy:      'cp:strategy',
  profile:       'cp:profile',
  scanInterval:  'cp:scanInterval',
  watchedCoins:  'cp:watchedCoins',
  priceAlerts:   'cp:priceAlerts',
  scanLog:       'cp:scanLog',
  aiHistory:     'cp:aiHistory',
  darkMode:      'cp:darkMode',
  goals:         'cp:goals',
  onboarded:     'cp:onboarded',
};

const DEFAULT_PROFILE = {
  style: 'swing',
  risk_tolerance: 'moderado',
  preferred_coins: ['BTC','ETH'],
  notes: '',
  capital: 1000,
  risk_pct: 2,
  leverage: 1,         // apalancamiento por defecto (1x = sin apalancamiento)
};

// MARKET_META — se actualiza dinámicamente desde Binance
const MARKET_META = {};
function initMarketMeta(coins) {
  coins.forEach(c => {
    if (!MARKET_META[c]) MARKET_META[c] = { tag:'—', cls:'tm', rsi:'...', sup:'...', res:'...' };
  });
  // Eliminar monedas que ya no se siguen
  Object.keys(MARKET_META).forEach(c => { if (!coins.includes(c)) delete MARKET_META[c]; });
}

/* ══════════════════════════════════════════════════════════
   MOTOR DE INDICADORES TÉCNICOS
   ══════════════════════════════════════════════════════════ */

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d >= 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + Math.max(d,0)) / period;
    al = (al * (period-1) + Math.max(-d,0)) / period;
  }
  if (al === 0) return 100;
  return Math.round(100 - 100 / (1 + ag/al));
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i]*k + ema*(1-k);
  return ema;
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const macdSeries = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = calcEMA(closes.slice(0,i), 12);
    const e26 = calcEMA(closes.slice(0,i), 26);
    if (e12 !== null && e26 !== null) macdSeries.push(e12 - e26);
  }
  const macdLine = macdSeries[macdSeries.length-1];
  const signal   = macdSeries.length >= 9 ? calcEMA(macdSeries, 9) : null;
  return { macd: macdLine, signal, hist: signal !== null ? macdLine - signal : null };
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma   = slice.reduce((a,b) => a+b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a,b) => a + (b-sma)**2, 0) / period);
  return { upper: sma + mult*std, mid: sma, lower: sma - mult*std, width: (4*std)/sma*100 };
}

function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period+1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++)
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  return trs.slice(-period).reduce((a,b) => a+b, 0) / period;
}

function analyzeVolume(volumes) {
  if (volumes.length < 21) return null;
  const recent = volumes.slice(-1)[0];
  const avg20  = volumes.slice(-21,-1).reduce((a,b) => a+b, 0) / 20;
  const ratio  = recent / avg20;
  const t5     = volumes.slice(-5).reduce((a,b) => a+b, 0) / 5;
  return {
    ratio: parseFloat(ratio.toFixed(2)),
    signal: ratio > 1.5 ? 'ALTO — confirma movimiento' : ratio < 0.7 ? 'BAJO — movimiento débil' : 'normal',
    trending: t5 > avg20*1.1 ? 'creciente' : t5 < avg20*0.9 ? 'decreciente' : 'estable',
  };
}

function detectCandlePatterns(opens, highs, lows, closes) {
  const patterns = [];
  const n = closes.length - 1;
  if (n < 2) return patterns;
  const o=opens[n], h=highs[n], l=lows[n], c=closes[n];
  const po=opens[n-1], ph=highs[n-1], pl=lows[n-1], pc=closes[n-1];
  const body=Math.abs(c-o), range=h-l, prevBody=Math.abs(pc-po);
  if (body<range*0.3 && (l<Math.min(o,c)-range*0.4) && (h-Math.max(o,c))<body && c>o)
    patterns.push({name:'Martillo',bias:'ALCISTA',strength:'MEDIA'});
  if (body<range*0.3 && (h-Math.max(o,c))>range*0.4 && (Math.min(o,c)-l)<body && c<o)
    patterns.push({name:'Shooting Star',bias:'BAJISTA',strength:'MEDIA'});
  if (c>o && pc<po && c>po && o<pc && body>prevBody)
    patterns.push({name:'Engulfing Alcista',bias:'ALCISTA',strength:'FUERTE'});
  if (c<o && pc>po && c<po && o>pc && body>prevBody)
    patterns.push({name:'Engulfing Bajista',bias:'BAJISTA',strength:'FUERTE'});
  if (body<range*0.1 && range>0)
    patterns.push({name:'Doji',bias:'NEUTRO — indecisión',strength:'BAJA'});
  if (c<o && body>range*0.7)
    patterns.push({name:'Vela Bajista Fuerte',bias:'BAJISTA',strength:'FUERTE'});
  if (c>o && body>range*0.7)
    patterns.push({name:'Vela Alcista Fuerte',bias:'ALCISTA',strength:'FUERTE'});
  return patterns;
}

function calcKeyLevels(highs, lows, closes) {
  const swingH=[], swingL=[];
  const range = Math.min(closes.length-2, 50);
  for (let i=1; i<range; i++) {
    if (highs[i]>highs[i-1] && highs[i]>highs[i+1]) swingH.push(highs[i]);
    if (lows[i]<lows[i-1]   && lows[i]<lows[i+1])   swingL.push(lows[i]);
  }
  const price = closes[closes.length-1];
  const sup = swingL.filter(l=>l<price).sort((a,b)=>b-a)[0] || Math.min(...lows.slice(-20));
  const res = swingH.filter(h=>h>price).sort((a,b)=>a-b)[0] || Math.max(...highs.slice(-20));
  return { sup, res };
}

function calcConfluence(meta) {
  let bull=0, bear=0;
  const r = meta.rsi;
  if (typeof r === 'number') {
    if (r<35) bull+=2; else if (r<45) bull+=1;
    else if (r>65) bear+=2; else if (r>55) bear+=1;
  }
  if (meta.ema) {
    const {price,ema20,ema50,ema200}=meta.ema;
    if (price>ema20) bull++; else bear++;
    if (price>ema50) bull++; else bear++;
    if (ema20>ema50) bull++; else bear++;
    if (ema200) { if (price>ema200) bull++; else bear++; }
  }
  if (meta.macd?.hist!=null) {
    if (meta.macd.hist>0) bull++; else bear++;
    if (meta.macd.macd>0) bull++; else bear++;
  }
  if (meta.bb) {
    const {price,lower,upper,mid}=meta.bb;
    if (price<lower) bull+=2; else if (price>upper) bear+=2;
    else if (price<mid) bull++; else bear++;
  }
  (meta.patterns||[]).forEach(p => {
    if (p.bias==='ALCISTA') bull += p.strength==='FUERTE' ? 2 : 1;
    if (p.bias==='BAJISTA') bear += p.strength==='FUERTE' ? 2 : 1;
  });
  const total=bull+bear, score=total>0 ? Math.round(bull/total*100) : 50;
  return { bull, bear, score, bias: score>=65?'ALCISTA':score<=35?'BAJISTA':'NEUTRO' };
}

function rsiTag(rsi) {
  if (rsi===null||rsi===undefined) return {tag:'—',cls:'tm'};
  if (rsi<30)  return {tag:'SOBREVENDIDO',cls:'tg'};
  if (rsi<45)  return {tag:'ACUMULAR',cls:'tg'};
  if (rsi<55)  return {tag:'NEUTRO',cls:'tm'};
  if (rsi<70)  return {tag:'CAUTELA',cls:'ty'};
  return             {tag:'SOBRECOMPRADO',cls:'tr'};
}

function fmtSup(price, coin) {
  if (coin==='XRP'||coin==='DOGE') return '$'+price.toFixed(4);
  if (price>1000) return '$'+(price/1000).toFixed(1)+'K';
  return '$'+price.toFixed(2);
}

async function fetchMarketMeta() {
  const coins = state.watchedCoins;
  initMarketMeta(coins);

  // Procesar monedas de una en una con micro-pausa entre ellas
  // para no saturar la red ni bloquear el hilo principal
  for (const coin of coins) {
    try {
      const symbol = coin + 'USDT';
      const [r4h, r1d] = await Promise.all([
        fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=4h&limit=200`),
        fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=60`),
      ]);
      if (!r4h.ok) continue;
      const k4h = await r4h.json();
      const k1d = r1d.ok ? await r1d.json() : [];

      const closes4h  = k4h.map(k=>parseFloat(k[4]));
      const opens4h   = k4h.map(k=>parseFloat(k[1]));
      const highs4h   = k4h.map(k=>parseFloat(k[2]));
      const lows4h    = k4h.map(k=>parseFloat(k[3]));
      const volumes4h = k4h.map(k=>parseFloat(k[5]));
      const closes1d  = k1d.map(k=>parseFloat(k[4]));
      const highs1d   = k1d.map(k=>parseFloat(k[2]));
      const lows1d    = k1d.map(k=>parseFloat(k[3]));

      const rsi4h  = calcRSI(closes4h);
      const rsi1d  = calcRSI(closes1d);
      const ema20  = calcEMA(closes4h, 20);
      const ema50  = calcEMA(closes4h, 50);
      const ema200 = calcEMA(closes4h, 200);
      const macd   = calcMACD(closes4h);
      const bb     = calcBB(closes4h, 20);
      const atr    = calcATR(highs4h, lows4h, closes4h, 14);
      const vol    = analyzeVolume(volumes4h);
      const patterns = detectCandlePatterns(opens4h, highs4h, lows4h, closes4h);
      const { sup, res: resistance } = calcKeyLevels(highs4h, lows4h, closes4h);
      const { sup: supDay, res: resDay } = closes1d.length > 5
        ? calcKeyLevels(highs1d, lows1d, closes1d) : { sup, res: resistance };

      const price      = closes4h[closes4h.length-1];
      const ema50_1d   = calcEMA(closes1d, 50);
      const ema200_1d  = calcEMA(closes1d, 200);
      const macroTrend = ema50_1d && ema200_1d
        ? (ema50_1d>ema200_1d && price>ema50_1d ? 'ALCISTA'
          : ema50_1d<ema200_1d && price<ema50_1d ? 'BAJISTA' : 'LATERAL')
        : 'LATERAL';

      const { tag, cls } = rsiTag(rsi4h);

      MARKET_META[coin] = {
        tag, cls,
        rsi:     rsi4h ?? '—',
        rsi1d:   rsi1d ?? '—',
        sup:     fmtSup(sup, coin),
        res:     fmtSup(resistance, coin),
        supRaw:  sup, resRaw: resistance,
        supDay:  fmtSup(supDay, coin),
        resDay:  fmtSup(resDay, coin),
        ema:     { price, ema20: ema20?+ema20.toFixed(2):null, ema50: ema50?+ema50.toFixed(2):null, ema200: ema200?+ema200.toFixed(2):null },
        macd:    macd ? { macd:+macd.macd.toFixed(4), signal: macd.signal?+macd.signal.toFixed(4):null, hist: macd.hist?+macd.hist.toFixed(4):null } : null,
        bb:      bb   ? { price, upper:+bb.upper.toFixed(2), mid:+bb.mid.toFixed(2), lower:+bb.lower.toFixed(2), width:+bb.width.toFixed(1) } : null,
        atr:     atr  ? +atr.toFixed(4) : null,
        vol, patterns, macroTrend,
      };
      MARKET_META[coin].confluence = calcConfluence(MARKET_META[coin]);

      // Actualizar la pestaña Mercado con cada moneda que llega (progresivo)
      if (state.currentTab === 'mkt') renderMkt();

      // Ceder el hilo al navegador entre monedas para evitar bloqueo
      await new Promise(r => setTimeout(r, 0));

    } catch (e) {
      console.warn(`fetchMarketMeta ${coin}:`, e.message);
    }
  }
}

/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
  // persisted
  activeTrades: [],
  closedTrades: [],
  alerts:       [],
  strategy:     null,
  profile:      { ...DEFAULT_PROFILE },
  scanInterval: 5,
  watchedCoins: [...DEFAULT_WATCHED_COINS],

  // persisted new
  priceAlerts:  [],
  scanLog:      [],
  aiHistory:    [],
  darkMode:     false,
  goals:        [],
  onboarded:    false,

  // session
  prices:       {},
  prevPrices:   {},
  wsStatus:     'connecting',
  pending:      [],
  aiMsg:        null,
  currentTab:   'ops',
  scannerOn:    false,
  scanning:     false,
  lastScan:     null,
  notifPermission: Notification.permission,
  activeNotif:  null,
  scanTimer:    null,
  autoClosedIds: new Set(),
};

/* ── Storage helpers ─────────────────────────────────────────────────────── */
const storage = {
  get(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
    catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

function loadAll() {
  state.activeTrades = storage.get(STORAGE_KEYS.activeTrades)  ?? [];
  state.closedTrades = storage.get(STORAGE_KEYS.closedTrades)  ?? [];
  state.alerts       = storage.get(STORAGE_KEYS.alerts)        ?? [];
  state.strategy     = storage.get(STORAGE_KEYS.strategy)      ?? null;
  state.profile      = { ...DEFAULT_PROFILE, ...( storage.get(STORAGE_KEYS.profile) ?? {} ) };
  state.scanInterval = storage.get(STORAGE_KEYS.scanInterval)  ?? 5;
  state.watchedCoins = storage.get(STORAGE_KEYS.watchedCoins)  ?? [...DEFAULT_WATCHED_COINS];
  state.priceAlerts  = storage.get(STORAGE_KEYS.priceAlerts)   ?? [];
  state.scanLog      = storage.get(STORAGE_KEYS.scanLog)        ?? [];
  state.aiHistory    = storage.get(STORAGE_KEYS.aiHistory)      ?? [];
  state.darkMode     = storage.get(STORAGE_KEYS.darkMode)       ?? false;
  state.goals        = storage.get(STORAGE_KEYS.goals)          ?? [];
  state.onboarded    = storage.get(STORAGE_KEYS.onboarded)      ?? false;
}

function saveKey(key, value) { storage.set(STORAGE_KEYS[key], value); }

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const nowTime = () => new Date().toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });
const nowFull = () => new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });

function fmtP(price, coin) {
  if (!price && price !== 0) return '—';
  if (coin === 'XRP' || coin === 'DOGE') return '$' + (+price).toFixed(4);
  if (+price > 1000) return '$' + (+price).toLocaleString('en', { maximumFractionDigits: 1 });
  return '$' + (+price).toFixed(2);
}
function fmtUSD(n) {
  return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(2);
}
function coinOf(pair) { return (pair || '').split('/')[0]; }

function qs(sel, ctx = document) { return ctx.querySelector(sel); }
function qsa(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/* ── Toast ───────────────────────────────────────────────────────────────── */
let toastTimer;
function showToast(msg, err = false) {
  let t = qs('.toast');
  if (!t) { t = el('div', 'toast'); document.body.appendChild(t); }
  t.textContent = msg;
  t.style.background  = err ? 'rgba(255,77,109,.15)' : 'rgba(0,255,157,.12)';
  t.style.border      = `1px solid ${err ? 'rgba(255,77,109,.4)' : 'rgba(0,255,157,.3)'}`;
  t.style.color       = err ? 'var(--red)' : 'var(--green)';
  t.style.display     = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (t) t.style.display = 'none'; }, 3500);
}

/* ── Sincronización con servidor (TP/SL en background) ───────────────────── */
async function syncTradesToServer() {
  try {
    await authFetch('/api/trades/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeTrades: state.activeTrades }),
    });
  } catch (e) {
    console.warn('sync error:', e.message);
  }
}

async function pollServerClosedTrades() {
  try {
    const res  = await authFetch('/api/trades/closed-by-server');
    const data = await res.json();
    if (!data.closed || data.closed.length === 0) return;

    let changed = false;
    const confirmedIds = []; // IDs que confirmamos al servidor

    for (const closed of data.closed) {
      // ── FIX: dedup — si ya está en closedTrades, solo confirmamos y seguimos
      const alreadyInClosed = state.closedTrades.some(t => t.id === closed.id);
      if (alreadyInClosed) {
        confirmedIds.push(closed.id);
        continue;
      }

      // Verificar que aún está activa en el frontend
      const idx = state.activeTrades.findIndex(t => t.id === closed.id);
      if (idx === -1) {
        // El cliente ya la cerró antes (checkTPSL local) — solo confirmamos
        confirmedIds.push(closed.id);
        continue;
      }

      state.activeTrades.splice(idx, 1);
      state.closedTrades.unshift(closed);
      confirmedIds.push(closed.id);
      changed = true;

      showToast(
        closed.result === 'WIN'
          ? `✓ ${closed.par} cerrada en TP por servidor! +$${closed.pnl?.toFixed(2)}`
          : `✕ ${closed.par} SL alcanzado (servidor). -$${Math.abs(closed.pnl || 0).toFixed(2)}`,
        closed.result !== 'WIN'
      );
    }

    // ── FIX: confirmar recepción SOLO si tenemos IDs que reportar.
    // El servidor borra estos trades de su lista solo tras recibir esta confirmación.
    // Si la red falla antes de llegar aquí, el servidor los conserva y los reenvía en el próximo poll.
    if (confirmedIds.length > 0) {
      await authFetch('/api/trades/confirm-closed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: confirmedIds }),
      }).catch(e => console.warn('confirm-closed error:', e.message));
    }

    if (changed) {
      saveKey('activeTrades', state.activeTrades);
      saveKey('closedTrades', state.closedTrades);
      renderAll();
    }
  } catch (e) {
    console.warn('poll error:', e.message);
  }
}

/* ── WebSocket del servidor: push de TP/SL en tiempo real ───────────────── */
// En lugar de polling cada 10s, el servidor notifica al instante via WS
let serverWs, serverWsRetry;

function connectServerWS() {
  clearTimeout(serverWsRetry);
  const token    = getAuthToken();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url      = `${protocol}//${location.host}/ws${token ? '?token=' + token : ''}`;
  try { serverWs = new WebSocket(url); } catch { return; }

  serverWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'TRADE_CLOSED')   handleServerTradeClosed(msg.trade);
      if (msg.type === 'SCANNER_ALERT')  handleServerScannerAlert(msg.alert);
    } catch {}
  };
  serverWs.onclose = () => { serverWsRetry = setTimeout(connectServerWS, 8000); };
  serverWs.onerror = () => {};
}

function handleServerScannerAlert(alert) {
  // Evitar duplicados
  if (state.alerts.some(a => a.id === alert.id)) return;
  // Añadir a la lista de alertas con status pending
  state.alerts.unshift({ ...alert, status: 'pending' });
  if (state.alerts.length > 30) state.alerts.pop();
  saveKey('alerts', state.alerts);
  // Notificación visual inmediata
  showScreenNotif(alert);
  renderAlerts();
  // Actualizar badge del tab
  updateScannerBadge();
}

/* ── Control del escáner server-side desde el frontend ─────────────────── */
async function startServerScanner() {
  try {
    const res = await authFetch('/api/scanner/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: state.profile }),
    });
    const data = await res.json();
    if (data.ok) {
      state.scannerActive = true;
      saveKey('scannerActive', true);
      showToast(`🔍 Escáner SERVER activo — cada ${data.intervalMin} min (24/7)`);
      updateScannerBadge();
    }
  } catch (e) {
    showToast('Error iniciando escáner: ' + e.message, true);
  }
}

async function stopServerScanner() {
  try {
    await authFetch('/api/scanner/stop', { method: 'POST' });
    state.scannerActive = false;
    saveKey('scannerActive', false);
    showToast('⏹ Escáner detenido');
    updateScannerBadge();
  } catch {}
}

async function checkServerScannerStatus() {
  if (!state.scannerActive) return;
  try {
    const res  = await authFetch('/api/scanner/status');
    const data = await res.json();
    if (data.ok) {
      // Sincronizar estado
      state.scannerActive = data.enabled;
    }
  } catch {}
}

function updateScannerBadge() {
  const btn = document.getElementById('scanner-toggle-btn');
  if (!btn) return;
  btn.textContent  = state.scannerActive ? '⏹ DETENER ESCÁNER' : '▶ ESCÁNER 24/7';
  btn.style.background = state.scannerActive ? 'rgba(255,59,88,.2)' : '';
  btn.style.borderColor = state.scannerActive ? 'rgba(255,59,88,.5)' : '';
  btn.style.color = state.scannerActive ? 'var(--red)' : '';
}

async function toggleServerScanner() {
  if (state.scannerActive) {
    await stopServerScanner();
  } else {
    await startServerScanner();
  }
  // Re-render del panel de alertas para reflejar el estado
  if (state.currentTab === 'alerts') renderAlerts();
}


function handleServerTradeClosed(closed) {
  if (state.closedTrades.some(t => t.id === closed.id)) return; // ya cerrado localmente
  const idx = state.activeTrades.findIndex(t => t.id === closed.id);
  if (idx !== -1) state.activeTrades.splice(idx, 1);
  state.closedTrades.unshift(closed);
  saveKey('activeTrades', state.activeTrades);
  saveKey('closedTrades', state.closedTrades);
  showToast(
    closed.result === 'WIN'
      ? `✓ ${closed.par} cerrada en TP! +$${closed.pnl?.toFixed(2)}`
      : `✕ ${closed.par} SL alcanzado. -$${Math.abs(closed.pnl || 0).toFixed(2)}`,
    closed.result !== 'WIN'
  );
  authFetch('/api/trades/confirm-closed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [closed.id] }),
  }).catch(() => {});
  renderAll();
}

/* ── Binance WebSocket ───────────────────────────────────────────────────── */
let ws, wsRetryTimer;

function connectWS() {
  if (ws) { try { ws.close(); } catch {} }
  clearTimeout(wsRetryTimer);
  setWsStatus('connecting');
  ws = new WebSocket(buildWsUrl(state.watchedCoins));

  ws.onopen = () => setWsStatus('live');

  ws.onmessage = (e) => {
    const { data: d } = JSON.parse(e.data);
    if (!d) return;
    const coin  = d.s.replace('USDT', '');
    const price = parseFloat(d.c);
    state.prevPrices[coin] = state.prices[coin] || price;
    state.prices[coin] = price;
    onPriceUpdate(coin, price);
  };

  ws.onerror = () => setWsStatus('error');
  ws.onclose = () => {
    setWsStatus('error');
    wsRetryTimer = setTimeout(connectWS, 4000);
  };
}

function setWsStatus(s) {
  state.wsStatus = s;
  const dot   = qs('.ws-dot');
  const label = qs('#ws-label');
  if (dot) { dot.className = 'ws-dot ' + s; }
  if (label) {
    label.textContent = s === 'live' ? 'BINANCE LIVE' : s === 'connecting' ? 'CONECTANDO...' : 'RECONECTANDO';
    label.style.color = s === 'live' ? 'var(--green)' : s === 'connecting' ? 'var(--yellow)' : 'var(--red)';
  }
  const genBtn = qs('#btn-gen');
  if (genBtn) genBtn.disabled = s !== 'live';
}

function onPriceUpdate(coin, price) {
  renderTicker();
  checkTPSL();
  checkPriceAlerts();
  updateTradesPnl();
  renderBalanceWidget();
  if (state.currentTab === 'mkt') updateMarketPrice(coin, price);
}

/* ── Claude API (proxy seguro vía servidor) ──────────────────────────────── */
async function callClaude(prompt, system, useHistory = false) {
  // Construir mensajes con historial si se pide
  let messages;
  if (useHistory && state.aiHistory.length > 0) {
    // Últimos 6 intercambios (12 mensajes) para no exceder tokens
    messages = [...state.aiHistory.slice(-12), { role: 'user', content: prompt }];
  } else {
    messages = [{ role: 'user', content: prompt }];
  }

  const res = await authFetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system,
      messages,
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error del servidor');
  const reply = data.content[0]?.text || '';

  // Guardar en historial si se usa
  if (useHistory) {
    state.aiHistory.push({ role: 'user', content: prompt });
    state.aiHistory.push({ role: 'assistant', content: reply });
    if (state.aiHistory.length > 20) state.aiHistory = state.aiHistory.slice(-20);
    saveKey('aiHistory', state.aiHistory);
  }

  return reply;
}

function parseJSON(raw) {
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    // Si el JSON viene truncado, intenta repararlo buscando el último objeto completo
    const clean = raw.replace(/```json|```/g, '').trim();
    // Buscar el último } o ] válido
    for (let i = clean.length - 1; i >= 0; i--) {
      if (clean[i] === '}' || clean[i] === ']') {
        try {
          return JSON.parse(clean.slice(0, i + 1));
        } catch {}
      }
    }
    throw new Error('No se pudo parsear la respuesta IA: ' + e.message);
  }
}

/* ── Contexto técnico completo para prompts ──────────────────────────────── */
function buildTechContext() {
  const btcMeta = MARKET_META['BTC'];
  const btcTrend = btcMeta ? `BTC tendencia macro: ${btcMeta.macroTrend} (RSI 1D: ${btcMeta.rsi1d})` : '';

  const lines = state.watchedCoins.map(coin => {
    const meta  = MARKET_META[coin];
    const price = state.prices[coin];
    if (!meta || !price) return null;

    const p = (v, d=2) => v != null ? (+v).toFixed(d) : '?';
    const conf = meta.confluence;

    // EMAs
    const emaLine = meta.ema
      ? `EMA20=${p(meta.ema.ema20)} EMA50=${p(meta.ema.ema50)} EMA200=${p(meta.ema.ema200)} | precio ${price>meta.ema.ema50?'SOBRE':'BAJO'} EMA50 ${price>meta.ema.ema200?'SOBRE':'BAJO'} EMA200`
      : '';

    // MACD
    const macdLine = meta.macd
      ? `MACD=${p(meta.macd.macd,4)} Señal=${p(meta.macd.signal,4)} Hist=${p(meta.macd.hist,4)} (${meta.macd.hist>0?'ALCISTA':'BAJISTA'})`
      : '';

    // BB
    const bbLine = meta.bb
      ? `BB: lower=${p(meta.bb.lower)} mid=${p(meta.bb.mid)} upper=${p(meta.bb.upper)} ancho=${p(meta.bb.width,1)}% | precio ${price<meta.bb.lower?'BAJO BANDA — sobreventa extrema':price>meta.bb.upper?'SOBRE BANDA — sobrecompra extrema':price<meta.bb.mid?'bajo media BB':'sobre media BB'}`
      : '';

    // ATR → SL sugerido
    const atrLine = meta.atr
      ? `ATR(14)=${p(meta.atr,4)} → SL mínimo recomendado: ${p(meta.atr*1.5,4)} (1.5×ATR)`
      : '';

    // Volumen
    const volLine = meta.vol
      ? `Vol: ${meta.vol.ratio}× avg20 (${meta.vol.signal}), tendencia ${meta.vol.trending}`
      : '';

    // Patrones
    const pattLine = meta.patterns?.length > 0
      ? `Patrón última vela: ${meta.patterns.map(p=>p.name+' '+p.bias+' '+p.strength).join(', ')}`
      : 'Sin patrón destacado';

    // Confluencia
    const confLine = conf
      ? `CONFLUENCIA: ${conf.score}% alcista (${conf.bull} señales alcistas, ${conf.bear} bajistas) → SESGO ${conf.bias}`
      : '';

    return [
      `\n── ${coin}/USDT ──`,
      `Precio: $${price} | Tendencia macro 1D: ${meta.macroTrend} | RSI 1D: ${meta.rsi1d}`,
      `RSI 4H: ${meta.rsi} | Soporte 4H: ${meta.sup} | Resistencia 4H: ${meta.res}`,
      `Soporte diario: ${meta.supDay} | Resistencia diaria: ${meta.resDay}`,
      emaLine, macdLine, bbLine, atrLine, volLine, pattLine, confLine,
    ].filter(Boolean).join('\n');
  }).filter(Boolean);

  return [btcTrend, ...lines].join('\n');
}

function buildTradeHistory() {
  const { closedTrades } = state;
  if (closedTrades.length === 0) return 'Sin historial de operaciones.';
  const wins     = closedTrades.filter(t => t.result === 'WIN').length;
  const winRate  = (wins / closedTrades.length * 100).toFixed(0);
  const totalPnl = closedTrades.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2);
  const recent   = closedTrades.slice(0, 6).map(t =>
    `${t.par} ${t.tipo} ${t.result} PnL:$${(t.pnl||0).toFixed(0)}${t.notes ? ` [nota: ${t.notes}]` : ''}`
  ).join(' | ');
  return `WinRate: ${winRate}% (${wins}G/${closedTrades.length-wins}P) | P&L total: $${totalPnl}\nÚltimas ops: ${recent}`;
}

async function aiGenerateProposals() {
  const { profile, strategy } = state;
  const techCtx      = buildTechContext();
  const tradeHistory = buildTradeHistory();
  const feasibleCtx  = buildFeasibleCoinsContext();

  const raw = await callClaude(
    `Eres un analista técnico senior de criptomonedas. Genera 2-3 propuestas de trading de ALTA CALIDAD basadas en los datos técnicos REALES adjuntos.

━━━ PERFIL DEL TRADER ━━━
Estilo: ${profile.style} | Riesgo: ${profile.risk_tolerance}
Capital: $${profile.capital} | Riesgo/op: ${profile.risk_pct}% = $${(profile.capital*profile.risk_pct/100).toFixed(2)}
Apalancamiento: ${profile.leverage||1}x | Monedas preferidas: ${profile.preferred_coins.join(', ')||'BTC, ETH'}
Estrategia activa: ${strategy?.estrategiaAdaptada?.estiloRecomendado||'swing'} en ${strategy?.estrategiaAdaptada?.timeframe||'4H'}
Notas del trader: ${profile.notes||'ninguna'}

━━━ HISTORIAL ━━━
${tradeHistory}

━━━ CALENDARIO ECONÓMICO (próx. 48h) ━━━
${buildCalendarContext()}
${feasibleCtx}
━━━ DATOS TÉCNICOS REALES BINANCE ━━━
${techCtx}

━━━ REGLAS DE ANÁLISIS (SEGUIR ESTRICTAMENTE) ━━━
1. CAPITAL PRIMERO: Si existe la sección "RESTRICCIÓN DE CAPITAL", SOLO propón monedas de la lista EJECUTABLES. Es la regla más importante.
2. CONFLUENCIA MÍNIMA: Solo propón setups con ≥3 señales alineadas (RSI+EMA+MACD+BB+patrón+volumen)
3. TENDENCIA MACRO: Si la tendencia 1D es BAJISTA, solo SHORT o no operar. Si ALCISTA, preferir LONG.
4. EMA FILTER: No entrar LONG si precio < EMA200 en 4H. No entrar SHORT si precio > EMA200.
5. SL BASADO EN ATR: El SL DEBE ser al menos 1.5×ATR desde la entrada, y estar al otro lado del soporte/resistencia más cercano.
6. TP EN NIVELES REALES: TP1 = siguiente resistencia/soporte real. TP2 = siguiente nivel macro.
7. R:R MÍNIMO 2.0: Rechaza setups con R:R menor a 2. Con apalancamiento > 3x exige R:R ≥ 2.5.
8. VOLUMEN: Si el volumen es BAJO en el setup, reduce la confianza al menos 10 puntos.
9. NO REPETIR: Si tienes historial de conversación, no proponer el mismo par en la misma dirección.

Responde SOLO JSON sin markdown:
{
  "proposals": [{
    "par": "BTC/USDT",
    "tipo": "LONG",
    "setup": "RSI4H=28 sobrevendido + Engulfing Alcista + precio bajo BB inferior + sobre EMA200",
    "entrada": 70500,
    "stopLoss": 68900,
    "tp1": 73500,
    "tp2": 76000,
    "rr": "2.2",
    "confianza": 76,
    "confluence_score": 72,
    "signals_aligned": ["RSI sobrevendido","Engulfing alcista fuerte","Precio bajo BB inferior","Tendencia macro alcista","MACD hist positivo"],
    "signals_against": ["Volumen bajo media"],
    "atr_sl": 1600,
    "razon": "RSI4H=28 en zona crítica de sobrecompra, patrón Engulfing alcista fuerte confirmando reversión en soporte diario $68.9K. EMA200 a $67.1K como suelo macro. MACD hist virando positivo. TP1 en resistencia 4H $73.5K, TP2 en resistencia diaria $76K."
  }],
  "analisis_mercado": "Resumen técnico preciso del mercado con BTC como referencia.",
  "recomendacion_ia": "Consejo específico y personalizado para este trader basado en su historial y perfil."
}`,
    'Eres analista técnico senior de criptomonedas. Usas análisis multitimeframe, confluencia de indicadores y gestión del riesgo profesional. Responde SOLO con JSON válido sin markdown ni texto extra.',
    true
  );
  return parseJSON(raw);
}

async function aiScanMarket() {
  const { profile, strategy, alerts, activeTrades } = state;
  const techCtx      = buildTechContext();
  const tradeHistory = buildTradeHistory();
  const recentAlerts = alerts.slice(0, 5).map(a => `${a.par} ${a.tipo} entrada=${a.entrada} (${a.timestamp})`).join(' | ');
  const feasibleCtx  = buildFeasibleCoinsContext();

  const raw = await callClaude(
    `Eres un escáner de mercado automático. Analiza los datos técnicos AHORA y decide si existe una oportunidad de trading de ALTA CALIDAD.

━━━ DATOS TÉCNICOS REALES BINANCE ━━━
${techCtx}

━━━ CONTEXTO ━━━
Perfil: ${profile.style}, riesgo ${profile.risk_tolerance}, capital $${profile.capital}, leverage ${profile.leverage||1}x
Historial: ${tradeHistory}
Calendario económico: ${buildCalendarContext()}
Estrategia activa: ${strategy?.estrategiaAdaptada?.estiloRecomendado||'swing'} ${strategy?.estrategiaAdaptada?.timeframe||'4H'}
Alertas recientes (NO duplicar mismo par+dirección): ${recentAlerts||'ninguna'}
Posiciones abiertas: ${activeTrades.length}
${feasibleCtx}
━━━ CRITERIOS ESTRICTOS PARA hay_oportunidad=true ━━━
Todos deben cumplirse:
1. CAPITAL: La moneda debe estar en la lista EJECUTABLES (si existe esa sección). Es el criterio más importante.
2. CONFLUENCIA ≥60%: Al menos 3 señales alineadas entre RSI, EMA, MACD, BB, patrón de vela y volumen
3. TENDENCIA MACRO: El trade va en dirección de la tendencia 1D
4. R:R ≥ 2.0: Usando ATR y niveles reales de soporte/resistencia
5. Sin alerta reciente del mismo par y dirección en las últimas alertas
6. Volumen confirma (ratio ≥ 0.8× media)
7. EMA200 del lado correcto (LONG = precio > EMA200, SHORT = precio < EMA200)

Si no se cumplen TODOS: hay_oportunidad=false

Responde SOLO JSON:
{"hay_oportunidad":true,"urgencia":"ALTA","par":"ETH/USDT","tipo":"LONG","setup":"RSI28+Engulfing+BajoBB+TendAlcista","entrada":2015,"stopLoss":1940,"tp1":2150,"tp2":2280,"rr":"2.1","confianza":81,"confluence_score":73,"signals_aligned":["RSI4H=28","Engulfing alcista","Precio bajo BB","EMA200 soporte","MACD virando"],"razon":"RSI4H=28 sobrevendido. Engulfing alcista fuerte con volumen 1.4× media. Precio bajo BB inferior en soporte diario $1.94K. EMA200 a $1.89K como suelo macro. TP1 resistencia 4H $2.15K.","contexto_mercado":"Descripción concisa del estado del mercado global."}
Si NO hay oportunidad: {"hay_oportunidad":false,"razon":"motivo técnico concreto y específico"}`,
    'Eres escáner técnico de criptomonedas muy selectivo y preciso. Solo detectas oportunidades con confluencia alta y gestión del riesgo profesional. Responde SOLO con JSON válido sin markdown.'
  );
  return parseJSON(raw);
}

async function aiAdaptStrategy() {
  const { profile, closedTrades } = state;
  const techCtx = buildTechContext();
  const wins    = closedTrades.filter(t => t.result === 'WIN').length;

  const byPair = {};
  closedTrades.forEach(t => {
    if (!byPair[t.par]) byPair[t.par] = { wins:0, total:0, pnl:0, setups:[] };
    byPair[t.par].total++;
    byPair[t.par].pnl += t.pnl||0;
    if (t.result==='WIN') byPair[t.par].wins++;
    if (t.setup) byPair[t.par].setups.push(t.setup);
  });
  const pairStats = Object.entries(byPair)
    .map(([par,s]) => `${par}: ${s.wins}/${s.total} WR=${(s.wins/s.total*100).toFixed(0)}% P&L=$${s.pnl.toFixed(0)}`)
    .join(' | ');

  // Análisis de setups ganadores vs perdedores
  const winSetups  = closedTrades.filter(t=>t.result==='WIN').map(t=>t.setup).filter(Boolean);
  const lossSetups = closedTrades.filter(t=>t.result==='LOSS').map(t=>t.setup).filter(Boolean);

  const raw = await callClaude(
    `Analiza el historial real de este trader y genera una estrategia adaptada con reglas concretas.

━━━ HISTORIAL COMPLETO ━━━
WinRate: ${closedTrades.length>0?(wins/closedTrades.length*100).toFixed(0):0}% | ${wins}W/${closedTrades.length-wins}L | ${closedTrades.length} ops total
P&L total: $${closedTrades.reduce((a,t)=>a+(t.pnl||0),0).toFixed(2)}
Por par: ${pairStats||'sin datos suficientes'}
Setups ganadores frecuentes: ${winSetups.slice(0,5).join(', ')||'N/A'}
Setups perdedores frecuentes: ${lossSetups.slice(0,5).join(', ')||'N/A'}
Últimas 10 ops: ${closedTrades.slice(0,10).map(t=>`${t.par} ${t.tipo} ${t.result} PnL:$${(t.pnl||0).toFixed(0)}${t.notes?` [${t.notes}]`:''}`).join(' | ')}

━━━ PERFIL ━━━
Estilo: ${profile.style} | Riesgo: ${profile.risk_tolerance} | Capital: $${profile.capital} | Leverage: ${profile.leverage||1}x
Notas: ${profile.notes||'ninguna'}

━━━ CONTEXTO TÉCNICO ACTUAL ━━━
${techCtx}

Genera una estrategia adaptada con reglas MUY CONCRETAS y accionables. Las reglas deben ser checkboxes que el trader pueda verificar antes de entrar.

Responde SOLO JSON:
{"diagnostico":"Análisis honesto del rendimiento actual.","fortalezas":["Descripción concreta"],"debilidades":["Descripción concreta"],"alertas":["Riesgo específico detectado"],"cambios":[{"area":"Gestión de riesgo","descripcion":"Bajar riesgo a 1.5% por operación dado el drawdown reciente","impacto":"ALTO"}],"estrategiaAdaptada":{"estiloRecomendado":"Swing","timeframe":"4H","riesgoRecomendado":2,"activos":["BTC","ETH"],"resumen":"Descripción clara de la estrategia adaptada.","reglas":["Solo entrar si RSI < 35 en 4H","Confirmar con MACD histograma positivo","SL siempre 1.5×ATR","No más de 2 posiciones simultáneas"]}}`,
    'Eres coach de trading profesional. Das análisis honestos y consejos concretos y accionables basados en datos reales. Responde SOLO con JSON válido.'
  );
  return parseJSON(raw);
}

/* ══════════════════════════════════════════════════════════
   BITUNIX INTEGRATION
   ══════════════════════════════════════════════════════════ */

// Estado Bitunix
const bitunix = {
  configured: false,   // si las API keys están en el servidor
  account:    null,    // datos de cuenta reales
  positions:  [],      // posiciones abiertas reales
  lastSync:   0,
};

/* Comprueba si Bitunix está configurado */
async function checkBitunixStatus() {
  try {
    const res  = await authFetch('/api/bitunix/status');
    const data = await res.json();
    bitunix.configured = !!data.configured;
  } catch { bitunix.configured = false; }
  return bitunix.configured;
}

/* Fetch saldo real de Bitunix */
async function fetchBitunixAccount() {
  if (!bitunix.configured) return null;
  try {
    const res  = await authFetch('/api/bitunix/account');
    const data = await res.json();
    if (data.ok && data.account) {
      bitunix.account  = data.account;
      bitunix.lastSync = Date.now();
      console.log('[Bitunix account campos]', Object.keys(data.account));
      console.log('[Bitunix account valores]', data.account);

      // Leer equity real (incluye PnL no realizado = valor real de la cuenta)
      const equity = parseFloat(
        data.account.equity          ??
        data.account.totalEquity     ??
        data.account.walletBalance   ??
        data.account.totalBalance    ??
        data.account.balance         ?? 0
      );
      // Fallback: saldo disponible si no hay equity
      const available = parseFloat(
        data.account.available        ??
        data.account.availableBalance ??
        data.account.availAmt         ??
        data.account.freeBalance      ??
        data.account.free             ?? 0
      );

      // Preferir equity sobre available para cálculos de riesgo más precisos
      const realCapital = equity > 0 ? equity : available;
      if (realCapital > 0) {
        const prev = state.profile.capital;
        state.profile.capital = parseFloat(realCapital.toFixed(2));
        saveKey('profile', state.profile);
        // Notificar si el capital cambió significativamente (>1%)
        if (prev > 0 && Math.abs(realCapital - prev) / prev > 0.01) {
          const diff = realCapital - prev;
          showToast(`💼 Capital actualizado: $${realCapital.toFixed(2)} (${diff >= 0 ? '+' : ''}$${diff.toFixed(2)})`, false);
        }
      }
    } else {
      console.warn('[Bitunix account] respuesta sin datos:', data);
      bitunix.accountError = data.error || 'Sin datos';
    }
    return bitunix.account;
  } catch (e) {
    console.warn('fetchBitunixAccount:', e.message);
    bitunix.accountError = e.message;
    return null;
  }
}

/* Fetch posiciones abiertas de Bitunix y las sincroniza con activeTrades */
async function syncBitunixPositions() {
  if (!bitunix.configured) return;
  try {
    const res  = await authFetch('/api/bitunix/positions');
    const data = await res.json();
    if (!data.ok) return;

    bitunix.positions = data.positions || [];

    // Marcar trades locales que tienen una posición real en Bitunix
    bitunix.positions.forEach(pos => {
      const symbol = pos.symbol?.replace('USDT', ''); // "BTCUSDT" → "BTC"
      const side   = pos.side === 'BUY' ? 'LONG' : 'SHORT';
      const match  = state.activeTrades.find(t =>
        coinOf(t.par) === symbol && t.tipo === side
      );
      if (match) {
        match.bitunixPos     = true;
        match.bitunixSymbol  = pos.symbol;
        match.unrealizedPnl  = parseFloat(pos.unrealizedPnl || 0);
        match.bitunixQty     = parseFloat(pos.qty || 0);
        match.bitunixSide    = pos.side;
      }
    });

    renderAll();
  } catch (e) {
    console.warn('syncBitunixPositions:', e.message);
  }
}

/* Calcular qty en unidades base para Bitunix dado el riskUSD y precio */
function calcBitunixQty(riskUSD, entry, stopLoss, leverage, symbol) {
  // Para BTC y ETH: qty en contratos (unidades de la moneda base)
  // Fórmula: qty = riskUSD / (|entry - sl| * leverage)
  const dist = Math.abs(entry - stopLoss);
  if (dist === 0) return 0;
  const qty = riskUSD / (dist * leverage);
  // Redondear según el par: BTC 3 decimales, resto 2
  const decimals = symbol?.startsWith('BTC') ? 3 : 2;
  return parseFloat(qty.toFixed(decimals));
}

/* Ejecutar orden en Bitunix */
async function placeBitunixOrder(trade) {
  const symbol   = coinOf(trade.par) + 'USDT';
  const side     = trade.tipo === 'LONG' ? 'BUY' : 'SELL';
  const leverage = trade.leverage || 1;
  const qty      = calcBitunixQty(trade.riskUSD, trade.entrada, trade.stopLoss, leverage, symbol);

  if (qty <= 0) {
    showToast('⚠️ Qty calculada es 0 — revisa SL y capital', true);
    return null;
  }

  // TP1 = cierre real en Bitunix (orden automática en el exchange)
  // TP2 = objetivo visual en la app — cuando se alcance TP1 ya estarás fuera
  const tpPrice = trade.tp1 || null;

  showToast(`📡 Enviando orden ${symbol} ${side} qty=${qty} TP=${tpPrice} SL=${trade.stopLoss}...`);

  try {
    const res  = await authFetch('/api/bitunix/place-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol,
        qty:           qty,
        side,
        leverage,
        orderType:     'MARKET',
        tpPrice:       tpPrice,
        slPrice:       trade.stopLoss || null,
        clientOrderId: trade.id,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      trade.bitunixOrderId = data.orderId;
      trade.bitunixSymbol  = symbol;
      trade.bitunixQty     = qty;
      showToast(`✅ Orden ejecutada — TP1 ${fmtP(tpPrice, coinOf(trade.par))} · SL ${fmtP(trade.stopLoss, coinOf(trade.par))} · ID ${data.orderId}`);
      saveKey('activeTrades', state.activeTrades);
      setTimeout(syncBitunixPositions, 3000);
    } else {
      showToast(`❌ Error Bitunix: ${data.error}`, true);
    }
    return data;
  } catch (e) {
    showToast(`❌ Error enviando a Bitunix: ${e.message}`, true);
    return null;
  }
}

/* Flash close en Bitunix */
async function flashCloseBitunix(trade) {
  const symbol = trade.bitunixSymbol || (coinOf(trade.par) + 'USDT');
  const side   = trade.tipo === 'LONG' ? 'LONG' : 'SHORT';
  try {
    const res  = await authFetch('/api/bitunix/close-position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, side }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`✅ Posición cerrada en Bitunix`);
    } else {
      showToast(`⚠️ Error cerrando en Bitunix: ${data.error}`, true);
    }
    return data;
  } catch (e) {
    showToast(`⚠️ No se pudo cerrar en Bitunix: ${e.message}`, true);
    return null;
  }
}

/* Actualiza el SL de una posición abierta en Bitunix (para breakeven) */
async function updateBitunixSL(trade) {
  try {
    const res  = await authFetch('/api/bitunix/update-sl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol:   trade.bitunixSymbol || (coinOf(trade.par) + 'USDT'),
        side:     trade.tipo === 'LONG' ? 'LONG' : 'SHORT',
        slPrice:  trade.stopLoss,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[Breakeven] SL actualizado en Bitunix → ${trade.stopLoss}`);
    } else {
      console.warn('[Breakeven] Error actualizando SL en Bitunix:', data.error);
    }
    return data;
  } catch (e) {
    console.warn('[Breakeven] updateBitunixSL error:', e.message);
    return null;
  }
}


/* ── Widget de saldo ─────────────────────────────────────────────────────── */
function calcEquity() {
  const { profile, closedTrades, activeTrades, prices } = state;
  const closedPnl = closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const activePnl = activeTrades.reduce((acc, t) => {
    const coin = coinOf(t.par);
    const p    = prices[coin] || t.entrada;
    const lev  = t.leverage || 1;
    const pnl  = t.tipo === 'LONG'
      ? (p - t.entrada) * t.size * lev
      : (t.entrada - p) * t.size * lev;
    return acc + pnl;
  }, 0);
  return {
    capital:    profile.capital,
    closedPnl,
    activePnl,
    total:      profile.capital + closedPnl + activePnl,
  };
}

function renderBalanceWidget() {
  const w = qs('#balance-widget');
  if (!w) return;
  const { capital, closedPnl, activePnl, total } = calcEquity();
  const totalPnl   = closedPnl + activePnl;
  const totalColor = totalPnl >= 0 ? 'var(--green)' : 'var(--red)';
  const totalSign  = totalPnl >= 0 ? '+' : '';

  const acc = bitunix.account;

  // Leer equity/balance/disponible con todos los posibles nombres de campo
  function readField(obj, ...keys) {
    if (!obj) return null;
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
        const v = parseFloat(obj[k]);
        if (!isNaN(v)) return v;
      }
    }
    return null;
  }

  const realEquity    = readField(acc, 'equity', 'totalEquity', 'walletBalance', 'balance', 'totalBalance');
  const realAvailable = readField(acc, 'available', 'availableBalance', 'availAmt', 'freeBalance', 'free', 'availableMargin');
  const realUnPnl     = readField(acc, 'crossUnPnl', 'unrealizedPnl', 'unPnl', 'unrealisedPnl', 'totalUnrealizedProfit');
  const realBalance   = readField(acc, 'balance', 'walletBalance', 'totalBalance', 'totalWalletBalance');

  const hasRealData = acc && (realEquity !== null || realAvailable !== null);

  const badgeColor = bitunix.configured ? (hasRealData ? 'var(--green)' : 'var(--yellow)') : 'var(--muted)';
  const badgeBg    = bitunix.configured ? (hasRealData ? 'rgba(130,173,143,.15)' : 'rgba(200,170,80,.15)') : 'var(--s2)';
  const badgeBorder= bitunix.configured ? (hasRealData ? 'rgba(130,173,143,.3)' : 'rgba(200,170,80,.3)') : 'var(--border)';
  const badgeLabel = bitunix.configured ? (hasRealData ? '🔗 Bitunix Live' : '⚠️ Sin datos') : '🔌 Conectar Bitunix';
  const badgeClick = bitunix.configured && !hasRealData
    ? `onclick="showBitunixDebug()"`
    : (!bitunix.configured ? `onclick="showBitunixSetup()"` : '');

  const bitunixBadge = `<span style="font-size:9px;padding:2px 7px;border-radius:4px;background:${badgeBg};border:1px solid ${badgeBorder};color:${badgeColor};margin-left:8px;cursor:${badgeClick ? 'pointer' : 'default'}" ${badgeClick}>${badgeLabel}</span>`;

  const mainValue = hasRealData ? (realEquity ?? realAvailable ?? 0) : total;
  const mainLabel = hasRealData ? 'Equity Real Bitunix' : 'Saldo estimado';

  w.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="display:flex;flex-direction:column;gap:1px">
          <span style="font-size:9px;color:var(--muted);font-weight:500;letter-spacing:.8px;text-transform:uppercase;display:flex;align-items:center">
            ${mainLabel}${bitunixBadge}
          </span>
          <span style="font-family:var(--serif);font-size:16px;font-weight:600;color:var(--text);line-height:1">
            $${mainValue.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}
          </span>
        </div>
        <div style="width:1px;height:28px;background:var(--border)"></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          ${hasRealData ? `
            ${realAvailable !== null ? `<div style="display:flex;flex-direction:column;gap:1px">
              <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">Disponible</span>
              <span style="font-size:12px;font-weight:600;color:var(--text)">$${realAvailable.toFixed(2)}</span>
            </div>` : ''}
            ${realBalance !== null ? `<div style="display:flex;flex-direction:column;gap:1px">
              <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">Balance</span>
              <span style="font-size:12px;font-weight:600;color:var(--text)">$${realBalance.toFixed(2)}</span>
            </div>` : ''}
            ${realUnPnl !== null ? `<div style="display:flex;flex-direction:column;gap:1px">
              <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">P&L no realizado</span>
              <span style="font-size:12px;font-weight:600;color:${realUnPnl>=0?'var(--green)':'var(--red)'}">${realUnPnl>=0?'+':''}$${realUnPnl.toFixed(2)}</span>
            </div>` : ''}
          ` : `
            <div style="display:flex;flex-direction:column;gap:1px">
              <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">P&L cerrado</span>
              <span style="font-size:12px;font-weight:600;color:${closedPnl>=0?'var(--green)':'var(--red)'}">${closedPnl>=0?'+':''}$${closedPnl.toFixed(2)}</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:1px">
              <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">P&L activo</span>
              <span style="font-size:12px;font-weight:600;color:${activePnl>=0?'var(--green)':'var(--red)'}">${activePnl>=0?'+':''}$${activePnl.toFixed(2)}</span>
            </div>
          `}
          <div style="display:flex;flex-direction:column;gap:1px">
            <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">P&L total app</span>
            <span style="font-size:12px;font-weight:600;color:${totalColor}">${totalSign}$${totalPnl.toFixed(2)}</span>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${bitunix.configured ? `<button onclick="refreshBitunixData()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:10px;color:var(--muted);cursor:pointer">↻ Sync</button>
        <button onclick="showBitunixDebug()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:10px;color:var(--muted);cursor:pointer">🔍 Debug</button>` : ''}
        <span style="font-size:9px;color:var(--muted)">Capital: $${capital.toLocaleString('en')}</span>
        <button onclick="toggleBalanceEdit()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:10px;color:var(--muted);cursor:pointer">✏ Editar</button>
      </div>
    </div>
    <div id="balance-quick-edit" style="display:none;margin-top:8px;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--muted)">Capital:</span>
      <input class="inp" type="number" id="balance-input" value="${capital}" step="any" style="width:120px;padding:5px 8px;font-size:12px"/>
      <button class="btn btng" style="padding:5px 12px;font-size:11px" onclick="saveQuickCapital()">✓ Guardar</button>
      <button onclick="toggleBalanceEdit()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:18px;line-height:1">×</button>
    </div>
    ${bitunix.configured ? (() => {
      const { feasible, infeasible } = buildFeasibleCoins();
      if (!feasible.length && !infeasible.length) return '';
      const fChips = feasible.map(f =>
        `<span title="Margen ~$${f.margin} · Posición ~$${f.notional}" style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(0,209,122,.1);border:1px solid rgba(0,209,122,.25);color:var(--green)">${f.coin}</span>`
      ).join('');
      const iChips = infeasible.slice(0,4).map(f =>
        `<span title="Capital mínimo ~$${f.minCapitalNeeded}" style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(255,59,88,.08);border:1px solid rgba(255,59,88,.2);color:var(--muted);text-decoration:line-through">${f.coin}</span>`
      ).join('');
      return `<div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-size:9px;color:var(--muted);letter-spacing:.4px">EJECUTABLES:</span>
        ${fChips || '<span style="font-size:9px;color:var(--red)">ninguna — aumenta capital o leverage</span>'}
        ${iChips ? `<span style="font-size:9px;color:var(--subtle)">|</span>${iChips}` : ''}
      </div>`;
    })() : ''}`;
}
function calcSize(riskUSD, entry, stopLoss, leverage = 1) {
  // Con apalancamiento: la posición efectiva se multiplica, pero el riesgo en USD no cambia.
  // Unidades = riesgo / (distancia_precio * apalancamiento)
  // Así, si el precio llega al SL, la pérdida sigue siendo exactamente riskUSD.
  const dist = Math.abs(entry - stopLoss);
  return dist > 0 ? riskUSD / (dist * leverage) : 0.001;
}

// Construye el objeto trade SIN guardarlo todavía en el estado.
// Si Bitunix está configurado, solo se confirma tras su aprobación.
/**
 * Valida si una propuesta es ejecutable con el capital actual.
 * Devuelve null si es OK, o un string con el mensaje de error.
 */
function checkTradeExecutability(proposal) {
  if (!bitunix.configured) return null; // sin Bitunix no bloqueamos

  const coin     = coinOf(proposal.par);
  const price    = state.prices[coin] || proposal.entrada;
  const minQty   = BITUNIX_MIN_QTY[coin];
  if (!minQty) return null; // moneda desconocida, dejar pasar

  const riskUSD  = state.profile.capital * state.profile.risk_pct / 100;
  const leverage = state.profile.leverage || 1;
  const size     = calcSize(riskUSD, price, proposal.stopLoss, leverage);

  if (size < minQty) {
    const minCapital = (minQty * Math.abs(price - proposal.stopLoss) * leverage) / (state.profile.risk_pct / 100);
    return `❌ ${coin} rechazado: qty calculada ${size.toFixed(5)} < mínimo Bitunix ${minQty}.\nNecesitas ~$${minCapital.toFixed(0)} de capital o aumentar el leverage.`;
  }
  return null;
}

function buildTrade(proposal) {
  const { profile, prices } = state;
  const riskUSD   = profile.capital * profile.risk_pct / 100;
  const leverage  = profile.leverage || 1;
  const coin      = coinOf(proposal.par);
  const realEntry = prices[coin] || proposal.entrada;
  const size      = calcSize(riskUSD, realEntry, proposal.stopLoss, leverage);

  return {
    id: uid(),
    par:       proposal.par,
    tipo:      proposal.tipo,
    setup:     proposal.setup,
    entrada:   realEntry,
    stopLoss:  proposal.stopLoss,
    tp1:       proposal.tp1,
    tp2:       proposal.tp2,
    rr:        proposal.rr,
    confianza: proposal.confianza,
    razon:     proposal.razon,
    size:      parseFloat(size.toFixed(6)),
    leverage,
    riskUSD,
    currentPrice: realEntry,
    pnl: 0, pnlPct: 0,
    createdAt: nowFull(),
  };
}

// Confirma el trade en el estado local — solo se llama si Bitunix acepta (o no está configurado)
function commitTrade(trade) {
  state.activeTrades.unshift(trade);
  saveKey('activeTrades', state.activeTrades);
  syncTradesToServer();
  const coin = coinOf(trade.par);
  showToast(`✓ ${trade.par} activa — entrada ${fmtP(trade.entrada, coin)}`);
}

// Mantener compatibilidad con llamadas antiguas (sin Bitunix configurado)
function acceptProposal(proposal) {
  const trade = buildTrade(proposal);
  commitTrade(trade);
  return trade;
}

async function acceptAlert(alert) {
  const execError = checkTradeExecutability(alert);
  if (execError) { showToast(execError, true); return null; }

  const trade = buildTrade(alert);

  if (bitunix.configured) {
    const confirmed = await showTradeConfirmModal(trade);
    if (!confirmed) return null;

    const result = await placeBitunixOrder(trade);
    if (!result || !result.ok) {
      showToast(`❌ Trade no registrado: Bitunix rechazó la orden.`, true);
      state.alerts = state.alerts.map(a =>
        a.id === alert.id ? { ...a, status: 'rejected_bitunix' } : a
      );
      saveKey('alerts', state.alerts);
      renderAlerts();
      return null;
    }
  }

  commitTrade(trade);
  state.alerts = state.alerts.map(a =>
    a.id === alert.id ? { ...a, status: 'accepted' } : a
  );
  saveKey('alerts', state.alerts);
  setTab('ops');
  return trade;
}

function closeTrade(tradeId, result, pnlOverride) {
  const idx = state.activeTrades.findIndex(t => t.id === tradeId);
  if (idx === -1) return;
  const trade = state.activeTrades[idx];
  const pnl = pnlOverride !== undefined
    ? pnlOverride
    : result === 'WIN'
      ? Math.abs(trade.riskUSD) * parseFloat(trade.rr || 1)
      : -Math.abs(trade.riskUSD);

  const closed = { ...trade, result, pnl, closedAt: nowFull() };
  state.closedTrades.unshift(closed);
  state.activeTrades.splice(idx, 1);
  saveKey('activeTrades', state.activeTrades);
  saveKey('closedTrades', state.closedTrades);
  syncTradesToServer();

  // Resincronizar capital real desde Bitunix tras cerrar un trade
  if (bitunix.configured) {
    setTimeout(() => fetchBitunixAccount().then(() => renderBalanceWidget()), 4000);
  }

  return closed;
}

function cancelTrade(tradeId) {
  state.activeTrades = state.activeTrades.filter(t => t.id !== tradeId);
  saveKey('activeTrades', state.activeTrades);
  showToast('Operación cancelada.');
  renderOps();
}

function checkTPSL() {
  let changed = false;
  state.activeTrades = state.activeTrades.filter(trade => {
    if (state.autoClosedIds.has(trade.id)) return true;
    const coin  = coinOf(trade.par);
    const price = state.prices[coin];
    if (!price) return true;

    const hitSL  = trade.tipo === 'LONG' ? price <= trade.stopLoss : price >= trade.stopLoss;
    // Si hay TP2, TP1 es solo para breakeven — el cierre real es en TP2
    const closeTarget = trade.tp2 || trade.tp1;
    const hitTP  = trade.tipo === 'LONG' ? price >= closeTarget : price <= closeTarget;
    // TP1 como nivel de breakeven (solo cuando hay TP2)
    const hitTP1 = trade.tp2 && !trade.breakevenSet && (
      trade.tipo === 'LONG' ? price >= trade.tp1 : price <= trade.tp1
    );

    // ── BREAKEVEN AUTOMÁTICO al llegar a TP1 (si hay TP2) ──────────────
    if (hitTP1) {
      trade.stopLoss    = trade.entrada;  // SL → entrada (breakeven)
      trade.breakevenSet = true;
      changed = true;
      showToast(`🔒 ${trade.par} — SL movido a breakeven ($${fmtP(trade.entrada, coin)})`);
      // Intentar actualizar SL en Bitunix si está configurado
      if (bitunix.configured && trade.bitunixSymbol) {
        updateBitunixSL(trade).catch(() => {});
      }
      saveKey('activeTrades', state.activeTrades);
    }

    if (hitSL || hitTP) {
      state.autoClosedIds.add(trade.id);
      const result = hitTP ? 'WIN' : (trade.breakevenSet ? 'BREAKEVEN' : 'LOSS');
      const lev    = trade.leverage || 1;
      const exitPrice = hitTP ? closeTarget : trade.stopLoss;
      const pnl    = trade.tipo === 'LONG'
        ? (exitPrice - trade.entrada) * trade.size * lev
        : (trade.entrada - exitPrice) * trade.size * lev;
      const closed = { ...trade, result, pnl, closedAt: nowFull() };
      state.closedTrades.unshift(closed);
      if (result === 'WIN') {
        showToast(`✓ ${trade.par} cerrada en TP! ${fmtUSD(pnl)}`);
      } else if (result === 'BREAKEVEN') {
        showToast(`↔ ${trade.par} cerrada en breakeven. Sin pérdida.`);
      } else {
        showToast(`✕ ${trade.par} SL alcanzado. ${fmtUSD(pnl)}`, true);
      }
      changed = true;
      return false;
    }
    return true;
  });

  // ── FIX: limpiar autoClosedIds de IDs que ya no están en activeTrades ──
  // Evita que el Set crezca sin límite con trades antiguos
  const activeIds = new Set(state.activeTrades.map(t => t.id));
  for (const id of state.autoClosedIds) {
    if (!activeIds.has(id)) state.autoClosedIds.delete(id);
  }

  if (changed) {
    saveKey('activeTrades', state.activeTrades);
    saveKey('closedTrades', state.closedTrades);
    // ── FIX: sincronizar inmediatamente con servidor para que deje de vigilar
    // el trade que acaba de cerrar el cliente, evitando doble cierre
    syncTradesToServer();
    if (state.currentTab === 'ops')  renderOps();
    if (state.currentTab === 'perf') renderPerf();
  }
}

function updateTradesPnl() {
  if (state.currentTab !== 'ops') return;
  state.activeTrades.forEach(trade => {
    const coin  = coinOf(trade.par);
    const price = state.prices[coin] || trade.entrada;
    trade.currentPrice = price;
    const lev    = trade.leverage || 1;
    trade.pnl    = trade.tipo === 'LONG'
      ? (price - trade.entrada) * trade.size * lev
      : (trade.entrada - price) * trade.size * lev;
    trade.pnlPct = trade.tipo === 'LONG'
      ? ((price - trade.entrada) / trade.entrada) * 100 * lev
      : ((trade.entrada - price) / trade.entrada) * 100 * lev;

    // Update DOM directly for efficiency
    const card = qs(`[data-trade-id="${trade.id}"]`);
    if (!card) return;
    const pnlEl    = qs('.op-pnl',    card);
    const priceEl  = qs('.live-price', card);
    const prev     = state.prevPrices[coin];
    const pnlColor = trade.pnl >= 0 ? 'var(--green)' : 'var(--red)';

    if (pnlEl) {
      pnlEl.textContent  = `${fmtUSD(trade.pnl)} (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}%)`;
      pnlEl.style.color  = pnlColor;
    }
    if (priceEl) {
      priceEl.textContent = (price > prev ? '▲ ' : price < prev ? '▼ ' : '') + fmtP(price, coin);
      priceEl.className   = 'live-price ' + (price > prev ? 'up' : price < prev ? 'dn' : 'flat');
    }
  });
}

/* ── Price Alerts ────────────────────────────────────────────────────────── */
function addPriceAlert(coin, targetPrice, direction) {
  // direction: 'above' | 'below'
  const pa = {
    id:          uid(),
    coin,
    targetPrice: parseFloat(targetPrice),
    direction,
    createdAt:   nowTime(),
    triggered:   false,
  };
  state.priceAlerts.push(pa);
  saveKey('priceAlerts', state.priceAlerts);
  renderPriceAlertsPanel();
  showToast(`🔔 Alerta creada: ${coin} ${direction === 'above' ? '≥' : '≤'} ${fmtP(pa.targetPrice, coin)}`);
}

function deletePriceAlert(id) {
  state.priceAlerts = state.priceAlerts.filter(a => a.id !== id);
  saveKey('priceAlerts', state.priceAlerts);
  renderPriceAlertsPanel();
}

function checkPriceAlerts() {
  let fired = false;
  state.priceAlerts.forEach(pa => {
    if (pa.triggered) return;
    const price = state.prices[pa.coin];
    if (!price) return;
    const hit = pa.direction === 'above' ? price >= pa.targetPrice : price <= pa.targetPrice;
    if (hit) {
      pa.triggered  = true;
      pa.triggeredAt = nowTime();
      pa.triggeredPrice = price;
      fired = true;
      const msg = `🔔 ${pa.coin} ${pa.direction === 'above' ? 'superó' : 'bajó de'} ${fmtP(pa.targetPrice, pa.coin)} → precio actual ${fmtP(price, pa.coin)}`;
      showToast(msg);
      if (state.notifPermission === 'granted') {
        try { new Notification(`🔔 Alerta de precio: ${pa.coin}`, { body: msg, tag: 'price-alert-' + pa.id }); } catch {}
      }
    }
  });
  if (fired) {
    saveKey('priceAlerts', state.priceAlerts);
    if (state.currentTab === 'alerts') renderAlerts();
  }
}

function renderPriceAlertsPanel() {
  const root = qs('#price-alerts-panel');
  if (!root) return;

  const active    = state.priceAlerts.filter(a => !a.triggered);
  const triggered = state.priceAlerts.filter(a => a.triggered);

  // Coin options from watchedCoins
  const coinOpts = state.watchedCoins.map(c =>
    `<option value="${c}">${c} — ${COIN_NAMES[c] || c}</option>`
  ).join('');

  root.innerHTML = `
    <div class="stl">🔔 Alertas de Precio</div>
    <div style="display:grid;grid-template-columns:1fr 1fr auto auto;gap:8px;align-items:end;margin-bottom:14px;flex-wrap:wrap">
      <div>
        <div class="lbl">Moneda</div>
        <select class="inp" id="pa-coin" style="padding:8px 10px;font-size:12px">
          ${coinOpts}
        </select>
      </div>
      <div>
        <div class="lbl">Precio objetivo</div>
        <input class="inp" type="number" id="pa-price" placeholder="Ej: 65000" step="any" style="font-size:12px"/>
      </div>
      <div>
        <div class="lbl">Condición</div>
        <select class="inp" id="pa-dir" style="padding:8px 10px;font-size:12px">
          <option value="above">≥ Supera</option>
          <option value="below">≤ Cae de</option>
        </select>
      </div>
      <button class="btn btng" style="padding:8px 14px;font-size:11px;align-self:end" onclick="submitPriceAlert()">+ Añadir</button>
    </div>

    ${active.length === 0 && triggered.length === 0
      ? `<div style="font-size:11px;color:var(--muted);padding:10px 0">Sin alertas activas. Crea una arriba.</div>`
      : ''
    }

    ${active.length > 0 ? `
      <div style="font-size:10px;color:var(--muted);letter-spacing:.8px;margin-bottom:7px;font-weight:600">ACTIVAS (${active.length})</div>
      ${active.map(a => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--s2);border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:16px">🔔</span>
            <div>
              <div style="font-weight:600;font-size:13px;font-family:var(--serif)">${a.coin}</div>
              <div style="font-size:11px;color:var(--muted)">${a.direction === 'above' ? '≥' : '≤'} ${fmtP(a.targetPrice, a.coin)} · creada ${a.createdAt}</div>
            </div>
          </div>
          <button onclick="deletePriceAlert('${a.id}')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;padding:4px">×</button>
        </div>`).join('')}
    ` : ''}

    ${triggered.length > 0 ? `
      <div style="font-size:10px;color:var(--muted);letter-spacing:.8px;margin:10px 0 7px;font-weight:600">DISPARADAS (${triggered.length})</div>
      ${triggered.map(a => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--s2);border:1px solid ${a.direction==='above'?'#BCD9C5':'#D9BCBC'};border-radius:8px;margin-bottom:6px;opacity:.7">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:16px">✓</span>
            <div>
              <div style="font-weight:600;font-size:13px;font-family:var(--serif)">${a.coin} ${a.direction === 'above' ? '≥' : '≤'} ${fmtP(a.targetPrice, a.coin)}</div>
              <div style="font-size:11px;color:var(--muted)">Disparada a ${fmtP(a.triggeredPrice, a.coin)} · ${a.triggeredAt}</div>
            </div>
          </div>
          <button onclick="deletePriceAlert('${a.id}')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;padding:4px">×</button>
        </div>`).join('')}
    ` : ''}`;
}

function submitPriceAlert() {
  const coin   = qs('#pa-coin')?.value;
  const price  = parseFloat(qs('#pa-price')?.value);
  const dir    = qs('#pa-dir')?.value;
  if (!coin || !price || price <= 0) { showToast('Introduce un precio válido', true); return; }
  const cur = state.prices[coin];
  if (dir === 'above' && cur && price <= cur) { showToast(`${coin} ya está por encima de ${fmtP(price, coin)}`, true); return; }
  if (dir === 'below' && cur && price >= cur) { showToast(`${coin} ya está por debajo de ${fmtP(price, coin)}`, true); return; }
  addPriceAlert(coin, price, dir);
  if (qs('#pa-price')) qs('#pa-price').value = '';
}

/* ── Scanner Log ─────────────────────────────────────────────────────────── */
function addScanLog(result) {
  const entry = {
    ts:      nowFull(),
    found:   result.hay_oportunidad,
    razon:   result.hay_oportunidad
               ? `${result.par} ${result.tipo} — ${result.setup} (${result.confianza}% conf.)`
               : result.razon,
    coins:   state.watchedCoins.join(', '),
  };
  state.scanLog.unshift(entry);
  if (state.scanLog.length > 50) state.scanLog = state.scanLog.slice(0, 50);
  saveKey('scanLog', state.scanLog);
  if (state.currentTab === 'alerts') renderScanLog();
}

function renderScanLog() {
  const root = qs('#scan-log-panel');
  if (!root) return;
  if (state.scanLog.length === 0) {
    root.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:10px 0">El log aparece aquí cada vez que el escáner analiza el mercado.</div>`;
    return;
  }
  root.innerHTML = state.scanLog.slice(0, 20).map(e => `
    <div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:14px;flex-shrink:0">${e.found ? '⚡' : '○'}</span>
      <div>
        <div style="font-size:11px;color:${e.found ? 'var(--text)' : 'var(--muted)'}">
          ${e.found ? `<b style="color:var(--green)">Oportunidad</b> — ${e.razon}` : e.razon}
        </div>
        <div style="font-size:9px;color:var(--subtle);margin-top:2px">${e.ts} · ${e.coins}</div>
      </div>
    </div>`).join('');
}

/* ── Scanner ─────────────────────────────────────────────────────────────── */
async function runScan() {
  if (state.scanning || state.wsStatus !== 'live') return;
  state.scanning = true;
  state.lastScan = nowTime();
  updateScannerUI();

  try {
    const result = await aiScanMarket();
    addScanLog(result);
    if (result.hay_oportunidad) {
      const alert = {
        ...result,
        id:        uid(),
        timestamp: nowTime(),
        status:    'pending',
      };
      state.alerts.unshift(alert);
      if (state.alerts.length > 30) state.alerts = state.alerts.slice(0, 30);
      saveKey('alerts', state.alerts);
      fireNotification(alert);
      updateAlertBadge();
      if (state.currentTab === 'alerts') renderAlerts();
    }
  } catch (e) {
    console.warn('Scan error:', e.message);
  }

  state.scanning = false;
  updateScannerUI();
}

function startScanner() {
  state.scannerOn = true;
  runScan();
  state.scanTimer = setInterval(runScan, state.scanInterval * 60 * 1000);
  updateScannerUI();
}

function stopScanner() {
  state.scannerOn = false;
  clearInterval(state.scanTimer);
  state.scanTimer = null;
  updateScannerUI();
}

function toggleScanner() {
  // Delegamos al escáner server-side (24/7)
  toggleServerScanner();
}

function updateScannerUI() {
  const scanBtn = qs('#scanner-toggle');
  const scanHdr = qs('#scanner-toggle-hdr');
  const mini    = qs('#scanner-mini');
  const sweep   = qs('#scanner-sweep');
  const isOn    = state.scannerActive || state.scannerOn;

  if (scanBtn) {
    scanBtn.className = 'scanner-btn ' + (isOn ? 'on' : 'off');
    scanBtn.innerHTML = state.scanning
      ? `<span class="spinner-p"></span> ESCANEANDO...`
      : isOn ? '⏹ DETENER' : '▶ ACTIVAR';
  }
  if (scanHdr) {
    scanHdr.className = 'scanner-btn ' + (isOn ? 'on' : 'off');
    scanHdr.innerHTML = isOn ? '📡 ESCÁNER ON (24/7)' : '📡 ESCÁNER OFF';
  }
  if (mini) mini.style.display = isOn ? 'block' : 'none';
  if (sweep) sweep.style.display = isOn ? 'block' : 'none';

  const miniTime = qs('#scanner-mini-time');
  if (miniTime && state.lastScan) miniTime.textContent = 'Último: ' + state.lastScan;

  updateScannerBadge();
}

/* ── Notifications ───────────────────────────────────────────────────────── */
async function requestNotifPermission() {
  const p = await Notification.requestPermission();
  state.notifPermission = p;
  renderAlerts(); // refresh UI
  if (p === 'granted') showToast('✓ Notificaciones activadas');
  else showToast('Notificaciones denegadas', true);
}

function fireNotification(alert) {
  showScreenNotif(alert);
  if (state.notifPermission === 'granted') {
    try {
      new Notification(`⚡ ${alert.par} — ${alert.tipo} Detectado`, {
        body: `${alert.setup} | Confianza ${alert.confianza}% | R:R 1:${alert.rr}\n${alert.razon}`,
        tag: 'cryptoplan-alert',
      });
    } catch {}
  }
}

function showScreenNotif(alert) {
  const existing = qs('#screen-notif');
  if (existing) existing.remove();
  state.activeNotif = alert;

  const div = el('div', 'notif');
  div.id = 'screen-notif';
  const coin = coinOf(alert.par);
  div.innerHTML = `
    <div class="notif-inner">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:18px">⚡</span>
          <div>
            <div class="notif-title">OPORTUNIDAD DETECTADA</div>
            <div class="notif-time">${alert.timestamp}</div>
          </div>
        </div>
        <button onclick="qs('#screen-notif').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;padding:0 4px">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-family:var(--display);font-size:15px;font-weight:800;color:#fff">${alert.par}</span>
        <span style="font-size:10px;padding:2px 7px;border-radius:3px;border:1px solid ${alert.tipo==='LONG'?'rgba(0,255,157,.4)':'rgba(255,77,109,.4)'};color:${alert.tipo==='LONG'?'var(--green)':'var(--red)'}">${alert.tipo}</span>
        <span class="tag ${urgencyClass(alert.urgencia)}">${alert.urgencia}</span>
        <span class="tag tc">${alert.confianza}%</span>
      </div>
      <div class="notif-reason">${alert.razon}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btng" style="font-size:10px;padding:7px 14px;flex:1" onclick="setTab('alerts');qs('#screen-notif').remove()">Ver en Alertas</button>
        <button class="btn btng" style="font-size:10px;padding:7px 14px;flex:1" onclick="acceptAlertById('${alert.id}');qs('#screen-notif').remove()">${bitunix.configured ? '📡 Ejecutar en Bitunix' : '✓ Simular ya'}</button>
      </div>
    </div>`;
  document.body.appendChild(div);
  setTimeout(() => { if (div.parentNode) div.remove(); }, 12000);
}

function urgencyClass(u) {
  return u === 'ALTA' ? 'tr' : u === 'MEDIA' ? 'ty' : 'tb';
}

async function acceptAlertById(id) {
  const alert = state.alerts.find(a => a.id === id);
  if (alert) {
    const trade = await acceptAlert(alert);
    if (trade) renderAll();
  }
}

/* ── Ticker ──────────────────────────────────────────────────────────────── */
function renderTicker() {
  const ticker = qs('#ticker');
  if (!ticker) return;
  const coins = ['BTC','ETH','SOL','XRP'];
  ticker.innerHTML = coins.map((c, i) => {
    const p    = state.prices[c];
    const prev = state.prevPrices[c];
    const up   = p && prev && p > prev;
    const dn   = p && prev && p < prev;
    return `
      ${i > 0 ? '<span class="ticker-sep">·</span>' : ''}
      <span class="ticker-coin">${c}</span>
      <span class="ticker-price ${up?'up':dn?'dn':''}">${p ? fmtP(p, c) : '...'}</span>
      ${up ? '<span class="ticker-arrow" style="color:var(--green)">▲</span>' : ''}
      ${dn ? '<span class="ticker-arrow" style="color:var(--red)">▼</span>' : ''}`;
  }).join('');
}

/* ── Calcula el desglose de dinero de una propuesta antes de aceptar ─────── */
function calcProposalMoney(proposal) {
  const { profile, prices } = state;
  const capital   = profile.capital  || 1000;
  const riskPct   = profile.risk_pct || 2;
  const leverage  = profile.leverage || 1;
  const coin      = coinOf(proposal.par);
  const entry     = prices[coin] || proposal.entrada;
  const riskUSD   = capital * riskPct / 100;
  const size      = calcSize(riskUSD, entry, proposal.stopLoss, leverage);
  const notional  = size * entry;              // valor total de la posición
  const margin    = notional / leverage;       // dinero real bloqueado (margen)
  const maxWin    = riskUSD * parseFloat(proposal.rr || 1);
  const capitalPct = (margin / capital * 100); // % del capital usado

  // Avisos
  const warnings = [];
  if (margin > capital * 0.5) warnings.push('⚠️ Posición >50% del capital');
  if (margin > capital)       warnings.push('🚨 Margen supera el capital disponible');
  if (leverage > 10)          warnings.push('⚠️ Apalancamiento muy alto');

  return { riskUSD, size, notional, margin, maxWin, capitalPct, leverage, riskPct, warnings };
}

/* ── Render: Ops ─────────────────────────────────────────────────────────── */
function renderOps() {
  const root = qs('#sec-ops');
  if (!root) return;

  let html = '';

  // AI message
  if (state.aiMsg) {
    html += `
      <div class="ai-msg">
        <div class="ai-msg-hdr"><span class="pulse"></span>◈ ANÁLISIS IA — PRECIOS REALES BINANCE</div>
        <div style="margin-bottom:7px"><b style="color:var(--accent)">Mercado:</b> ${state.aiMsg.market}</div>
        <div><b style="color:var(--yellow)">Para ti:</b> ${state.aiMsg.rec}</div>
        <button class="btn" style="margin-top:8px;font-size:10px;padding:4px 10px" onclick="state.aiMsg=null;renderOps()">✕ cerrar</button>
      </div>`;
  }

  // Pending proposals
  if (state.pending.length > 0) {
    html += `<div class="stl">◈ Propuestas IA — Tu aprobación requerida</div>`;
    state.pending.forEach((p, i) => {
      const coin  = coinOf(p.par);
      const live  = state.prices[coin];
      const lc    = p.tipo === 'LONG' ? 'var(--green)' : 'var(--red)';
      const money = calcProposalMoney(p);

      const warningsHtml = money.warnings.length
        ? `<div style="margin-top:6px">${money.warnings.map(w =>
            `<div style="font-size:10px;color:var(--red);padding:2px 0">${w}</div>`
          ).join('')}</div>`
        : '';

      html += `
        <div class="proposal">
          <div class="proposal-hdr">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
              <span style="font-family:var(--display);font-size:15px;font-weight:800;color:#fff">${p.par}</span>
              <span style="font-size:10px;padding:2px 7px;border-radius:3px;border:1px solid ${lc}40;color:${lc}">${p.tipo}</span>
              <span class="tag tc">${p.confianza}% IA</span>
              ${live ? `<span style="font-size:10px;color:var(--accent);background:rgba(0,229,255,.1);padding:2px 8px;border-radius:4px">💹 ${fmtP(live, coin)}</span>` : ''}
              <span class="tag ty" style="margin-left:auto">⏳ PENDIENTE</span>
            </div>
            <div style="font-size:10px;color:var(--muted);margin-bottom:8px">Setup: ${p.setup}</div>
            <div class="op-levels">
              <span class="lv lv-e">E: ${fmtP(p.entrada, coin)}</span>
              <span class="lv lv-s">SL: ${fmtP(p.stopLoss, coin)}</span>
              <span class="lv lv-t">TP1 🎯: ${fmtP(p.tp1, coin)}</span>
              ${p.tp2 ? `<span class="lv lv-t" style="opacity:.55" title="Objetivo visual — no se ejecuta automáticamente en Bitunix">TP2: ${fmtP(p.tp2, coin)}</span>` : ''}
              <span style="font-size:10px;color:var(--yellow)">R:R 1:${p.rr}</span>
            </div>

            <!-- BLOQUE DE DINERO -->
            <div style="margin-top:10px;padding:10px 12px;background:var(--s2);border-radius:8px;border:1px solid var(--border)">
              <div style="font-size:9px;color:var(--muted);letter-spacing:.6px;margin-bottom:8px">💰 RESUMEN FINANCIERO — capital $${state.profile.capital.toLocaleString()}</div>
              <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px 14px">
                <div>
                  <div style="font-size:9px;color:var(--muted)">Riesgo máximo</div>
                  <div style="font-size:13px;font-weight:700;color:var(--red)">-$${money.riskUSD.toFixed(2)} <span style="font-size:9px;font-weight:400;color:var(--muted)">(${money.riskPct}%)</span></div>
                </div>
                <div>
                  <div style="font-size:9px;color:var(--muted)">Ganancia potencial</div>
                  <div style="font-size:13px;font-weight:700;color:var(--green)">+$${money.maxWin.toFixed(2)}</div>
                </div>
                <div>
                  <div style="font-size:9px;color:var(--muted)">Margen utilizado</div>
                  <div style="font-size:13px;font-weight:700;color:var(--text)">$${money.margin.toFixed(2)} <span style="font-size:9px;font-weight:400;color:var(--muted)">(${money.capitalPct.toFixed(1)}% capital)</span></div>
                </div>
                <div>
                  <div style="font-size:9px;color:var(--muted)">Tamaño posición${money.leverage > 1 ? ` (${money.leverage}x)` : ''}</div>
                  <div style="font-size:13px;font-weight:700;color:var(--accent)">$${money.notional.toFixed(2)}</div>
                </div>
              </div>
              ${warningsHtml}
            </div>

            ${p.confluence_score ? `
            <div style="margin-top:8px;padding:7px 10px;background:var(--s2);border-radius:7px;border-left:3px solid ${p.confluence_score>=65?'var(--green)':p.confluence_score<=35?'var(--red)':'var(--yellow)'}">
              <div style="display:flex;justify-content:space-between;margin-bottom:3px">
                <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">CONFLUENCIA</span>
                <span style="font-size:11px;font-weight:700;color:${p.confluence_score>=65?'var(--green)':'var(--yellow)'}">${p.confluence_score}%</span>
              </div>
              ${p.signals_aligned?.length ? `<div style="font-size:9px;color:var(--muted)">${p.signals_aligned.map(s=>'✓ '+s).join(' · ')}</div>` : ''}
              ${p.signals_against?.length ? `<div style="font-size:9px;color:var(--red);margin-top:2px">${p.signals_against.map(s=>'✗ '+s).join(' · ')}</div>` : ''}
            </div>` : ''}
            <div style="font-size:10px;color:var(--muted);line-height:1.5;margin-top:8px;margin-bottom:10px">${p.razon}</div>
          </div>
          <div class="proposal-actions">
            <button class="btn btng" style="font-size:10px;padding:7px 16px" onclick="onAcceptProposal(${i})">${bitunix.configured ? '📡 EJECUTAR EN BITUNIX' : '✓ ACEPTAR Y SIMULAR'}</button>
            <button class="btn btnr" style="font-size:10px;padding:7px 12px" onclick="onRejectProposal(${i})">✕ Rechazar</button>
          </div>
        </div>`;
    });
  }

  // Active trades header
  html += `
    <div class="sec-hdr">
      <div class="stl" style="margin:0">◈ Operaciones Activas</div>
      <span style="font-size:10px;color:var(--muted)">${state.activeTrades.length} activa${state.activeTrades.length !== 1 ? 's' : ''}</span>
    </div>`;

  if (state.activeTrades.length === 0 && state.pending.length === 0) {
    html += `<div class="empty"><div class="ei">⚡</div><div class="et">Sin operaciones activas.<br>Activa el <b style="color:var(--purple)">ESCÁNER</b> para alertas automáticas<br>o presiona <b style="color:var(--accent)">ANALIZAR AHORA</b>.</div></div>`;
  }

  state.activeTrades.forEach(o => {
    const coin     = coinOf(o.par);
    const price    = state.prices[coin] || o.entrada;
    const prev     = state.prevPrices[coin];
    const lev      = o.leverage || 1;
    const pnl      = o.tipo === 'LONG'
      ? (price - o.entrada) * o.size * lev
      : (o.entrada - price) * o.size * lev;
    const pnlPct   = o.tipo === 'LONG'
      ? ((price - o.entrada)/o.entrada)*100 * lev
      : ((o.entrada - price)/o.entrada)*100 * lev;
    const lc       = o.tipo === 'LONG' ? 'var(--green)' : 'var(--red)';
    const pnlColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    const priceDir = price > prev ? 'up' : price < prev ? 'dn' : 'flat';
    const arrow    = price > prev ? '▲ ' : price < prev ? '▼ ' : '';
    const levBadge = lev > 1
      ? `<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.4);color:var(--yellow)">${lev}x</span>`
      : '';

    html += `
      <div class="op" data-trade-id="${o.id}">
        <div class="op-body">
          <div class="op-stripe" style="background:${lc}"></div>
          <div class="op-main">
            <div class="op-hdr">
              <span class="op-pair">${o.par}</span>
              <span style="font-size:10px;color:${lc};border:1px solid ${lc}40;padding:2px 7px;border-radius:3px">${o.tipo}</span>
              ${levBadge}
              <span class="tag tc">${o.confianza}% IA</span>
              <span class="live-price ${priceDir}">${arrow}${fmtP(price, coin)}</span>
              <span class="op-pnl" style="color:${pnlColor}">${fmtUSD(pnl)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span>
            </div>
            <div class="op-meta">${o.setup} · ${o.createdAt} · Riesgo $${(o.riskUSD || 0).toFixed(2)}${lev > 1 ? ` · Apalancamiento ${lev}x` : ''}</div>
            <div class="op-levels">
              <span class="lv lv-e">E: ${fmtP(o.entrada, coin)}</span>
              <span class="lv lv-s">SL: ${fmtP(o.stopLoss, coin)}</span>
              <span class="lv lv-t">TP1 🎯: ${fmtP(o.tp1, coin)}</span>
              ${o.tp2 ? `<span class="lv lv-t" style="opacity:.55" title="Objetivo visual — no se ejecuta automáticamente en Bitunix">TP2: ${fmtP(o.tp2, coin)}</span>` : ''}
              <span style="font-size:10px;color:var(--yellow)">R:R 1:${o.rr}</span>
            </div>
            <div class="op-reason">${o.razon}</div>
            ${o.notes ? `<div style="margin-top:7px;padding:7px 10px;background:var(--s2);border-radius:6px;font-size:11px;color:var(--muted);border-left:2px solid var(--border)">📝 ${o.notes}</div>` : ''}
          </div>
        </div>
        <div class="op-actions">
          <button class="btn btng" style="font-size:10px;padding:6px 12px" onclick="closeTradeAtMarket('${o.id}')">✓ Cerrar</button>
          <button class="btn btny" style="font-size:10px;padding:6px 10px" onclick="openEditTrade('${o.id}')">✏ Editar</button>
          <button class="btn" style="font-size:10px;padding:6px 10px" onclick="toggleTradeNotes('${o.id}')">📝 Notas</button>
          <button class="btn btnr" style="font-size:10px;padding:6px 10px" onclick="cancelTrade('${o.id}');renderOps()">✕ Cancelar</button>
        </div>
        <div id="notes-panel-${o.id}" style="display:none;padding:10px 15px;border-top:1px solid var(--border);background:var(--s2)">
          <textarea class="inp" id="notes-input-${o.id}" rows="2"
            placeholder="Añade notas a esta operación..."
            style="margin-bottom:7px;font-size:12px">${o.notes || ''}</textarea>
          <button class="btn btng" style="font-size:10px;padding:5px 12px" onclick="saveTradeNotes('${o.id}')">✓ Guardar nota</button>
        </div>
      </div>`;
  });

  root.innerHTML = html;
}

/* ── Editar operación activa ─────────────────────────────────────────────── */
function openEditTrade(tradeId) {
  const trade = state.activeTrades.find(t => t.id === tradeId);
  if (!trade) return;
  const coin = coinOf(trade.par);

  const existing = qs('#edit-trade-modal');
  if (existing) existing.remove();

  const modal = el('div', '');
  modal.id = 'edit-trade-modal';
  modal.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(44,40,37,.25);backdrop-filter:blur(3px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .2s ease">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;width:100%;max-width:380px;box-shadow:var(--shadow-lg);overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-family:var(--serif);font-size:15px;font-weight:600">Editar ${trade.par}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px">${trade.tipo} · Entrada ${fmtP(trade.entrada, coin)}</div>
          </div>
          <button onclick="qs('#edit-trade-modal').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:20px;line-height:1;padding:4px">×</button>
        </div>
        <div style="padding:16px 18px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label class="lbl">Stop Loss</label>
            <input class="inp" type="number" id="et-sl" value="${trade.stopLoss}" step="any"/>
          </div>
          <div>
            <label class="lbl">TP1</label>
            <input class="inp" type="number" id="et-tp1" value="${trade.tp1}" step="any"/>
          </div>
          <div>
            <label class="lbl">TP2 (opcional)</label>
            <input class="inp" type="number" id="et-tp2" value="${trade.tp2 || ''}" step="any" placeholder="dejar vacío para ignorar"/>
          </div>
          <div>
            <label class="lbl">Notas</label>
            <textarea class="inp" id="et-notes" rows="2" placeholder="Notas de la operación...">${trade.notes || ''}</textarea>
          </div>
          <button class="btn btng" style="width:100%;justify-content:center;font-size:12px;padding:10px" onclick="saveEditTrade('${tradeId}')">✓ Guardar cambios</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('div').addEventListener('click', e => { if (e.target === e.currentTarget) modal.remove(); });
  const onKey = e => { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

function saveEditTrade(tradeId) {
  const trade = state.activeTrades.find(t => t.id === tradeId);
  if (!trade) return;
  const sl  = parseFloat(qs('#et-sl')?.value);
  const tp1 = parseFloat(qs('#et-tp1')?.value);
  const tp2 = parseFloat(qs('#et-tp2')?.value) || null;
  const notes = qs('#et-notes')?.value?.trim() || '';
  if (!sl || !tp1) { showToast('SL y TP1 son obligatorios', true); return; }
  trade.stopLoss = sl;
  trade.tp1      = tp1;
  trade.tp2      = tp2;
  trade.notes    = notes;
  // Recalcular R:R
  const dist  = Math.abs(trade.entrada - sl);
  const gain  = Math.abs(tp1 - trade.entrada);
  trade.rr    = dist > 0 ? (gain / dist).toFixed(1) : trade.rr;
  saveKey('activeTrades', state.activeTrades);
  syncTradesToServer();
  qs('#edit-trade-modal')?.remove();
  showToast(`✓ ${trade.par} actualizada`);
  renderOps();
}

function toggleBalanceEdit() {
  const area = qs('#balance-quick-edit');
  if (!area) return;
  area.style.display = area.style.display === 'none' || area.style.display === '' ? 'flex' : 'none';
}

function saveQuickCapital() {
  const val = parseFloat(qs('#balance-input')?.value);
  if (!val || val <= 0) { showToast('Introduce un valor válido', true); return; }
  state.profile.capital = val;
  saveKey('profile', state.profile);
  toggleBalanceEdit();
  renderBalanceWidget();
  showToast(`✓ Capital actualizado a $${val.toLocaleString('en')}`);
}

/* ── Render: Alerts ──────────────────────────────────────────────────────── */
function renderAlerts() {
  const root = qs('#sec-alerts');
  if (!root) return;

  const notifGranted = state.notifPermission === 'granted';

  let html = `
    <div class="sec-hdr">
      <div>
        <div class="stl" style="margin:0;margin-bottom:6px">◈ Alertas del Escáner IA</div>
        <div style="font-size:11px;color:var(--muted)">La IA monitoriza el mercado y te avisa cuando detecta oportunidades.</div>
      </div>
      <button class="btn" style="font-size:10px;padding:6px 12px" onclick="clearAlerts()">Limpiar todo</button>
    </div>

    <!-- Scanner config panel -->
    <div class="scanner-panel">
      <div id="scanner-sweep" class="scanner-sweep" style="display:${state.scannerOn?'block':'none'}"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
        <div>
          <div style="font-size:11px;color:var(--purple);font-weight:bold;margin-bottom:3px">📡 Escáner Automático</div>
          <div style="font-size:10px;color:var(--muted)">
            ${state.scannerOn
              ? (state.scanning ? 'Analizando mercado...' : `Activo — escanea cada ${state.scanInterval} min`)
              : 'Inactivo — actívalo para monitorización continua'}
          </div>
        </div>
        <button id="scanner-toggle" class="scanner-btn ${state.scannerOn?'on':'off'}" onclick="toggleScanner()" ${state.wsStatus !== 'live' ? 'disabled' : ''}>
          ${state.scanning ? '<span class="spinner-p"></span> ESCANEANDO...' : state.scannerOn ? '⏹ DETENER' : '▶ ACTIVAR'}
        </button>
      </div>
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div>
          <div style="font-size:9px;color:var(--muted);margin-bottom:5px;letter-spacing:1px">FRECUENCIA (MIN)</div>
          <div style="display:flex;gap:6px">
            ${[3,5,10,15].map(m => `
              <button class="btn" style="padding:5px 10px;font-size:10px;${state.scanInterval===m?'background:rgba(167,139,250,.2);border-color:var(--purple);color:var(--purple)':''}"
                onclick="setScanIntervalVal(${m})">${m}m</button>
            `).join('')}
          </div>
        </div>
        ${!notifGranted ? `
          <div>
            <div style="font-size:9px;color:var(--muted);margin-bottom:5px;letter-spacing:1px">NOTIFICACIONES</div>
            <button class="btn btny" style="font-size:10px;padding:5px 12px" onclick="requestNotifPermission()">🔔 Activar notificaciones</button>
          </div>` : `<div style="font-size:10px;color:var(--green);display:flex;align-items:center;gap:5px">✓ Notificaciones activas</div>`}
        <button class="btn btnp" style="font-size:10px;padding:5px 12px" onclick="runScan()" ${state.scanning || state.wsStatus !== 'live' ? 'disabled' : ''}>
          ${state.scanning ? '<span class="spinner-p"></span>' : '🔍'} Escanear ahora
        </button>
      </div>
    </div>`;

  // ── Calendario económico ──
  html += `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div class="stl" style="margin:0">📅 Calendario Económico — próx. 48h</div>
        <span style="font-size:9px;color:var(--muted)">Solo eventos USD / macro crypto relevantes</span>
      </div>
      <div id="calendar-section"></div>
    </div>`;
  // Render calendar after innerHTML is set (done below)

  // Alert list
  if (state.alerts.length === 0) {
    html += `<div class="empty"><div class="ei">🔔</div><div class="et">Sin alertas aún.<br>Activa el escáner para que la IA monitorice<br>el mercado y te avise de oportunidades.</div></div>`;
  } else {
    state.alerts.forEach(a => {
      const coin    = coinOf(a.par);
      const isPending = a.status === 'pending';
      const lc      = a.tipo === 'LONG' ? 'var(--green)' : 'var(--red)';

      if (isPending) {
        const money = calcProposalMoney(a);
        const warningsHtml = money.warnings.length
          ? money.warnings.map(w => `<div style="font-size:10px;color:var(--red);padding:2px 0">${w}</div>`).join('')
          : '';
        html += `
          <div class="alert-card">
            <div class="alert-card-body">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
                <span style="font-size:13px">⚡</span>
                <span style="font-family:var(--display);font-size:14px;font-weight:800;color:#fff">${a.par}</span>
                <span style="font-size:10px;padding:2px 7px;border-radius:3px;border:1px solid ${lc}40;color:${lc}">${a.tipo}</span>
                <span class="tag ${urgencyClass(a.urgencia)}">🔥 ${a.urgencia}</span>
                <span class="tag tc">${a.confianza}% IA</span>
                <span style="margin-left:auto;font-size:9px;color:var(--muted)">${a.timestamp}</span>
              </div>
              <div style="font-size:10px;color:var(--muted);margin-bottom:6px">Setup: ${a.setup}</div>
              <div class="op-levels" style="margin-bottom:6px">
                <span class="lv lv-e">E: ${fmtP(a.entrada, coin)}</span>
                <span class="lv lv-s">SL: ${fmtP(a.stopLoss, coin)}</span>
                <span class="lv lv-t">TP1 🎯: ${fmtP(a.tp1, coin)}</span>
                ${a.tp2 ? `<span class="lv lv-t" style="opacity:.55" title="Objetivo visual — no se ejecuta en Bitunix automáticamente">TP2: ${fmtP(a.tp2, coin)}</span>` : ''}
                <span style="font-size:10px;color:var(--yellow)">R:R 1:${a.rr}</span>
              </div>

              <!-- BLOQUE DE DINERO -->
              <div style="margin-bottom:8px;padding:8px 12px;background:var(--s2);border-radius:8px;border:1px solid var(--border)">
                <div style="font-size:9px;color:var(--muted);letter-spacing:.6px;margin-bottom:6px">💰 RESUMEN FINANCIERO — capital $${state.profile.capital.toLocaleString()}</div>
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px 14px">
                  <div>
                    <div style="font-size:9px;color:var(--muted)">Riesgo máximo</div>
                    <div style="font-size:12px;font-weight:700;color:var(--red)">-$${money.riskUSD.toFixed(2)} <span style="font-size:9px;font-weight:400;color:var(--muted)">(${money.riskPct}%)</span></div>
                  </div>
                  <div>
                    <div style="font-size:9px;color:var(--muted)">Ganancia potencial</div>
                    <div style="font-size:12px;font-weight:700;color:var(--green)">+$${money.maxWin.toFixed(2)}</div>
                  </div>
                  <div>
                    <div style="font-size:9px;color:var(--muted)">Margen utilizado</div>
                    <div style="font-size:12px;font-weight:700;color:var(--text)">$${money.margin.toFixed(2)} <span style="font-size:9px;font-weight:400;color:var(--muted)">(${money.capitalPct.toFixed(1)}%)</span></div>
                  </div>
                  <div>
                    <div style="font-size:9px;color:var(--muted)">Posición total${money.leverage > 1 ? ` (${money.leverage}x)` : ''}</div>
                    <div style="font-size:12px;font-weight:700;color:var(--accent)">$${money.notional.toFixed(2)}</div>
                  </div>
                </div>
                ${warningsHtml}
              </div>

              <div style="font-size:10px;color:var(--muted);line-height:1.5;margin-bottom:6px">${a.razon}</div>
              ${a.contexto_mercado ? `<div style="font-size:10px;color:var(--muted);background:rgba(0,0,0,.2);padding:6px 8px;border-radius:5px">${a.contexto_mercado}</div>` : ''}
            </div>
            <div class="alert-card-actions">
              <button class="btn btng" style="font-size:10px;padding:7px 16px" onclick="acceptAlertById('${a.id}')">${bitunix.configured ? '📡 EJECUTAR EN BITUNIX' : '✓ ACEPTAR Y SIMULAR'}</button>
              <button class="btn btnr" style="font-size:10px;padding:7px 12px" onclick="rejectAlert('${a.id}')">✕ Rechazar</button>
            </div>
          </div>`;
      } else {
        const statusTag = a.status === 'accepted'
          ? '<span class="tag tg">✓ ACEPTADA</span>'
          : '<span class="tag tm">✕ RECHAZADA</span>';
        html += `
          <div class="alert-old">
            <div class="alert-old-body">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
                <span style="font-family:var(--display);font-size:14px;font-weight:800;color:#fff">${a.par}</span>
                <span style="font-size:10px;padding:2px 7px;border-radius:3px;border:1px solid ${lc}40;color:${lc}">${a.tipo}</span>
                <span class="tag ${urgencyClass(a.urgencia)}">${a.urgencia}</span>
                <span class="tag tc">${a.confianza}%</span>
                ${statusTag}
                <span style="margin-left:auto;font-size:9px;color:var(--muted)">${a.timestamp}</span>
              </div>
              <div style="font-size:10px;color:var(--muted);line-height:1.5">${a.razon}</div>
            </div>
          </div>`;
      }
    });
  }

  root.innerHTML = html;

  // Renderizar calendario económico (requiere que el DOM esté listo)
  renderCalendarSection();

  // Inyectar paneles dinámicos después del renderizado
  // Panel de alertas de precio
  const paSection = el('div', '');
  paSection.className = 'card';
  paSection.id = 'price-alerts-panel';
  root.insertBefore(paSection, root.firstChild);
  renderPriceAlertsPanel();

  // Log del escáner (colapsable)
  const logSection = el('div', '');
  logSection.className = 'card';
  logSection.style.marginTop = '10px';
  logSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none" onclick="toggleScanLog()">
      <div class="stl" style="margin:0">📋 Log del Escáner <span style="font-size:10px;color:var(--muted);font-weight:400">(${state.scanLog.length} entradas)</span></div>
      <span id="scan-log-toggle-icon" style="color:var(--muted);font-size:14px">▼</span>
    </div>
    <div id="scan-log-panel" style="display:none;margin-top:10px"></div>`;
  root.appendChild(logSection);
}

function toggleScanLog() {
  const panel = qs('#scan-log-panel');
  const icon  = qs('#scan-log-toggle-icon');
  if (!panel) return;
  const open = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  if (icon) icon.textContent = open ? '▲' : '▼';
  if (open) renderScanLog();
}

function rejectAlert(id) {
  state.alerts = state.alerts.map(a => a.id === id ? { ...a, status: 'rejected' } : a);
  saveKey('alerts', state.alerts);
  renderAlerts();
  updateAlertBadge();
}

function clearAlerts() {
  state.alerts = [];
  saveKey('alerts', state.alerts);
  renderAlerts();
  updateAlertBadge();
}

function updateAlertBadge() {
  const badge   = qs('#alert-badge');
  const pending = state.alerts.filter(a => a.status === 'pending').length;
  if (badge) {
    badge.textContent = pending;
    badge.style.display = pending > 0 ? 'inline' : 'none';
  }
}

/* ── Render: Performance ─────────────────────────────────────────────────── */
function calcAdvancedMetrics(trades) {
  if (trades.length === 0) return null;

  const wins   = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const totalPnl = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const grossWin = wins.reduce((a, t) => a + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + (t.pnl || 0), 0));

  // Drawdown máximo
  let peak = 0, maxDD = 0, runningPnl = 0;
  [...trades].reverse().forEach(t => {
    runningPnl += (t.pnl || 0);
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDD) maxDD = dd;
  });

  // Racha actual y máxima
  let curStreak = 0, curType = null, maxWinStreak = 0, maxLossStreak = 0, tempStreak = 0, tempType = null;
  [...trades].reverse().forEach((t, i) => {
    if (i === 0) { curType = t.result; curStreak = 1; tempType = t.result; tempStreak = 1; return; }
    if (t.result === curType) curStreak++;
    else { curType = null; } // se rompe
    if (t.result === tempType) { tempStreak++; }
    else { if (tempType === 'WIN') maxWinStreak = Math.max(maxWinStreak, tempStreak); else maxLossStreak = Math.max(maxLossStreak, tempStreak); tempType = t.result; tempStreak = 1; }
  });
  if (tempType === 'WIN') maxWinStreak = Math.max(maxWinStreak, tempStreak);
  else maxLossStreak = Math.max(maxLossStreak, tempStreak);
  // racha actual (desde el último trade hacia atrás)
  let streak = 0, streakType = trades[0]?.result;
  for (const t of trades) { if (t.result === streakType) streak++; else break; }

  const avgWin  = wins.length   > 0 ? grossWin / wins.length     : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length   : 0;
  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss) : grossWin > 0 ? 999 : 0;
  const bestTrade  = trades.reduce((a, t) => (t.pnl || 0) > (a.pnl || 0) ? t : a, trades[0]);
  const worstTrade = trades.reduce((a, t) => (t.pnl || 0) < (a.pnl || 0) ? t : a, trades[0]);

  // Por par
  const byPair = {};
  trades.forEach(t => {
    if (!byPair[t.par]) byPair[t.par] = { wins: 0, total: 0, pnl: 0 };
    byPair[t.par].total++;
    byPair[t.par].pnl += t.pnl || 0;
    if (t.result === 'WIN') byPair[t.par].wins++;
  });

  return { wins: wins.length, losses: losses.length, total: trades.length, totalPnl, grossWin, grossLoss, avgWin, avgLoss, profitFactor, maxDD, streak, streakType, maxWinStreak, maxLossStreak, bestTrade, worstTrade, byPair };
}

function renderPerf() {
  const root = qs('#sec-perf');
  if (!root) return;

  const { closedTrades, activeTrades, prices, profile } = state;
  const m = calcAdvancedMetrics(closedTrades);
  const winRate = m ? (m.wins / m.total * 100).toFixed(0) : 0;

  const activePnl = activeTrades.reduce((acc, t) => {
    const coin = coinOf(t.par);
    const p    = prices[coin] || t.entrada;
    const lev  = t.leverage || 1;
    return acc + (t.tipo === 'LONG' ? (p - t.entrada) * t.size * lev : (t.entrada - p) * t.size * lev);
  }, 0);

  // Equity curve
  let cap = profile.capital;
  const points = [cap, ...closedTrades.slice().reverse().map(t => { cap += (t.pnl || 0); return cap; })];
  const maxEq  = Math.max(...points), minEq = Math.min(...points);
  let equityBars = '';
  points.forEach((v, i) => {
    const h   = maxEq === minEq ? 50 : ((v - minEq) / (maxEq - minEq)) * 85 + 15;
    const prev = points[i - 1];
    const col = !prev ? 'var(--accent)' : v >= prev ? 'var(--green)' : 'var(--red)';
    equityBars += `<div class="equity-bar" style="height:${h}%;background:${col}99" title="$${v.toFixed(0)}"></div>`;
  });

  // Par stats
  let parRows = '';
  if (m) {
    Object.entries(m.byPair).sort((a,b) => b[1].pnl - a[1].pnl).forEach(([par, s]) => {
      const wr = (s.wins / s.total * 100).toFixed(0);
      parRows += `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-weight:600;font-family:var(--serif)">${par}</span>
            <span style="font-size:10px;color:var(--muted)">${s.wins}/${s.total} · ${wr}% WR</span>
          </div>
          <span style="font-weight:600;color:${s.pnl>=0?'var(--green)':'var(--red)'}">${fmtUSD(s.pnl)}</span>
        </div>`;
    });
  }

  // Historial
  let histRows = '';
  if (closedTrades.length === 0) {
    histRows = `<div class="empty" style="padding:16px"><div class="et">Sin operaciones cerradas.</div></div>`;
  } else {
    closedTrades.forEach(t => {
      const coin = coinOf(t.par);
      histRows += `
        <div class="hist-row" style="flex-direction:column;align-items:flex-start;gap:4px;padding:10px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
            <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
              <span class="tag ${t.result === 'WIN' ? 'tg' : 'tr'}">${t.result === 'WIN' ? '✓ WIN' : '✕ LOSS'}</span>
              <span style="font-weight:600;color:var(--text)">${t.par}</span>
              <span style="color:var(--muted)">${t.tipo}</span>
              ${t.exitPrice ? `<span style="font-size:10px;color:var(--muted)">→ ${fmtP(t.exitPrice, coin)}</span>` : ''}
              <span style="font-size:9px;color:var(--subtle)">${t.closedAt}</span>
            </div>
            <span style="font-family:var(--serif);font-weight:600;color:${t.result === 'WIN' ? 'var(--green)' : 'var(--red)'}">${fmtUSD(t.pnl || 0)}</span>
          </div>
          ${t.notes ? `<div style="font-size:11px;color:var(--muted);padding:4px 8px;background:var(--s2);border-radius:5px;width:100%;border-left:2px solid var(--border)">📝 ${t.notes}</div>` : ''}
        </div>`;
    });
  }

  root.innerHTML = `
    <div class="stl">◈ Rendimiento</div>

    <!-- KPIs principales -->
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-lbl">Win Rate</div><div class="kpi-val" style="color:${parseInt(winRate)>=50?'var(--green)':'var(--red)'}">${winRate}%</div><div class="kpi-sub">${m?.wins||0}/${m?.total||0} ops</div></div>
      <div class="kpi"><div class="kpi-lbl">P&L Cerrado</div><div class="kpi-val" style="color:${(m?.totalPnl||0)>=0?'var(--green)':'var(--red)'}">${fmtUSD(m?.totalPnl||0)}</div><div class="kpi-sub">ops cerradas</div></div>
      <div class="kpi"><div class="kpi-lbl">P&L Activo</div><div class="kpi-val" style="color:${activePnl>=0?'var(--green)':'var(--red)'}">${fmtUSD(activePnl)}</div><div class="kpi-sub">${activeTrades.length} posiciones</div></div>
      <div class="kpi"><div class="kpi-lbl">Profit Factor</div><div class="kpi-val" style="color:${(m?.profitFactor||0)>=1?'var(--green)':'var(--red)'}">${m ? m.profitFactor.toFixed(2) : '—'}</div><div class="kpi-sub">ganancias/pérdidas</div></div>
    </div>

    <!-- Métricas avanzadas -->
    ${m ? `
    <div class="card">
      <div class="stl">Métricas Avanzadas</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
        <div class="cs"><div class="csl">Drawdown Máx.</div><div class="csv" style="color:var(--red)">-$${m.maxDD.toFixed(2)}</div></div>
        <div class="cs"><div class="csl">Media por WIN</div><div class="csv" style="color:var(--green)">+$${m.avgWin.toFixed(2)}</div></div>
        <div class="cs"><div class="csl">Media por LOSS</div><div class="csv" style="color:var(--red)">-$${m.avgLoss.toFixed(2)}</div></div>
        <div class="cs"><div class="csl">Racha actual</div><div class="csv" style="color:${m.streakType==='WIN'?'var(--green)':'var(--red)'}">${m.streak} ${m.streakType === 'WIN' ? 'WIN' : 'LOSS'}</div></div>
        <div class="cs"><div class="csl">Max racha WIN</div><div class="csv" style="color:var(--green)">${m.maxWinStreak} seguidas</div></div>
        <div class="cs"><div class="csl">Max racha LOSS</div><div class="csv" style="color:var(--red)">${m.maxLossStreak} seguidas</div></div>
        <div class="cs"><div class="csl">Mejor trade</div><div class="csv" style="color:var(--green);font-size:11px">${m.bestTrade.par} ${fmtUSD(m.bestTrade.pnl||0)}</div></div>
        <div class="cs"><div class="csl">Peor trade</div><div class="csv" style="color:var(--red);font-size:11px">${m.worstTrade.par} ${fmtUSD(m.worstTrade.pnl||0)}</div></div>
      </div>
    </div>` : ''}

    <!-- Curva de capital -->
    <div class="card">
      <div class="stl">Curva de Capital</div>
      ${points.length > 1
        ? `<div class="equity-bars">${equityBars}</div>`
        : `<div class="empty" style="padding:20px"><div class="et">Sin datos aún.</div></div>`}
    </div>

    <!-- Rendimiento por par -->
    ${m && Object.keys(m.byPair).length > 0 ? `
    <div class="card">
      <div class="stl">Por Moneda</div>
      ${parRows}
    </div>` : ''}

    <!-- Historial -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="stl" style="margin:0">Historial Cerradas</div>
        ${closedTrades.length > 0 ? `
        <button onclick="exportTradesCSV()" style="background:none;border:1px solid var(--border);border-radius:8px;padding:5px 12px;font-size:11px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:5px;transition:all .2s" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
          ⬇ Exportar CSV
        </button>` : ''}
      </div>
      ${histRows}
    </div>`;
}

/* ── PRIORIDAD 6 — Exportar historial como CSV ───────────────────────────── */
async function exportTradesCSV() {
  try {
    showToast('Generando CSV...');
    const res = await authFetch('/api/trades/export-csv');
    if (!res.ok) { showToast('Sin trades para exportar.', true); return; }
    const blob     = await res.blob();
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement('a');
    a.href         = url;
    a.download     = `cryptoplan-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('✓ CSV descargado');
  } catch (e) {
    showToast('Error exportando: ' + e.message, true);
  }
}

/* ── TradingView chart modal ─────────────────────────────────────────────── */
function openChart(coin) {
  const existing = qs('#tv-modal');
  if (existing) existing.remove();

  const modal = el('div', '');
  modal.id = 'tv-modal';
  modal.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(44,40,37,.35);backdrop-filter:blur(4px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .2s ease">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;width:100%;max-width:860px;overflow:hidden;box-shadow:var(--shadow-lg)">
        <div style="padding:13px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div>
            <span style="font-family:var(--serif);font-size:15px;font-weight:600">${COIN_NAMES[coin] || coin}</span>
            <span style="color:var(--muted);font-size:11px;margin-left:8px">${coin}/USDT</span>
          </div>
          <button onclick="qs('#tv-modal').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:20px;line-height:1;padding:4px">×</button>
        </div>
        <div style="height:480px">
        <iframe
            src="https://www.tradingview.com/widgetembed/?symbol=BINANCE:${coin}USDT&interval=4H&theme=dark&style=1&locale=es&toolbar_bg=%230B0D11&hide_top_toolbar=0&hide_side_toolbar=0&allow_symbol_change=0&save_image=0&calendar=0&studies=RSI%4014"
            style="width:100%;height:100%;border:none"
            allowtransparency="true"
            frameborder="0">
          </iframe>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Cerrar con Escape
  const onKey = (e) => { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  // Cerrar al click en backdrop
  modal.querySelector('div').addEventListener('click', (e) => { if (e.target === e.currentTarget) modal.remove(); });
}

/* ── Render: Market ──────────────────────────────────────────────────────── */
function renderMkt() {
  const root = qs('#sec-mkt');
  if (!root) return;

  let cards = '';
  state.watchedCoins.forEach(coin => {
    const meta = MARKET_META[coin] || { tag:'—', cls:'tm', rsi:'...', sup:'...', res:'...' };
    const p    = state.prices[coin];
    const prev = state.prevPrices[coin];
    const up   = p && prev && p > prev;
    const dn   = p && prev && p < prev;
    const bc   = up ? '#BCD9C5' : dn ? '#D9BCBC' : 'var(--border)';
    const conf = meta.confluence;
    const confColor = conf ? (conf.score>=65?'var(--green)':conf.score<=35?'var(--red)':'var(--yellow)') : 'var(--muted)';

    // EMA pill
    const emaPill = meta.ema?.ema200 ? `
      <span style="font-size:9px;padding:2px 5px;border-radius:3px;background:${p>meta.ema.ema200?'rgba(130,173,143,.2)':'rgba(201,126,126,.15)'};color:${p>meta.ema.ema200?'var(--green)':'var(--red)'}">
        ${p>meta.ema.ema200?'▲':'▼'} EMA200
      </span>` : '';

    // MACD pill
    const macdPill = meta.macd?.hist != null ? `
      <span style="font-size:9px;padding:2px 5px;border-radius:3px;background:${meta.macd.hist>0?'rgba(130,173,143,.2)':'rgba(201,126,126,.15)'};color:${meta.macd.hist>0?'var(--green)':'var(--red)'}">
        MACD ${meta.macd.hist>0?'▲':'▼'}
      </span>` : '';

    // BB pill
    const bbPill = meta.bb ? (() => {
      const pos = p < meta.bb.lower ? 'BAJO BB' : p > meta.bb.upper ? 'SOBRE BB' : null;
      return pos ? `<span style="font-size:9px;padding:2px 5px;border-radius:3px;background:${p<meta.bb.lower?'rgba(130,173,143,.2)':'rgba(201,126,126,.15)'};color:${p<meta.bb.lower?'var(--green)':'var(--red)'}">${pos}</span>` : '';
    })() : '';

    // Patrones
    const patternPill = meta.patterns?.length > 0
      ? `<span style="font-size:9px;padding:2px 5px;border-radius:3px;background:rgba(123,167,188,.15);color:var(--accent)">${meta.patterns[0].name}</span>`
      : '';

    cards += `
      <div class="card" id="mkt-${coin}" style="border-color:${bc};transition:border-color .5s">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div>
            <div style="font-family:var(--serif);font-size:15px;font-weight:600;color:var(--text);line-height:1.2">${COIN_NAMES[coin]||coin}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:1px">${coin} · USDT · 1D: <b style="color:${meta.macroTrend==='ALCISTA'?'var(--green)':meta.macroTrend==='BAJISTA'?'var(--red)':'var(--muted)'}">${meta.macroTrend||'—'}</b></div>
          </div>
          <span class="tag ${meta.cls}">${meta.tag}</span>
        </div>
        <div style="font-size:20px;font-weight:600;font-family:var(--serif);margin-bottom:2px;transition:color .3s;color:${up?'var(--green)':dn?'var(--red)':'var(--text)'}" id="mkt-price-${coin}">
          ${p ? fmtP(p, coin) : '<span style="color:var(--muted);font-size:13px">...</span>'}
        </div>
        <div style="font-size:10px;margin-bottom:8px;color:${up?'var(--green)':dn?'var(--red)':'var(--muted)'}" id="mkt-chg-${coin}">—</div>

        <!-- Indicadores pills -->
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">
          ${emaPill}${macdPill}${bbPill}${patternPill}
        </div>

        <!-- KPIs -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px">
          <div class="cs"><div class="csl">RSI 4H</div><div class="csv" style="color:${typeof meta.rsi==='number'&&meta.rsi<35?'var(--green)':typeof meta.rsi==='number'&&meta.rsi>65?'var(--red)':'var(--text)'}">${meta.rsi}</div></div>
          <div class="cs"><div class="csl">RSI 1D</div><div class="csv" style="color:${typeof meta.rsi1d==='number'&&meta.rsi1d<40?'var(--green)':typeof meta.rsi1d==='number'&&meta.rsi1d>60?'var(--red)':'var(--text)'}">${meta.rsi1d||'—'}</div></div>
          <div class="cs"><div class="csl">Soporte 4H</div><div class="csv" style="color:var(--green);font-size:11px">${meta.sup}</div></div>
          <div class="cs"><div class="csl">Resist. 4H</div><div class="csv" style="color:var(--red);font-size:11px">${meta.res}</div></div>
          ${meta.atr ? `<div class="cs"><div class="csl">ATR</div><div class="csv" style="font-size:11px">${fmtP(meta.atr,coin)}</div></div>` : ''}
          ${meta.vol ? `<div class="cs"><div class="csl">Volumen</div><div class="csv" style="font-size:10px;color:${meta.vol.ratio>1.5?'var(--green)':meta.vol.ratio<0.7?'var(--red)':'var(--text)'}">${meta.vol.ratio}× avg</div></div>` : ''}
        </div>

        <!-- Confluencia -->
        ${conf ? `
        <div style="margin-bottom:10px;padding:7px 10px;background:var(--s2);border-radius:8px;border-left:3px solid ${confColor}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:10px;font-weight:600;color:var(--text)">Confluencia ${conf.bias}</span>
            <span style="font-family:var(--serif);font-size:13px;font-weight:700;color:${confColor}">${conf.score}%</span>
          </div>
          <div style="height:4px;background:var(--border);border-radius:2px">
            <div style="height:100%;width:${conf.score}%;background:${confColor};border-radius:2px;transition:width .5s"></div>
          </div>
          <div style="font-size:9px;color:var(--muted);margin-top:3px">${conf.bull}↑ alcistas · ${conf.bear}↓ bajistas</div>
        </div>` : ''}

        <button class="btn" style="width:100%;justify-content:center;font-size:10px;padding:5px" onclick="openChart('${coin}')">
          📈 Ver gráfico
        </button>
      </div>`;
  });

  root.innerHTML = `
    <div class="stl">Mercado — Binance Live</div>
    <div style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-bottom:16px">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:blink 2.5s infinite"></span>
      Precios en tiempo real · WebSocket Binance · Indicadores: RSI, EMA, MACD, BB, ATR, Volumen, Patrones
    </div>
    <div class="grid-market">${cards}</div>`;
}

function updateMarketPrice(coin, price) {
  const prev  = state.prevPrices[coin];
  const priceEl = qs(`#mkt-price-${coin}`);
  const chgEl   = qs(`#mkt-chg-${coin}`);
  const card    = qs(`#mkt-${coin}`);
  if (!priceEl) return;

  const up = prev && price > prev;
  const dn = prev && price < prev;
  const chg = prev ? ((price - prev) / prev * 100) : 0;

  priceEl.textContent = fmtP(price, coin);
  priceEl.style.color = up ? 'var(--green)' : dn ? 'var(--red)' : 'var(--accent)';
  if (chgEl) {
    chgEl.textContent = chg !== 0 ? (up ? '▲ +' : '▼ ') + Math.abs(chg).toFixed(4) + '%' : '—';
    chgEl.style.color = up ? 'var(--green)' : dn ? 'var(--red)' : 'var(--muted)';
  }
  if (card) card.style.borderColor = up ? '#BCD9C5' : dn ? '#D9BCBC' : 'var(--border)';
}

/* ── Render: Strategy ────────────────────────────────────────────────────── */
function renderStrategy() {
  const root = qs('#sec-strat');
  if (!root) return;
  const { strategy } = state;

  let html = `
    <div class="stl">◈ Estrategia Adaptada por IA</div>
    <div class="al al-b">🧠 La IA analiza tu historial real. Necesitas al menos 3 operaciones cerradas.</div>`;

  if (!strategy) {
    html += `<div class="empty"><div class="ei">🧠</div><div class="et">Cierra al menos 3 operaciones<br>y presiona <b style="color:var(--yellow)">ADAPTAR</b> en el header.</div></div>`;
  } else {
    const ea = strategy.estrategiaAdaptada || {};
    html += `
      <div class="strat-block"><div class="strat-tag">DIAGNÓSTICO</div><div style="font-size:12px;line-height:1.7">${strategy.diagnostico}</div></div>
      <div class="grid-2" style="margin-bottom:13px">
        <div class="card">
          <div class="stl" style="color:var(--green)">✓ Fortalezas</div>
          ${(strategy.fortalezas||[]).map(f=>`<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px;color:#c8f0d8"><span style="color:var(--green)">◈</span>${f}</div>`).join('')}
        </div>
        <div class="card">
          <div class="stl" style="color:var(--red)">⚠ Debilidades</div>
          ${(strategy.debilidades||[]).map(d=>`<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px;color:#f0c8c8"><span style="color:var(--red)">◈</span>${d}</div>`).join('')}
        </div>
      </div>
      ${strategy.alertas?.length ? `<div class="al al-y" style="margin-bottom:13px">⚡ ${strategy.alertas.join(' · ')}</div>` : ''}
      <div class="card" style="margin-bottom:13px">
        <div class="stl">Cambios Recomendados</div>
        ${(strategy.cambios||[]).map(c=>`
          <div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)">
            <span class="tag ${c.impacto==='ALTO'?'tr':c.impacto==='MEDIO'?'ty':'tb'}" style="flex-shrink:0">${c.impacto}</span>
            <div><div style="font-size:11px;color:var(--accent);margin-bottom:2px">${c.area}</div><div style="font-size:11px;color:var(--muted);line-height:1.5">${c.descripcion}</div></div>
          </div>`).join('')}
      </div>
      <div class="strat-block" style="border-color:var(--green)">
        <div class="strat-tag" style="color:var(--green)">ESTRATEGIA ADAPTADA</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:14px">
          <div class="cs"><div class="csl">Estilo</div><div class="csv" style="color:var(--accent)">${ea.estiloRecomendado||'—'}</div></div>
          <div class="cs"><div class="csl">Timeframe</div><div class="csv" style="color:var(--accent)">${ea.timeframe||'—'}</div></div>
          <div class="cs"><div class="csl">Riesgo/Op</div><div class="csv" style="color:var(--yellow)">${ea.riesgoRecomendado||'—'}%</div></div>
          <div class="cs"><div class="csl">Activos</div><div class="csv" style="color:var(--green);font-size:11px">${(ea.activos||[]).join(', ')}</div></div>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.6">${ea.resumen||''}</div>
        <div class="stl">Reglas</div>
        ${(ea.reglas||[]).map((r,i)=>`<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:11px"><span style="color:var(--green);font-weight:bold;min-width:22px">${String(i+1).padStart(2,'0')}</span><span>${r}</span></div>`).join('')}
      </div>`;
  }
  root.innerHTML = html;
}

/* ── Render: Profile ─────────────────────────────────────────────────────── */
function renderProfile() {
  const root = qs('#sec-profile');
  if (!root) return;
  const p = state.profile;

  const styleChips  = ['swing','scalp','position','dca'];
  const riskChips   = ['conservador','moderado','agresivo'];
  const coinChips   = ['BTC','ETH','SOL','XRP','BNB','DOGE'];

  root.innerHTML = `
    <div class="stl">◈ Mi Perfil</div>
    <div class="card">
      <div class="lbl">Estilo</div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:13px">
        ${styleChips.map(s=>`<span class="chip${p.style===s?' on':''}" onclick="setProfileField('style','${s}')">${s.charAt(0).toUpperCase()+s.slice(1)}</span>`).join('')}
      </div>
      <div class="lbl">Tolerancia al riesgo</div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:13px">
        ${riskChips.map(r=>`<span class="chip${p.risk_tolerance===r?' on':''}" onclick="setProfileField('risk_tolerance','${r}')">${r.charAt(0).toUpperCase()+r.slice(1)}</span>`).join('')}
      </div>
      <div class="lbl">Activos preferidos</div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:13px">
        ${coinChips.map(c=>`<span class="chip${p.preferred_coins.includes(c)?' on':''}" onclick="toggleCoin('${c}')">${c}</span>`).join('')}
      </div>
      <div class="lbl">Notas para la IA</div>
      <textarea id="profile-notes" class="inp" placeholder="Ej: Solo opero tendencias alcistas..." style="height:64px;resize:none;margin-bottom:12px">${p.notes}</textarea>
      <button class="btn btng" onclick="saveProfile()">✓ Guardar perfil</button>
    </div>

    <!-- TELEGRAM -->
    <div class="stl" style="margin-top:18px">◈ Notificaciones Telegram</div>
    <div class="card" id="telegram-config-panel">
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Recibe alertas instantáneas en Telegram cuando la IA detecta una oportunidad, cuando un trade llega al TP/SL, o cuando se activa el breakeven — aunque tengas el navegador cerrado.
      </div>
      <div style="font-size:10px;color:var(--muted);padding:8px 12px;background:var(--s2);border-radius:7px;margin-bottom:12px;line-height:1.6">
        <b style="color:var(--accent)">Cómo configurar:</b><br>
        1. Habla con <b>@BotFather</b> en Telegram → /newbot → copia el token<br>
        2. Habla con <b>@userinfobot</b> → copia tu Chat ID<br>
        3. En Railway añade: <code>TELEGRAM_BOT_TOKEN</code> y <code>TELEGRAM_CHAT_ID</code>
      </div>
      <div id="telegram-status-msg" style="font-size:11px;margin-bottom:10px;color:var(--muted)">Comprobando...</div>
      <button class="btn btng" style="font-size:11px;padding:7px 16px" onclick="testTelegram()">📨 Enviar mensaje de prueba</button>
    </div>`;

  // Comprobar estado de Telegram
  authFetch('/api/telegram/status').then(r => r.json()).then(data => {
    const el = qs('#telegram-status-msg');
    if (!el) return;
    if (data.configured) {
      el.innerHTML = `<span style="color:var(--green)">✓ Telegram configurado y activo</span>`;
    } else {
      el.innerHTML = `<span style="color:var(--yellow)">⚠️ Sin configurar — añade las variables en Railway</span>`;
    }
  }).catch(() => {});
}

function setProfileField(key, value) {
  state.profile[key] = value;
  saveKey('profile', state.profile);
  renderProfile();
}

function toggleCoin(coin) {
  const idx = state.profile.preferred_coins.indexOf(coin);
  if (idx > -1) state.profile.preferred_coins.splice(idx, 1);
  else state.profile.preferred_coins.push(coin);
  saveKey('profile', state.profile);
  renderProfile();
}

function saveProfile() {
  const notes = qs('#profile-notes');
  if (notes) state.profile.notes = notes.value;
  saveKey('profile', state.profile);
  showToast('✓ Perfil guardado');
}

async function testTelegram() {
  const btn       = qs('#telegram-config-panel button');
  const statusEl  = qs('#telegram-status-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando...'; }
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--muted)">Conectando con Telegram...</span>';
  try {
    const res  = await authFetch('/api/telegram/test', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      const botStr = data.botName ? ` (@${data.botName})` : '';
      showToast(`✅ Telegram funcionando${botStr} — revisa tu chat`);
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--green)">✓ Telegram activo${botStr}</span>`;
    } else {
      const errMsg = data.error || 'Error desconocido';
      showToast('❌ Telegram: ' + errMsg, true);
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">✗ ${errMsg}</span>`;
    }
  } catch (e) {
    showToast('❌ Error de red: ' + e.message, true);
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">✗ Error de red</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📨 Enviar mensaje de prueba'; }
  }
}


/* ── Render: Capital ─────────────────────────────────────────────────────── */
function renderCapital() {
  const root = qs('#sec-capital');
  if (!root) return;
  const p = state.profile;
  const lev     = p.leverage || 1;
  const riskUSD = (p.capital * p.risk_pct / 100).toFixed(2);
  const cap3    = (p.capital * p.risk_pct / 100 * 3).toFixed(2);
  const capOps  = Math.floor(50 / p.risk_pct);
  const riskColor = p.risk_pct <= 1 ? 'var(--green)' : p.risk_pct <= 3 ? 'var(--yellow)' : 'var(--red)';
  const levColor  = lev === 1 ? 'var(--green)' : lev <= 5 ? 'var(--yellow)' : 'var(--red)';
  const barW    = Math.min(p.risk_pct / 10 * 100, 100);
  const levOptions = [1, 2, 3, 5, 10, 20, 25, 50, 75];

  root.innerHTML = `
    <div class="stl">◈ Capital y Gestión de Riesgo</div>
    <div class="card">
      <div class="grid-2" style="margin-bottom:16px">
        <div>
          <label class="lbl">Capital total (USD)</label>
          <input class="inp" type="number" id="cap-input" value="${p.capital}" oninput="updateCapCalc()">
        </div>
        <div>
          <label class="lbl">Riesgo por operación (%)</label>
          <input class="inp" type="number" id="risk-input" value="${p.risk_pct}" min="0.1" max="10" step="0.1" oninput="updateCapCalc()">
        </div>
      </div>

      <div class="lbl" style="margin-bottom:8px">Apalancamiento por defecto</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
        ${levOptions.map(x => `
          <button id="lev-btn-${x}" class="btn" style="padding:6px 12px;font-size:11px;font-weight:bold;
            ${lev===x ? `background:rgba(251,191,36,.18);border-color:var(--yellow);color:var(--yellow)` : ''}"
            onclick="setLeverage(${x})">${x}x</button>
        `).join('')}
      </div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:14px;padding:8px;background:rgba(0,0,0,.2);border-radius:6px;line-height:1.6">
        ${lev === 1
          ? '✓ Sin apalancamiento. Riesgo máximo = capital en riesgo por operación.'
          : lev >= 50
          ? `<span style="color:var(--red)">⚠️ ${lev}x — LEVERAGE EXTREMO. Un movimiento del ${(100/lev).toFixed(1)}% en tu contra liquida el margen. Solo para setups con SL muy ajustado y alta convicción.</span>`
          : `⚡ ${lev}x — Las ganancias <b style="color:var(--green)">y pérdidas</b> se multiplican por ${lev}. Usa con precaución.`}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:14px">
        <div class="cs"><div class="csl">Riesgo/Op</div><div class="csv" id="cap-rv" style="color:${riskColor}">${p.risk_pct}%</div></div>
        <div class="cs"><div class="csl">En USD</div><div class="csv" id="cap-rusd">$${riskUSD}</div></div>
        <div class="cs"><div class="csl">Max 3 ops</div><div class="csv" id="cap-r3" style="color:var(--muted)">$${cap3}</div></div>
        <div class="cs"><div class="csl">Capacidad</div><div class="csv" id="cap-ops" style="color:var(--accent)">~${capOps} ops</div></div>
        <div class="cs"><div class="csl">Apalancamiento</div><div class="csv" style="color:${levColor}">${lev}x</div></div>
      </div>
      <div class="lbl">Nivel de riesgo</div>
      <div class="bar" style="margin-bottom:12px"><div class="bf" id="cap-bar" style="width:${barW}%;background:${riskColor}"></div></div>
      <button class="btn btng" onclick="saveCapital()">✓ Guardar</button>
    </div>

    <div class="card">
      <div class="stl">Monedas seguidas</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">
        Selecciona qué monedas aparecen en Mercado y se usan en el análisis IA. Mínimo 2, máximo 10.
      </div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:14px">
        ${ALL_COINS.map(c => {
          const active = state.watchedCoins.includes(c);
          return `<span class="chip${active ? ' on' : ''}" onclick="toggleWatchedCoin('${c}')">${c} <span style="font-size:9px;color:var(--muted)">${COIN_NAMES[c] || ''}</span></span>`;
        }).join('')}
      </div>
      <div style="font-size:10px;color:var(--muted)">
        Activas: <b style="color:var(--text)">${state.watchedCoins.join(', ')}</b>
      </div>
    </div>`;
}

function updateCapCalc() {
  const cap  = parseFloat(qs('#cap-input')?.value)  || 1000;
  const risk = parseFloat(qs('#risk-input')?.value) || 2;
  const riskColor = risk <= 1 ? 'var(--green)' : risk <= 3 ? 'var(--yellow)' : 'var(--red)';
  const set = (id, val, color) => {
    const el = qs('#' + id);
    if (el) { el.textContent = val; if (color) el.style.color = color; }
  };
  set('cap-rv',   risk + '%',                                riskColor);
  set('cap-rusd', '$' + (cap * risk / 100).toFixed(2),       '');
  set('cap-r3',   '$' + (cap * risk / 100 * 3).toFixed(2),   '');
  set('cap-ops',  '~' + Math.floor(50 / risk) + ' ops',      '');
  const bar = qs('#cap-bar');
  if (bar) { bar.style.width = Math.min(risk/10*100,100) + '%'; bar.style.background = riskColor; }
}

function toggleWatchedCoin(coin) {
  const idx = state.watchedCoins.indexOf(coin);
  if (idx > -1) {
    if (state.watchedCoins.length <= 2) { showToast('Mínimo 2 monedas activas', true); return; }
    state.watchedCoins.splice(idx, 1);
  } else {
    if (state.watchedCoins.length >= 10) { showToast('Máximo 10 monedas activas', true); return; }
    state.watchedCoins.push(coin);
  }
  saveKey('watchedCoins', state.watchedCoins);
  initMarketMeta(state.watchedCoins);
  connectWS(); // reconectar WS con la nueva lista
  fetchMarketMeta();
  renderCapital();
  if (state.currentTab === 'mkt') renderMkt();
}

function setLeverage(lev) {
  state.profile.leverage = lev;
  saveKey('profile', state.profile);
  renderCapital();
}

function saveCapital() {
  state.profile.capital  = parseFloat(qs('#cap-input')?.value)  || 1000;
  state.profile.risk_pct = parseFloat(qs('#risk-input')?.value) || 2;
  // leverage ya se guarda en setLeverage al hacer clic
  saveKey('profile', state.profile);
  showToast('✓ Capital guardado');
}

/* ── Render: Storage panel ───────────────────────────────────────────────── */
function renderStoragePanel() {
  const p = qs('#storage-info');
  if (p) {
    p.innerHTML = `
      <div class="storage-panel-title">💾 DATOS GUARDADOS</div>
      <p>${state.activeTrades.length} activas · ${state.closedTrades.length} cerradas</p>
      <p>${state.alerts.length} alertas</p>
      <button class="btn btnr" style="font-size:9px;padding:4px 8px;width:100%;letter-spacing:.5px;margin-top:8px" onclick="resetAll()">🗑 Resetear todo</button>`;
  }
}

function resetAll() {
  if (!confirm('¿Borrar todos los datos guardados? Esta acción no se puede deshacer.')) return;
  Object.values(STORAGE_KEYS).forEach(k => storage.del(k));
  state.activeTrades  = [];
  state.closedTrades  = [];
  state.alerts        = [];
  state.strategy      = null;
  state.profile       = { ...DEFAULT_PROFILE };
  state.scanInterval  = 5;
  state.watchedCoins  = [...DEFAULT_WATCHED_COINS];
  state.pending       = [];
  state.priceAlerts   = [];
  state.scanLog       = [];
  state.aiHistory     = [];
  stopScanner();
  renderAll();
  renderStoragePanel();
  showToast('Todos los datos han sido borrados.');
}

/* ── Navigation ──────────────────────────────────────────────────────────── */
function setTab(id) {
  state.currentTab = id;
  qsa('.nb').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  qsa('.sec').forEach(s => s.classList.toggle('on', s.id === 'sec-' + id));

  const renders = {
    ops:      renderOps,
    alerts:   renderAlerts,
    perf:     renderPerf,
    mkt:      renderMkt,
    strat:    renderStrategy,
    profile:  renderProfile,
    capital:  renderCapital,
    backtest: renderBacktest,
    goals:    renderGoals,
  };
  if (renders[id]) renders[id]();
}

/* ── Cierre con precio real ───────────────────────────────────────────────── */
function closeTradeAtMarket(tradeId) {
  const trade = state.activeTrades.find(t => t.id === tradeId);
  if (!trade) return;

  const coin      = coinOf(trade.par);
  const mktPrice  = state.prices[coin] || trade.entrada;

  // Mostrar mini-modal de cierre
  const existing = qs('#close-price-modal');
  if (existing) existing.remove();

  const modal = el('div', '');
  modal.id = 'close-price-modal';
  modal.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(44,40,37,.25);backdrop-filter:blur(3px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .2s ease">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;width:100%;max-width:380px;box-shadow:var(--shadow-lg);overflow:hidden">
        <div style="padding:16px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-family:var(--serif);font-size:15px;font-weight:600;color:var(--text)">Cerrar ${trade.par}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px">${trade.tipo} · Entrada ${fmtP(trade.entrada, coin)}</div>
          </div>
          <button onclick="qs('#close-price-modal').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:18px;line-height:1;padding:4px">×</button>
        </div>
        <div style="padding:16px 18px">
          <div style="margin-bottom:14px">
            <label class="lbl">Precio de ejecución real</label>
            <input class="inp" type="number" id="cpm-price" value="${mktPrice}" step="any"
              style="font-family:var(--serif);font-size:18px;font-weight:600;text-align:center"/>
            <div style="font-size:10px;color:var(--muted);margin-top:5px;text-align:center">
              Precio Binance ahora: <b style="color:var(--text)">${fmtP(mktPrice, coin)}</b> — edítalo si ejecutaste a otro precio
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label class="lbl">Notas del cierre (opcional)</label>
            <textarea class="inp" id="cpm-notes" rows="2" placeholder="Ej: cerré antes del TP por noticias macro..."></textarea>
          </div>
          <div id="cpm-preview" style="background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;text-align:center"></div>
          <button class="btn btng" style="width:100%;justify-content:center;font-size:12px;padding:10px" onclick="confirmCloseWithPrice('${tradeId}')">
            ✓ Confirmar cierre
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Preview en tiempo real
  const priceInput = qs('#cpm-price');
  function updatePreview() {
    const exitPrice = parseFloat(priceInput.value) || mktPrice;
    const lev  = trade.leverage || 1;
    const pnl  = trade.tipo === 'LONG'
      ? (exitPrice - trade.entrada) * trade.size * lev
      : (trade.entrada - exitPrice) * trade.size * lev;
    const pct  = trade.tipo === 'LONG'
      ? ((exitPrice - trade.entrada) / trade.entrada) * 100 * lev
      : ((trade.entrada - exitPrice) / trade.entrada) * 100 * lev;
    const color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    qs('#cpm-preview').innerHTML = `
      <span style="color:var(--muted)">P&L estimado: </span>
      <span style="font-family:var(--serif);font-size:16px;font-weight:600;color:${color}">${fmtUSD(pnl)}</span>
      <span style="color:var(--muted);font-size:11px"> (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`;
  }
  priceInput.addEventListener('input', updatePreview);
  updatePreview();
}

function confirmCloseWithPrice(tradeId) {
  const trade     = state.activeTrades.find(t => t.id === tradeId);
  if (!trade) return;
  const coin      = coinOf(trade.par);
  const exitPrice = parseFloat(qs('#cpm-price')?.value) || state.prices[coin] || trade.entrada;
  const notes     = qs('#cpm-notes')?.value?.trim() || '';
  const lev       = trade.leverage || 1;
  const rawPnl    = trade.tipo === 'LONG'
    ? (exitPrice - trade.entrada) * trade.size * lev
    : (trade.entrada - exitPrice) * trade.size * lev;
  const result = rawPnl >= 0 ? 'WIN' : 'LOSS';

  const idx = state.activeTrades.findIndex(t => t.id === tradeId);
  if (idx === -1) return;
  const closed = { ...trade, result, pnl: rawPnl, exitPrice, notes, closedAt: nowFull() };
  state.closedTrades.unshift(closed);
  state.activeTrades.splice(idx, 1);
  saveKey('activeTrades', state.activeTrades);
  saveKey('closedTrades', state.closedTrades);
  syncTradesToServer();

  qs('#close-price-modal')?.remove();
  showToast(`${trade.par} cerrada a ${fmtP(exitPrice, coin)} — ${fmtUSD(rawPnl)}`, result === 'LOSS');
  renderAll();

  // Flash close en Bitunix si está conectado y la posición existía en el exchange
  if (bitunix.configured && (trade.bitunixPos || trade.bitunixOrderId)) {
    flashCloseBitunix(trade);
  }
}

function toggleTradeNotes(id) {
  const panel = qs(`#notes-panel-${id}`);
  if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function saveTradeNotes(id) {
  const input = qs(`#notes-input-${id}`);
  if (!input) return;
  const trade = state.activeTrades.find(t => t.id === id);
  if (!trade) return;
  trade.notes = input.value.trim();
  saveKey('activeTrades', state.activeTrades);
  showToast('📝 Nota guardada');
  renderOps();
}

/* ── Proposal handlers ───────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════
   MODAL DE CONFIRMACIÓN DE TRADE
   ═══════════════════════════════════════════════════════════ */

/**
 * Muestra un modal de confirmación antes de ejecutar en Bitunix.
 * Devuelve una Promise que resuelve true (confirmar) o false (cancelar).
 */
function showTradeConfirmModal(trade) {
  return new Promise(resolve => {
    const existing = document.getElementById('trade-confirm-modal');
    if (existing) existing.remove();

    const coin    = coinOf(trade.par);
    const lc      = trade.tipo === 'LONG' ? 'var(--green)' : 'var(--red)';
    const money   = calcProposalMoney(trade);
    const tpLabel = trade.tp2 ? `TP1 🎯 ${fmtP(trade.tp1, coin)} → TP2 ${fmtP(trade.tp2, coin)}` : `TP1 🎯 ${fmtP(trade.tp1, coin)}`;

    const div = document.createElement('div');
    div.id = 'trade-confirm-modal';
    div.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .15s ease">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:400px;box-shadow:var(--shadow-lg);overflow:hidden">

          <!-- Header -->
          <div style="padding:16px 20px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
            <div style="width:34px;height:34px;border-radius:8px;background:rgba(255,200,0,.1);border:1px solid rgba(255,200,0,.3);display:flex;align-items:center;justify-content:center;font-size:16px">⚠️</div>
            <div>
              <div style="font-weight:700;font-size:14px;color:var(--text)">Confirmar orden en Bitunix</div>
              <div style="font-size:10px;color:var(--muted)">Esta acción enviará una orden real a tu cuenta</div>
            </div>
          </div>

          <!-- Trade summary -->
          <div style="padding:16px 20px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
              <span style="font-family:var(--display);font-size:18px;font-weight:800;color:#fff">${trade.par}</span>
              <span style="font-size:11px;padding:3px 9px;border-radius:4px;border:1px solid ${lc}50;color:${lc};font-weight:600">${trade.tipo}</span>
              ${trade.leverage > 1 ? `<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:var(--yellow)">${trade.leverage}x</span>` : ''}
            </div>

            <!-- Niveles -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
              <div style="padding:8px 12px;background:var(--s2);border-radius:8px;border-left:3px solid var(--accent)">
                <div style="font-size:9px;color:var(--muted);margin-bottom:2px">ENTRADA (mercado)</div>
                <div style="font-size:13px;font-weight:700;color:var(--accent)">${fmtP(trade.entrada, coin)}</div>
              </div>
              <div style="padding:8px 12px;background:var(--s2);border-radius:8px;border-left:3px solid var(--red)">
                <div style="font-size:9px;color:var(--muted);margin-bottom:2px">STOP LOSS</div>
                <div style="font-size:13px;font-weight:700;color:var(--red)">${fmtP(trade.stopLoss, coin)}</div>
              </div>
              <div style="padding:8px 12px;background:var(--s2);border-radius:8px;border-left:3px solid var(--green);grid-column:span 2">
                <div style="font-size:9px;color:var(--muted);margin-bottom:2px">TAKE PROFIT (Bitunix cierra aquí)</div>
                <div style="font-size:13px;font-weight:700;color:var(--green)">${tpLabel}</div>
              </div>
            </div>

            <!-- Dinero -->
            <div style="padding:10px 14px;background:rgba(0,0,0,.25);border-radius:8px;border:1px solid var(--border);margin-bottom:14px">
              <div style="font-size:9px;color:var(--muted);letter-spacing:.5px;margin-bottom:8px">💰 RESUMEN FINANCIERO</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
                <div>
                  <div style="font-size:9px;color:var(--muted)">Riesgo máximo</div>
                  <div style="font-size:13px;font-weight:700;color:var(--red)">-$${money.riskUSD.toFixed(2)} <span style="font-size:9px;color:var(--muted)">(${money.riskPct}%)</span></div>
                </div>
                <div>
                  <div style="font-size:9px;color:var(--muted)">Ganancia potencial</div>
                  <div style="font-size:13px;font-weight:700;color:var(--green)">+$${money.maxWin.toFixed(2)}</div>
                </div>
                <div>
                  <div style="font-size:9px;color:var(--muted)">Margen utilizado</div>
                  <div style="font-size:13px;font-weight:700;color:var(--text)">$${money.margin.toFixed(2)} <span style="font-size:9px;color:var(--muted)">(${money.capitalPct.toFixed(1)}%)</span></div>
                </div>
                <div>
                  <div style="font-size:9px;color:var(--muted)">Posición total</div>
                  <div style="font-size:13px;font-weight:700;color:var(--accent)">$${money.notional.toFixed(2)}</div>
                </div>
              </div>
            </div>

            ${money.warnings.length ? `<div style="margin-bottom:12px">${money.warnings.map(w=>`<div style="font-size:11px;color:var(--red);padding:4px 0">${w}</div>`).join('')}</div>` : ''}

            <!-- Aviso legal -->
            <div style="font-size:10px;color:var(--muted);padding:8px 12px;background:rgba(255,200,0,.05);border:1px solid rgba(255,200,0,.15);border-radius:6px;margin-bottom:14px;line-height:1.5">
              ⚠️ Esta orden se ejecutará <b style="color:var(--yellow)">inmediatamente al precio de mercado</b>. El precio de entrada puede diferir ligeramente del mostrado.
            </div>

            <!-- Botones -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <button id="confirm-cancel-btn" class="btn" style="padding:10px;font-size:12px;font-weight:600">✕ Cancelar</button>
              <button id="confirm-execute-btn" class="btn btng" style="padding:10px;font-size:12px;font-weight:600">📡 Ejecutar ahora</button>
            </div>
          </div>
        </div>
      </div>`;

    document.body.appendChild(div);

    const close = (result) => { div.remove(); resolve(result); };
    document.getElementById('confirm-cancel-btn').onclick  = () => close(false);
    document.getElementById('confirm-execute-btn').onclick = () => close(true);
    // Click fuera del modal = cancelar
    div.querySelector('div[style*="inset:0"]').addEventListener('click', e => {
      if (e.target === e.currentTarget) close(false);
    });
  });
}

async function onAcceptProposal(i) {
  const p = state.pending[i];
  if (!p) return;

  const execError = checkTradeExecutability(p);
  if (execError) { showToast(execError, true); return; }

  const trade = buildTrade(p);

  if (bitunix.configured) {
    const confirmed = await showTradeConfirmModal(trade);
    if (!confirmed) return;

    const result = await placeBitunixOrder(trade);
    if (!result || !result.ok) {
      showToast(`❌ Trade no registrado: Bitunix rechazó la orden.`, true);
      return;
    }
  }

  commitTrade(trade);
  state.pending.splice(i, 1);
  renderAll();
}
function onRejectProposal(i) {
  state.pending.splice(i, 1);
  showToast('Propuesta rechazada.');
  renderOps();
}

/* ── Scanner interval ────────────────────────────────────────────────────── */
function setScanIntervalVal(m) {
  state.scanInterval = m;
  saveKey('scanInterval', m);
  if (state.scannerOn) { stopScanner(); }
  renderAlerts();
}

/* ── Header buttons ──────────────────────────────────────────────────────── */
async function onGenerate() {
  const btn = qs('#btn-gen');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ANALIZANDO...'; }
  state.aiMsg = null;
  try {
    const data = await aiGenerateProposals();
    state.pending = data.proposals || [];
    state.aiMsg   = { market: data.analisis_mercado, rec: data.recomendacion_ia };
    setTab('ops');
    showToast(`✓ IA generó ${data.proposals?.length || 0} propuesta(s) con precios reales.`);
  } catch (e) {
    showToast('Error IA: ' + e.message, true);
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '<span>⚡</span> ANALIZAR AHORA'; }
}

async function onAdaptStrategy() {
  if (state.closedTrades.length < 3) { showToast('Necesitas al menos 3 ops cerradas', true); return; }
  const btn = qs('#btn-adapt');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ANALIZANDO...'; }
  try {
    state.strategy = await aiAdaptStrategy();
    saveKey('strategy', state.strategy);
    setTab('strat');
    showToast('🧠 Estrategia adaptada con tu historial real.');
  } catch (e) {
    showToast('Error IA: ' + e.message, true);
  }
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '🧠 ADAPTAR';
    btn.style.display = state.closedTrades.length >= 3 ? '' : 'none';
  }
}

/* ── Full render ─────────────────────────────────────────────────────────── */
function renderAll() {
  renderStoragePanel();
  renderBalanceWidget();
  updateAlertBadge();
  const adaptBtn = qs('#btn-adapt');
  if (adaptBtn) adaptBtn.style.display = state.closedTrades.length >= 3 ? '' : 'none';

  const id = state.currentTab;
  if (id === 'ops')      renderOps();
  if (id === 'alerts')   renderAlerts();
  if (id === 'perf')     renderPerf();
  if (id === 'mkt')      renderMkt();
  if (id === 'strat')    renderStrategy();
  if (id === 'profile')  renderProfile();
  if (id === 'capital')  renderCapital();
  if (id === 'backtest') renderBacktest();
  if (id === 'goals')    renderGoals();
}

/* ══════════════════════════════════════════════════════════
   MODO OSCURO
   ══════════════════════════════════════════════════════════ */
function applyDarkMode(on) {
  // Nuevo: dark es el default, 'light' es el modo claro
  // 'on' = quiere modo oscuro (behavior original)
  document.body.classList.toggle('light', !on);
  const btn = qs('#dark-toggle');
  if (btn) btn.textContent = on ? '☀️' : '🌙';
  if (qs('#tv-modal')) qs('#tv-modal').remove();
}

function toggleDarkMode() {
  state.darkMode = !state.darkMode;
  saveKey('darkMode', state.darkMode);
  applyDarkMode(state.darkMode);
}

/* ══════════════════════════════════════════════════════════
   ZONAS S/R MEJORADAS (confluencia de toques)
   ══════════════════════════════════════════════════════════ */
function calcSRZones(highs, lows, closes, tolerance = 0.015) {
  // Agrupa swings por proximidad para encontrar zonas con múltiples toques
  const swingH = [], swingL = [];
  const n = Math.min(closes.length - 2, 100);
  for (let i = 1; i < n; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i+1]) swingH.push(highs[i]);
    if (lows[i]  < lows[i-1]  && lows[i]  < lows[i+1])  swingL.push(lows[i]);
  }

  function clusterLevels(levels) {
    const clusters = [];
    levels.forEach(l => {
      const existing = clusters.find(c => Math.abs(c.level - l) / c.level < tolerance);
      if (existing) { existing.touches++; existing.level = (existing.level + l) / 2; }
      else clusters.push({ level: l, touches: 1 });
    });
    return clusters.filter(c => c.touches >= 1).sort((a,b) => b.touches - a.touches);
  }

  const price = closes[closes.length - 1];
  const supZones = clusterLevels(swingL).filter(z => z.level < price).sort((a,b) => b.level - a.level);
  const resZones = clusterLevels(swingH).filter(z => z.level > price).sort((a,b) => a.level - b.level);

  return {
    sup1: supZones[0] || null,
    sup2: supZones[1] || null,
    res1: resZones[0] || null,
    res2: resZones[1] || null,
  };
}

/* ══════════════════════════════════════════════════════════
   CALENDARIO ECONÓMICO
   ══════════════════════════════════════════════════════════ */
let calendarData = [];
let calendarLastFetch = 0;

async function fetchEconomicCalendar() {
  // Solo refrescar cada 30 min
  if (Date.now() - calendarLastFetch < 30 * 60 * 1000 && calendarData.length > 0) return calendarData;
  try {
    // ForexFactory JSON público (semana actual)
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!res.ok) throw new Error('no disponible');
    const data = await res.json();
    // Filtrar solo impacto alto y medio, próximas 48h
    const now  = Date.now();
    const end  = now + 48 * 3600 * 1000;
    calendarData = data
      .filter(e => {
        const ts = new Date(e.date).getTime();
        return ts >= now - 3600000 && ts <= end && (e.impact === 'High' || e.impact === 'Medium');
      })
      .map(e => ({
        time:     new Date(e.date).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}),
        date:     new Date(e.date).toLocaleDateString('es-ES',{weekday:'short',day:'numeric',month:'short'}),
        currency: e.currency,
        title:    e.title,
        impact:   e.impact,
        forecast: e.forecast || '—',
        previous: e.previous || '—',
      }))
      .slice(0, 20);
    calendarLastFetch = Date.now();
    return calendarData;
  } catch {
    // Fallback: placeholder si la API no responde
    calendarData = [];
    return [];
  }
}

function buildCalendarContext() {
  if (calendarData.length === 0) return 'Sin datos de calendario económico disponibles.';
  const high = calendarData.filter(e => e.impact === 'High');
  const med  = calendarData.filter(e => e.impact === 'Medium');
  const lines = [
    high.length > 0 ? `⚠️ ALTO IMPACTO próx. 48h: ${high.map(e=>`${e.currency} ${e.title} (${e.date} ${e.time})`).join(' | ')}` : '',
    med.length  > 0 ? `📋 Medio impacto: ${med.slice(0,3).map(e=>`${e.currency} ${e.title}`).join(' | ')}` : '',
  ].filter(Boolean);
  return lines.join('\n') || 'Sin eventos relevantes próximas 48h.';
}

function renderCalendarSection() {
  const root = qs('#calendar-section');
  if (!root) return;

  if (calendarData.length === 0) {
    root.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:10px 0">
      Cargando calendario... <button class="btn" style="padding:3px 8px;font-size:10px" onclick="refreshCalendar()">↻ Cargar</button>
    </div>`;
    return;
  }

  const highEvents = calendarData.filter(e => e.impact === 'High');
  const rows = calendarData.map(e => `
    <div class="cal-event">
      <div class="cal-impact ${e.impact === 'High' ? 'high' : 'medium'}" title="${e.impact} Impact"></div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;color:var(--text);font-size:11px">${e.title}</div>
        <div style="font-size:9px;color:var(--muted)">${e.currency} · ${e.date} ${e.time}</div>
      </div>
      <div style="text-align:right;font-size:10px;color:var(--muted)">
        <div>P: ${e.previous}</div>
        <div>E: ${e.forecast}</div>
      </div>
    </div>`).join('');

  root.innerHTML = `
    ${highEvents.length > 0 ? `
    <div style="padding:8px 12px;background:#F4EBEB;border:1px solid #D9BCBC;border-radius:8px;margin-bottom:10px;font-size:11px;color:#8A4A4A">
      ⚠️ <b>${highEvents.length} evento${highEvents.length>1?'s':''} de ALTO impacto</b> en próximas 48h — considera reducir tamaño de posición
    </div>` : `
    <div style="padding:7px 12px;background:#E9F4EC;border:1px solid #BCD9C5;border-radius:8px;margin-bottom:10px;font-size:11px;color:#4A7A5A">
      ✓ Sin eventos de alto impacto en próximas 48h
    </div>`}
    ${rows}
    <div style="font-size:9px;color:var(--muted);margin-top:8px;text-align:right">
      Fuente: ForexFactory · Solo USD/BTC relevantes · <button onclick="refreshCalendar()" style="background:none;border:none;cursor:pointer;color:var(--accent);font-size:9px">↻ Actualizar</button>
    </div>`;
}

async function refreshCalendar() {
  calendarLastFetch = 0; // forzar refresh
  await fetchEconomicCalendar();
  renderCalendarSection();
  if (state.currentTab === 'alerts') renderAlerts();
}

/* ══════════════════════════════════════════════════════════
   BACKTESTING VISUAL
   ══════════════════════════════════════════════════════════ */
const BT_FILTERS = {
  minRR:   0,
  minConf: 0,
  tipo:    'ALL',
  setup:   '',
  par:     'ALL',
};

function runBacktest(trades, filters = BT_FILTERS) {
  let filtered = trades.filter(t => {
    if (filters.tipo !== 'ALL' && t.tipo !== filters.tipo) return false;
    if (filters.par  !== 'ALL' && t.par  !== filters.par)  return false;
    if (filters.minConf > 0 && (t.confianza || 0) < filters.minConf) return false;
    if (filters.minRR  > 0 && parseFloat(t.rr || 0) < filters.minRR) return false;
    if (filters.setup && !(t.setup || '').toLowerCase().includes(filters.setup.toLowerCase())) return false;
    return true;
  });

  const wins   = filtered.filter(t => t.result === 'WIN').length;
  const losses = filtered.filter(t => t.result === 'LOSS').length;
  const totalPnl   = filtered.reduce((a,t) => a+(t.pnl||0), 0);
  const grossWin   = filtered.filter(t=>t.result==='WIN').reduce((a,t)=>a+(t.pnl||0),0);
  const grossLoss  = Math.abs(filtered.filter(t=>t.result==='LOSS').reduce((a,t)=>a+(t.pnl||0),0));
  const winRate    = filtered.length > 0 ? (wins/filtered.length*100).toFixed(1) : 0;
  const pf         = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : grossWin > 0 ? '∞' : '0';
  const avgPnl     = filtered.length > 0 ? (totalPnl/filtered.length).toFixed(2) : 0;

  return { filtered, wins, losses, total: filtered.length, totalPnl, winRate, pf, avgPnl };
}

function renderBacktest() {
  const root = qs('#sec-backtest');
  if (!root) return;

  const { closedTrades } = state;
  const allPairs  = [...new Set(closedTrades.map(t => t.par))];
  const result    = runBacktest(closedTrades, BT_FILTERS);

  // Equity curve del backtest
  let cap = state.profile.capital;
  const pts = [cap, ...result.filtered.slice().reverse().map(t => { cap += (t.pnl||0); return cap; })];
  const maxP = Math.max(...pts), minP = Math.min(...pts);
  const bars = pts.map((v,i) => {
    const h = maxP===minP ? 50 : ((v-minP)/(maxP-minP))*85+15;
    const prev = pts[i-1];
    const col = !prev ? 'var(--accent)' : v>=prev ? 'var(--green)' : 'var(--red)';
    return `<div class="equity-bar" style="height:${h}%;background:${col}99" title="$${v.toFixed(0)}"></div>`;
  }).join('');

  const tradeRows = result.filtered.slice(0, 30).map(t => `
    <div class="hist-row" style="padding:7px 0">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span class="tag ${t.result==='WIN'?'tg':'tr'}">${t.result}</span>
        <span style="font-weight:600">${t.par}</span>
        <span style="color:var(--muted);font-size:10px">${t.tipo}</span>
        <span style="font-size:10px;color:var(--muted)">R:R ${t.rr||'?'} · ${t.confianza||'?'}% conf</span>
        <span style="font-size:9px;color:var(--subtle)">${t.closedAt||''}</span>
      </div>
      <span style="font-family:var(--serif);font-weight:600;color:${(t.pnl||0)>=0?'var(--green)':'var(--red)'}">${fmtUSD(t.pnl||0)}</span>
    </div>`).join('');

  root.innerHTML = `
    <div class="stl">◈ Backtesting Visual</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:16px">Filtra tu historial real para descubrir qué setups, pares y condiciones funcionan mejor.</div>

    <!-- Filtros -->
    <div class="card">
      <div class="stl">Filtros</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px">
        <div>
          <div class="lbl">Dirección</div>
          <select class="inp" id="bt-tipo" onchange="applyBtFilter()" style="font-size:12px">
            <option value="ALL">Todas</option>
            <option value="LONG">Solo LONG</option>
            <option value="SHORT">Solo SHORT</option>
          </select>
        </div>
        <div>
          <div class="lbl">Par</div>
          <select class="inp" id="bt-par" onchange="applyBtFilter()" style="font-size:12px">
            <option value="ALL">Todos</option>
            ${allPairs.map(p=>`<option value="${p}">${p}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="lbl">Confianza IA mínima</div>
          <input class="inp" type="number" id="bt-conf" value="0" min="0" max="100" onchange="applyBtFilter()" style="font-size:12px"/>
        </div>
        <div>
          <div class="lbl">R:R mínimo</div>
          <input class="inp" type="number" id="bt-rr" value="0" min="0" step="0.1" onchange="applyBtFilter()" style="font-size:12px"/>
        </div>
        <div>
          <div class="lbl">Setup contiene</div>
          <input class="inp" type="text" id="bt-setup" placeholder="Ej: RSI, EMA..." onchange="applyBtFilter()" style="font-size:12px"/>
        </div>
      </div>
      <button class="btn" onclick="resetBtFilters()" style="font-size:10px">↺ Limpiar filtros</button>
    </div>

    <!-- Resultados -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px" id="bt-stats">
      <div class="bt-stat"><div class="bt-stat-lbl">Ops filtradas</div><div class="bt-stat-val" id="bt-total">${result.total}</div></div>
      <div class="bt-stat"><div class="bt-stat-lbl">Win Rate</div><div class="bt-stat-val" style="color:${parseFloat(result.winRate)>=50?'var(--green)':'var(--red)'}" id="bt-wr">${result.winRate}%</div></div>
      <div class="bt-stat"><div class="bt-stat-lbl">P&L Total</div><div class="bt-stat-val" style="color:${result.totalPnl>=0?'var(--green)':'var(--red)'}" id="bt-pnl">${fmtUSD(result.totalPnl)}</div></div>
      <div class="bt-stat"><div class="bt-stat-lbl">Profit Factor</div><div class="bt-stat-val" style="color:${parseFloat(result.pf)>=1?'var(--green)':'var(--red)'}" id="bt-pf">${result.pf}</div></div>
      <div class="bt-stat"><div class="bt-stat-lbl">Media/op</div><div class="bt-stat-val" style="color:${parseFloat(result.avgPnl)>=0?'var(--green)':'var(--red)'}" id="bt-avg">${fmtUSD(parseFloat(result.avgPnl))}</div></div>
    </div>

    <!-- Curva -->
    <div class="card">
      <div class="stl">Curva de Capital Filtrada</div>
      ${pts.length > 1 ? `<div class="equity-bars" id="bt-curve">${bars}</div>` : `<div class="empty" style="padding:20px"><div class="et">Sin datos para los filtros actuales.</div></div>`}
    </div>

    <!-- Trades -->
    <div class="card">
      <div class="stl">Operaciones (${result.total})</div>
      <div id="bt-trades">${tradeRows || '<div style="color:var(--muted);font-size:11px;padding:10px 0">Sin operaciones para estos filtros.</div>'}</div>
    </div>`;
}

function applyBtFilter() {
  BT_FILTERS.tipo    = qs('#bt-tipo')?.value  || 'ALL';
  BT_FILTERS.par     = qs('#bt-par')?.value   || 'ALL';
  BT_FILTERS.minConf = parseFloat(qs('#bt-conf')?.value) || 0;
  BT_FILTERS.minRR   = parseFloat(qs('#bt-rr')?.value)   || 0;
  BT_FILTERS.setup   = qs('#bt-setup')?.value || '';

  const result = runBacktest(state.closedTrades, BT_FILTERS);

  // Update stats
  const set = (id, val, color) => {
    const el = qs('#'+id);
    if (el) { el.textContent = val; if (color) el.style.color = color; }
  };
  set('bt-total', result.total);
  set('bt-wr',    result.winRate+'%', parseFloat(result.winRate)>=50?'var(--green)':'var(--red)');
  set('bt-pnl',   fmtUSD(result.totalPnl), result.totalPnl>=0?'var(--green)':'var(--red)');
  set('bt-pf',    result.pf, parseFloat(result.pf)>=1?'var(--green)':'var(--red)');
  set('bt-avg',   fmtUSD(parseFloat(result.avgPnl)), parseFloat(result.avgPnl)>=0?'var(--green)':'var(--red)');

  // Update curve
  let cap = state.profile.capital;
  const pts = [cap, ...result.filtered.slice().reverse().map(t => { cap += (t.pnl||0); return cap; })];
  const maxP = Math.max(...pts), minP = Math.min(...pts);
  const curve = qs('#bt-curve');
  if (curve) {
    curve.innerHTML = pts.map((v,i) => {
      const h = maxP===minP?50:((v-minP)/(maxP-minP))*85+15;
      const prev=pts[i-1], col=!prev?'var(--accent)':v>=prev?'var(--green)':'var(--red)';
      return `<div class="equity-bar" style="height:${h}%;background:${col}99" title="$${v.toFixed(0)}"></div>`;
    }).join('');
  }

  // Update trades list
  const trd = qs('#bt-trades');
  if (trd) {
    trd.innerHTML = result.filtered.slice(0,30).map(t => `
      <div class="hist-row" style="padding:7px 0">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="tag ${t.result==='WIN'?'tg':'tr'}">${t.result}</span>
          <span style="font-weight:600">${t.par}</span>
          <span style="color:var(--muted);font-size:10px">${t.tipo}</span>
          <span style="font-size:10px;color:var(--muted)">R:R ${t.rr||'?'} · ${t.confianza||'?'}% conf</span>
        </div>
        <span style="font-family:var(--serif);font-weight:600;color:${(t.pnl||0)>=0?'var(--green)':'var(--red)'}">${fmtUSD(t.pnl||0)}</span>
      </div>`).join('') || '<div style="color:var(--muted);font-size:11px;padding:10px 0">Sin operaciones para estos filtros.</div>';
  }
}

function resetBtFilters() {
  Object.assign(BT_FILTERS, { minRR:0, minConf:0, tipo:'ALL', setup:'', par:'ALL' });
  const s = (id, v) => { const el=qs('#'+id); if(el) el.value=v; };
  s('bt-tipo','ALL'); s('bt-par','ALL'); s('bt-conf','0'); s('bt-rr','0'); s('bt-setup','');
  applyBtFilter();
}

/* ══════════════════════════════════════════════════════════
   SISTEMA DE OBJETIVOS
   ══════════════════════════════════════════════════════════ */
function addGoal(title, targetPnl, deadline) {
  const goal = {
    id:        uid(),
    title,
    targetPnl: parseFloat(targetPnl),
    deadline,
    createdAt: nowFull(),
    startCapital: state.profile.capital,
  };
  state.goals.push(goal);
  saveKey('goals', state.goals);
  renderGoals();
  showToast(`🎯 Objetivo "${title}" creado`);
}

function deleteGoal(id) {
  state.goals = state.goals.filter(g => g.id !== id);
  saveKey('goals', state.goals);
  renderGoals();
}

function renderGoals() {
  const root = qs('#goals-section');
  if (!root) return;

  const closedPnl = state.closedTrades.reduce((a,t) => a+(t.pnl||0), 0);
  const activePnl = state.activeTrades.reduce((acc,t) => {
    const p = state.prices[coinOf(t.par)] || t.entrada;
    const lev = t.leverage||1;
    return acc + (t.tipo==='LONG' ? (p-t.entrada)*t.size*lev : (t.entrada-p)*t.size*lev);
  }, 0);
  const totalPnl = closedPnl + activePnl;
  const capital  = state.profile.capital;

  const goalCards = state.goals.map(g => {
    const progress = g.targetPnl > 0 ? Math.min((totalPnl / g.targetPnl) * 100, 100) : 0;
    const remaining = g.targetPnl - totalPnl;
    const daysLeft  = g.deadline ? Math.ceil((new Date(g.deadline) - new Date()) / 86400000) : null;
    const achieved  = totalPnl >= g.targetPnl;
    const color     = achieved ? 'var(--green)' : progress > 50 ? 'var(--yellow)' : 'var(--accent)';

    // Proyección: basada en ops/semana y avg pnl
    let projection = '';
    if (state.closedTrades.length >= 3) {
      const oldest = state.closedTrades[state.closedTrades.length - 1];
      const days   = oldest?.closedAt ? Math.max(1, Math.ceil((Date.now() - new Date(oldest.closedAt?.split(',')[0].split('/').reverse().join('-'))) / 86400000)) : 30;
      const dailyRate = (closedPnl / days);
      if (dailyRate > 0 && remaining > 0) {
        const daysNeeded = Math.ceil(remaining / dailyRate);
        projection = `A tu ritmo actual: ~${daysNeeded} días para alcanzarlo`;
      }
    }

    return `
      <div class="goal-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div>
            <div style="font-weight:600;font-family:var(--serif);font-size:14px">${g.title}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px">
              Objetivo: <b style="color:var(--text)">+${fmtUSD(g.targetPnl)}</b>
              ${g.deadline ? ` · Fecha límite: ${new Date(g.deadline).toLocaleDateString('es-ES')}` : ''}
              ${daysLeft !== null ? ` · <span style="color:${daysLeft<7?'var(--red)':'var(--muted)'}">${daysLeft}d restantes</span>` : ''}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            ${achieved ? '<span class="tag tg">✓ LOGRADO</span>' : ''}
            <button onclick="deleteGoal('${g.id}')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px">×</button>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:5px">
          <span style="color:var(--muted)">Progreso</span>
          <span style="font-weight:600;color:${color}">${progress.toFixed(1)}%</span>
        </div>
        <div class="goal-progress-track">
          <div class="goal-progress-fill" style="width:${progress}%;background:${color}"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:5px">
          <span>P&L actual: <b style="color:${totalPnl>=0?'var(--green)':'var(--red)'}">${fmtUSD(totalPnl)}</b></span>
          <span>Faltan: <b style="color:var(--text)">${fmtUSD(Math.max(0, remaining))}</b></span>
        </div>
        ${projection ? `<div style="font-size:10px;color:var(--accent);margin-top:5px">📈 ${projection}</div>` : ''}
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="stl">🎯 Mis Objetivos</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:14px">Define una meta de P&L y sigue tu progreso en tiempo real.</div>

    <!-- Crear objetivo -->
    <div class="card" style="margin-bottom:14px">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:end">
        <div>
          <div class="lbl">Nombre del objetivo</div>
          <input class="inp" type="text" id="goal-title" placeholder="Ej: Meta del mes" style="font-size:12px"/>
        </div>
        <div>
          <div class="lbl">P&L objetivo ($)</div>
          <input class="inp" type="number" id="goal-pnl" placeholder="Ej: 500" step="any" style="font-size:12px"/>
        </div>
        <div>
          <div class="lbl">Fecha límite (opcional)</div>
          <input class="inp" type="date" id="goal-date" style="font-size:12px"/>
        </div>
        <button class="btn btng" style="padding:8px 14px;font-size:11px" onclick="submitGoal()">+ Añadir</button>
      </div>
    </div>

    ${state.goals.length === 0
      ? `<div class="empty" style="padding:30px"><div class="ei">🎯</div><div class="et">Sin objetivos aún. Crea uno para seguir tu progreso.</div></div>`
      : goalCards
    }`;
}

function submitGoal() {
  const title  = qs('#goal-title')?.value?.trim();
  const pnl    = parseFloat(qs('#goal-pnl')?.value);
  const date   = qs('#goal-date')?.value || null;
  if (!title || !pnl || pnl <= 0) { showToast('Rellena nombre y objetivo', true); return; }
  addGoal(title, pnl, date);
  if (qs('#goal-title')) qs('#goal-title').value = '';
  if (qs('#goal-pnl'))   qs('#goal-pnl').value   = '';
  if (qs('#goal-date'))  qs('#goal-date').value   = '';
}

/* ══════════════════════════════════════════════════════════
   ONBOARDING WIZARD
   ══════════════════════════════════════════════════════════ */
let onboardStep = 0;
const ONBOARD_STEPS = [
  {
    title: 'Bienvenido a CryptoPlan AI 🎉',
    desc:  'Tu asistente de trading con análisis técnico real. En 3 pasos lo dejamos listo para ti.',
    fields: null,
    cta:   'Empezar →',
  },
  {
    title: 'Tu perfil de riesgo',
    desc:  'Esto ayuda a la IA a calibrar las propuestas según tu estilo.',
    fields: 'profile',
    cta:   'Siguiente →',
  },
  {
    title: 'Tu capital de trading',
    desc:  'Introduce cuánto capital tienes disponible para operar. Puedes cambiarlo en cualquier momento.',
    fields: 'capital',
    cta:   'Siguiente →',
  },
  {
    title: '¡Todo listo! 🚀',
    desc:  'La IA ya tiene tu perfil. Activa el escáner o pulsa "Analizar" para tu primera propuesta.',
    fields: null,
    cta:   'Empezar a operar',
  },
];

function showOnboarding() {
  if (state.onboarded) return;
  onboardStep = 0;
  renderOnboardStep();
}

function renderOnboardStep() {
  const existing = qs('#onboard-overlay');
  if (existing) existing.remove();

  const step = ONBOARD_STEPS[onboardStep];
  const total = ONBOARD_STEPS.length;
  const pct   = ((onboardStep + 1) / total) * 100;

  const overlay = el('div', '');
  overlay.id = 'onboard-overlay';
  overlay.className = 'onboard-overlay';
  overlay.innerHTML = `
    <div class="onboard-card">
      <div class="onboard-progress">
        <div class="onboard-bar" style="width:${pct}%"></div>
      </div>
      <div style="padding:28px 28px 20px">
        <div style="font-size:10px;color:var(--muted);letter-spacing:1px;margin-bottom:8px">PASO ${onboardStep+1} DE ${total}</div>
        <div style="font-family:var(--serif);font-size:20px;font-weight:600;margin-bottom:8px">${step.title}</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.7;margin-bottom:22px">${step.desc}</div>

        ${step.fields === 'profile' ? `
          <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:22px">
            <div>
              <div class="lbl">Estilo de trading</div>
              <select class="inp" id="ob-style" style="font-size:12px">
                <option value="scalping">Scalping (minutos)</option>
                <option value="daytrading">Day Trading (horas)</option>
                <option value="swing" selected>Swing (días)</option>
                <option value="position">Position (semanas)</option>
              </select>
            </div>
            <div>
              <div class="lbl">Tolerancia al riesgo</div>
              <select class="inp" id="ob-risk" style="font-size:12px">
                <option value="conservador">Conservador — prefiero capital seguro</option>
                <option value="moderado" selected>Moderado — equilibrio riesgo/beneficio</option>
                <option value="agresivo">Agresivo — acepto mayor riesgo</option>
              </select>
            </div>
          </div>` : ''}

        ${step.fields === 'capital' ? `
          <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:22px">
            <div>
              <div class="lbl">Capital disponible ($)</div>
              <input class="inp" type="number" id="ob-capital" value="${state.profile.capital}" step="any" style="font-family:var(--serif);font-size:20px;font-weight:600;text-align:center"/>
            </div>
            <div>
              <div class="lbl">Riesgo por operación (%)</div>
              <div style="display:flex;gap:8px">
                ${[1,2,3,5].map(v => `<button class="btn${state.profile.risk_pct===v?' btng':''}" id="ob-rp-${v}" onclick="setObRisk(${v})" style="flex:1;justify-content:center;font-size:12px">${v}%</button>`).join('')}
              </div>
              <div style="font-size:10px;color:var(--muted);margin-top:5px">Riesgo recomendado para principiantes: 1-2%</div>
            </div>
          </div>` : ''}

        <div style="display:flex;gap:10px;align-items:center">
          ${onboardStep > 0 ? `<button class="btn" style="font-size:12px;padding:9px 16px" onclick="onboardBack()">← Atrás</button>` : ''}
          <button class="btn-main" style="flex:1;justify-content:center;font-size:13px;padding:12px" onclick="onboardNext()">${step.cta}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function setObRisk(v) {
  state.profile.risk_pct = v;
  [1,2,3,5].forEach(n => {
    const b = qs(`#ob-rp-${n}`);
    if (b) b.className = 'btn' + (n===v?' btng':'');
  });
}

function onboardNext() {
  const step = ONBOARD_STEPS[onboardStep];
  if (step.fields === 'profile') {
    state.profile.style            = qs('#ob-style')?.value || 'swing';
    state.profile.risk_tolerance   = qs('#ob-risk')?.value  || 'moderado';
    saveKey('profile', state.profile);
  }
  if (step.fields === 'capital') {
    state.profile.capital  = parseFloat(qs('#ob-capital')?.value) || 1000;
    saveKey('profile', state.profile);
  }
  onboardStep++;
  if (onboardStep >= ONBOARD_STEPS.length) {
    state.onboarded = true;
    saveKey('onboarded', true);
    qs('#onboard-overlay')?.remove();
    showToast('✓ Perfil configurado. ¡Listo para operar!');
    renderAll();
    return;
  }
  renderOnboardStep();
}

function onboardBack() {
  if (onboardStep > 0) { onboardStep--; renderOnboardStep(); }
}

async function showBitunixDebug() {
  const existing = qs('#bitunix-debug-modal');
  if (existing) { existing.remove(); return; }

  const modal = el('div', '');
  modal.id = 'bitunix-debug-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px;animation:fadeIn .2s ease';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;width:100%;max-width:540px;max-height:85vh;overflow-y:auto;box-shadow:var(--shadow-lg)">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--surface)">
        <div style="font-family:var(--serif);font-size:15px;font-weight:600">🔍 Bitunix Debug</div>
        <button onclick="qs('#bitunix-debug-modal').remove()" style="background:none;border:none;cursor:pointer;font-size:20px;color:var(--muted);line-height:1">×</button>
      </div>
      <div style="padding:20px;text-align:center;color:var(--muted)"><span class="spinner"></span> Probando endpoints...</div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  let debugData = {};
  try {
    const res = await authFetch('/api/bitunix/debug');
    debugData = await res.json();
  } catch (e) {
    debugData = { error: e.message };
  }

  const content = qs('#bitunix-debug-modal div > div:last-child');
  if (!content) return;

  const results = debugData.results || {};
  const rows = Object.entries(results).map(([label, r]) => {
    const ok = r.code === 0 && r.data != null;
    const color = ok ? 'var(--green)' : 'var(--red)';
    const icon  = ok ? '✅' : '❌';
    const detail = ok
      ? `<pre style="font-size:9px;background:var(--s2);border-radius:6px;padding:8px;overflow-x:auto;margin-top:6px;white-space:pre-wrap">${JSON.stringify(r.data, null, 2).slice(0, 500)}</pre>`
      : `<div style="font-size:10px;color:var(--red);margin-top:4px">${r.error || `code ${r.code}: ${r.msg || ''}`}</div>`;
    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px">
          <span>${icon}</span>
          <span style="font-size:12px;font-weight:600;color:${color}">${label}</span>
        </div>
        ${detail}
      </div>`;
  }).join('');

  content.innerHTML = `
    <div style="padding:16px 20px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:14px">
        Probando endpoints de Bitunix con distintos parámetros — el ✅ verde indica cuál funciona:
      </div>
      ${rows || `<div style="color:var(--red)">${debugData.error || 'Error desconocido'}</div>`}
    </div>`;
}

function showBitunixSetup() {
  const existing = qs('#bitunix-setup-modal');
  if (existing) { existing.remove(); return; }
  const modal = el('div', '');
  modal.id = 'bitunix-setup-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;animation:fadeIn .2s ease';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;width:100%;max-width:460px;box-shadow:var(--shadow-lg);overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid var(--border);background:var(--s2)">
        <div style="font-family:var(--serif);font-size:16px;font-weight:600">🔗 Conectar Bitunix</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">Las claves se guardan como variables de entorno en el servidor — nunca en el navegador.</div>
      </div>
      <div style="padding:20px 24px">
        <div style="background:#F4F0E6;border:1px solid #D9CCAA;border-radius:8px;padding:12px 14px;margin-bottom:18px;font-size:11px;color:#7A6030;line-height:1.6">
          <b>Cómo configurar:</b><br>
          1. Ve a <b>Bitunix → Gestión de API</b> y crea una API Key con permisos de <b>trading</b> (sin retiros).<br>
          2. En tu panel de <b>Railway</b>, añade estas dos variables de entorno:<br>
          <code style="background:rgba(0,0,0,.1);padding:2px 6px;border-radius:3px;display:inline-block;margin-top:6px">BITUNIX_API_KEY = tu_api_key<br>BITUNIX_SECRET = tu_secret_key</code><br>
          3. Redeploy la app y el widget mostrará <b>🔗 Bitunix Live</b>.
        </div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:16px">
          <b>Permisos recomendados:</b> Leer cuenta ✓ · Operar futuros ✓ · Sin retiros ✗<br>
          <b>IP whitelist:</b> Añade la IP de Railway para mayor seguridad.
        </div>
        <button class="btn-main" style="width:100%;justify-content:center" onclick="qs('#bitunix-setup-modal').remove()">Entendido</button>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function refreshBitunixData() {
  const btn = qs('#balance-widget button[onclick="refreshBitunixData()"]');
  if (btn) { btn.textContent = '↻ ...'; btn.disabled = true; }
  await Promise.all([fetchBitunixAccount(), syncBitunixPositions()]);
  renderBalanceWidget();
  if (btn) { btn.textContent = '↻ Actualizar'; btn.disabled = false; }
  showToast('✓ Datos de Bitunix actualizados');
}

/* ── Init ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadAll();

  // Aplicar modo oscuro guardado ANTES de mostrar nada
  applyDarkMode(state.darkMode);

  const loader = qs('#loading-screen');
  if (loader) loader.remove();

  qsa('.nb').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  qs('#btn-gen')            ?.addEventListener('click', onGenerate);
  qs('#btn-adapt')          ?.addEventListener('click', onAdaptStrategy);
  qs('#scanner-toggle-hdr') ?.addEventListener('click', toggleScanner);

  initMarketMeta(state.watchedCoins);
  connectWS();

  setTab('ops');
  renderStoragePanel();
  renderBalanceWidget();
  updateAlertBadge();

  const adaptBtn = qs('#btn-adapt');
  if (adaptBtn) adaptBtn.style.display = state.closedTrades.length >= 3 ? '' : 'none';

  // Datos de mercado + calendario — diferidos para que el UI cargue primero
  setTimeout(() => {
    fetchMarketMeta();
    fetchEconomicCalendar();
  }, 300);
  setInterval(fetchMarketMeta, 15 * 60 * 1000);
  setInterval(fetchEconomicCalendar, 30 * 60 * 1000);

  // Bitunix: comprobar config, cargar cuenta y sincronizar posiciones
  checkBitunixStatus().then(configured => {
    if (configured) {
      fetchBitunixAccount().then(() => {
        renderBalanceWidget();
        syncBitunixPositions();
      });
      // Refrescar cuenta cada 30 segundos y posiciones cada 15 segundos
      setInterval(() => {
        fetchBitunixAccount().then(() => renderBalanceWidget());
      }, 30_000);
      setInterval(syncBitunixPositions, 15_000);
    }
  });

  syncTradesToServer();
  connectServerWS();   // WS push: reemplaza polling para TRADE_CLOSED
  setInterval(pollServerClosedTrades, 30000); // fallback por si WS se desconecta

  // Onboarding: mostrar solo si es la primera vez
  if (!state.onboarded) {
    setTimeout(() => showOnboarding(), 800);
  }
});

Object.assign(window, {
  qs, state, setTab, toggleScanner, runScan, requestNotifPermission,
  setScanIntervalVal, acceptAlertById, rejectAlert, clearAlerts,
  closeTradeAtMarket, confirmCloseWithPrice,
  toggleTradeNotes, saveTradeNotes,
  openEditTrade, saveEditTrade,
  cancelTrade, onAcceptProposal, onRejectProposal,
  setProfileField, toggleCoin, saveProfile,
  saveCapital, updateCapCalc, setLeverage,
  toggleWatchedCoin, openChart,
  submitPriceAlert, deletePriceAlert,
  toggleScanLog, toggleBalanceEdit, saveQuickCapital,
  // Nuevas funciones
  toggleDarkMode,
  applyBtFilter, resetBtFilters,
  submitGoal, deleteGoal,
  onboardNext, onboardBack, setObRisk,
  refreshCalendar,
  showBitunixSetup, showBitunixDebug, refreshBitunixData,
  doLogout,
  resetAll, renderAll,
  exportTradesCSV,
});