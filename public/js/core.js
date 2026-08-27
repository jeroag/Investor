/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — core.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── Storage (definido aquí para que esté disponible antes que `state`) ───── */
// IMPORTANTE: storage debe declararse ANTES del objeto `state` porque
// state lo referencia en su inicialización. indicators.js ya NO lo define.
const storage = {
  get(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
    catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { }
  },
  del(key) { try { localStorage.removeItem(key); } catch { } },
};

/* ── Auth helpers ─────────────────────────────────────────────────────────── */

/** Devuelve el token de sesión guardado en sessionStorage */
function getAuthToken() {
  return sessionStorage.getItem('cp_token') || '';
}

/**
 * Wrapper de fetch que inyecta el token en todas las peticiones a /api/*
 * Uso: authFetch('/api/...', options)  →  igual que fetch pero autenticado
 * Si el servidor devuelve 401, redirige al login automáticamente.
 * Pasar { skipRedirect: true } para evitar la redirección (útil en init).
 */
async function authFetch(url, options = {}, { skipRedirect = false } = {}) {
  const token = getAuthToken();
  options.headers = options.headers || {};
  if (token) options.headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, options);
  if (res.status === 401 && !skipRedirect) {
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
  } catch { }
  sessionStorage.removeItem('cp_token');
  window.location.href = '/login';
}

/* ── Constants ───────────────────────────────────────────────────────────── */
const CLAUDE_MODEL = 'claude-sonnet-5';

// Todas las monedas disponibles
const ALL_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'AVAX', 'ADA', 'MATIC', 'DOT', 'LINK', 'LTC', 'UNI', 'ATOM', 'XAU'];

const COIN_NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana',
  XRP: 'XRP', BNB: 'BNB', DOGE: 'Dogecoin',
  AVAX: 'Avalanche', ADA: 'Cardano', MATIC: 'Polygon',
  DOT: 'Polkadot', LINK: 'Chainlink', LTC: 'Litecoin',
  UNI: 'Uniswap', ATOM: 'Cosmos',
  XAU: 'Oro (Gold)',
};

// Cantidades mínimas de Bitunix Futures por moneda (en unidades base)
// Fuente: documentación Bitunix — se usan para filtrar qué monedas son ejecutables
const BITUNIX_MIN_QTY = {
  BTC: 0.001,   // ~$83  a $83k
  ETH: 0.01,    // ~$18  a $1800
  SOL: 0.1,     // ~$13  a $130
  XRP: 1,       // ~$2.4 a $2.4
  BNB: 0.01,    // ~$6   a $600
  DOGE: 10,      // ~$1.7 a $0.17
  AVAX: 0.1,     // ~$2   a $20
  ADA: 1,       // ~$0.4 a $0.4
  MATIC: 1,       // ~$0.5 a $0.5
  DOT: 0.1,     // ~$0.4 a $4
  LINK: 0.1,     // ~$1.4 a $14
  LTC: 0.01,    // ~$0.9 a $90
  UNI: 0.1,     // ~$0.6 a $6
  ATOM: 0.1,     // ~$0.5 a $5
  XAU: 0.01,    // ~$32  a $3200/oz (mín. aprox. Bitunix)
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
  const capital = profile.capital || 0;
  const riskPct = profile.risk_pct || 2;
  const leverage = profile.leverage || 1;
  const riskUSD = capital * riskPct / 100;

  const feasible = [];
  const infeasible = [];

  const coinsToCheck = watchedCoins.length ? watchedCoins : ALL_COINS;

  coinsToCheck.forEach(coin => {
    const price = prices[coin];
    const minQty = BITUNIX_MIN_QTY[coin] ?? 1;
    if (!price || price <= 0) return;

    // SL típico = 2% del precio (ajustado a la volatilidad por tipo de moneda)
    const slPct = coin === 'BTC' ? 0.02 : coin === 'ETH' ? 0.025 : 0.03;
    const slDist = price * slPct;
    const qty = riskUSD / slDist;         // leverage no divide qty
    const minNotional = minQty * price;
    const myNotional = qty * price;
    const margin = myNotional / leverage; // leverage sí reduce el margen

    if (qty >= minQty) {
      feasible.push({
        coin,
        price,
        qty: parseFloat(qty.toFixed(4)),
        minQty,
        margin: parseFloat(margin.toFixed(2)),
        notional: parseFloat(myNotional.toFixed(2)),
        marginPct: parseFloat((margin / capital * 100).toFixed(1)),
      });
    } else {
      // Calcular cuánto capital mínimo necesitaría
      const minCapitalNeeded = (minQty * slDist) / (riskPct / 100); // sin leverage en numerador
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


const DEFAULT_WATCHED_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'XAU'];

function buildWsUrl(coins) {
  return 'wss://stream.binance.com:9443/stream?streams=' +
    coins.map(c => c.toLowerCase() + 'usdt@miniTicker').join('/');
}

const STORAGE_KEYS = {
  activeTrades: 'cp:activeTrades',
  closedTrades: 'cp:closedTrades',
  alerts: 'cp:alerts',
  strategy: 'cp:strategy',
  profile: 'cp:profile',
  scanInterval: 'cp:scanInterval',
  watchedCoins: 'cp:watchedCoins',
  priceAlerts: 'cp:priceAlerts',
  scanLog: 'cp:scanLog',
  aiHistory: 'cp:aiHistory',
  darkMode: 'cp:darkMode',
  goals: 'cp:goals',
  onboarded: 'cp:onboarded',
};

const DEFAULT_PROFILE = {
  style: 'swing',
  risk_tolerance: 'moderado',
  preferred_coins: ['BTC', 'ETH'],
  notes: '',
  capital: 1000,
  risk_pct: 2,
  leverage: 1,         // apalancamiento por defecto (1x = sin apalancamiento)
};

// MARKET_META — se actualiza dinámicamente desde Binance
const MARKET_META = {};
function initMarketMeta(coins) {
  coins.forEach(c => {
    if (!MARKET_META[c]) MARKET_META[c] = { tag: '—', cls: 'tm', rsi: '...', sup: '...', res: '...' };
  });
  // Eliminar monedas que ya no se siguen
  Object.keys(MARKET_META).forEach(c => { if (!coins.includes(c)) delete MARKET_META[c]; });
}


/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
  // persisted
  activeTrades: [],
  closedTrades: [],
  alerts: [],
  strategy: null,
  profile: { ...DEFAULT_PROFILE },
  scanInterval: 5,
  watchedCoins: [...DEFAULT_WATCHED_COINS],

  // persisted new
  priceAlerts: [],
  scanLog: [],
  aiHistory: [],
  darkMode: false,
  goals: [],
  configTab: 'perfil',
  diary: [],
  activityLog: [],
  onboarded: false,

  // session
  prices: {},
  prevPrices: {},
  wsStatus: 'connecting',
  pending: [],
  aiMsg: null,
  currentTab: 'ops',
  histPage: 0,
  scannerOn: false,
  scanning: false,
  lastScan: null,
  notifPermission: Notification.permission,
  circuitBreakerTripped: false,  // se activa si se supera el límite diario
  readOnlyMode: storage.get('cp:readOnly') ?? false,
  activeNotif: null,
  scanTimer: null,
  autoClosedIds: new Set(),
};

/* ── Storage helpers ─────────────────────────────────────────────────────── */

function loadAll() {
  state.activeTrades = storage.get(STORAGE_KEYS.activeTrades) ?? [];
  state.closedTrades = storage.get(STORAGE_KEYS.closedTrades) ?? [];
  state.alerts = storage.get(STORAGE_KEYS.alerts) ?? [];
  state.strategy = storage.get(STORAGE_KEYS.strategy) ?? null;
  state.profile = { ...DEFAULT_PROFILE, ...(storage.get(STORAGE_KEYS.profile) ?? {}) };
  state.scanInterval = storage.get(STORAGE_KEYS.scanInterval) ?? 5;
  state.watchedCoins = storage.get(STORAGE_KEYS.watchedCoins) ?? [...DEFAULT_WATCHED_COINS];

  // Migración: asegurar que XAU esté en watchedCoins aunque el usuario
  // tenga datos guardados de antes de añadir el oro
  const ALWAYS_INCLUDE = ['XAU'];
  let migrated = false;
  ALWAYS_INCLUDE.forEach(coin => {
    if (!state.watchedCoins.includes(coin)) {
      state.watchedCoins.push(coin);
      migrated = true;
    }
  });
  if (migrated) storage.set(STORAGE_KEYS.watchedCoins, state.watchedCoins);
  state.priceAlerts = storage.get(STORAGE_KEYS.priceAlerts) ?? [];
  state.scanLog = storage.get(STORAGE_KEYS.scanLog) ?? [];
  state.aiHistory = storage.get(STORAGE_KEYS.aiHistory) ?? [];
  state.darkMode = storage.get(STORAGE_KEYS.darkMode) ?? false;
  state.goals = storage.get(STORAGE_KEYS.goals) ?? [];
  state.diary = storage.get('cp:diary') ?? [];
  state.activityLog = storage.get('cp:activity') ?? [];
  state.onboarded = storage.get(STORAGE_KEYS.onboarded) ?? false;
}

function saveKey(key, value) { storage.set(STORAGE_KEYS[key], value); }

/* Sincroniza el perfil con el servidor tras cualquier cambio */
function syncProfileToServer() {
  authFetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: state.profile }),
  }).catch(() => { });
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const nowTime = () => new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const nowFull = () => new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

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
  t.style.background = err ? 'rgba(255,77,109,.15)' : 'rgba(0,255,157,.12)';
  t.style.border = `1px solid ${err ? 'rgba(255,77,109,.4)' : 'rgba(0,255,157,.3)'}`;
  t.style.color = err ? 'var(--red)' : 'var(--green)';
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (t) t.style.display = 'none'; }, 3500);
}