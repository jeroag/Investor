/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — app.js
   ═══════════════════════════════════════════════════ */

'use strict';

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

/* ── RSI Calculator ──────────────────────────────────────────────────────── */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - 100 / (1 + rs));
}

function rsiTag(rsi) {
  if (rsi === null || rsi === undefined) return { tag:'—', cls:'tm' };
  if (rsi < 30)  return { tag:'SOBREVENDIDO', cls:'tg' };
  if (rsi < 45)  return { tag:'ACUMULAR',     cls:'tg' };
  if (rsi < 55)  return { tag:'NEUTRO',        cls:'tm' };
  if (rsi < 70)  return { tag:'CAUTELA',       cls:'ty' };
  return              { tag:'SOBRECOMPRADO',   cls:'tr' };
}

function fmtSup(price, coin) {
  if (coin === 'XRP' || coin === 'DOGE') return '$' + price.toFixed(4);
  if (price > 1000) return '$' + (price / 1000).toFixed(1) + 'K';
  return '$' + price.toFixed(2);
}

async function fetchMarketMeta() {
  const coins = state.watchedCoins;
  initMarketMeta(coins);
  await Promise.all(coins.map(async (coin) => {
    try {
      const symbol = coin + 'USDT';
      // Fetch 100 candles de 4H para RSI y niveles
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=4h&limit=100`;
      const res  = await fetch(url);
      if (!res.ok) return;
      const klines = await res.json();

      const closes = klines.map(k => parseFloat(k[4]));
      const highs  = klines.map(k => parseFloat(k[2]));
      const lows   = klines.map(k => parseFloat(k[3]));

      const rsi = calcRSI(closes);

      // Soporte = mínimo de los últimos 20 periodos
      const recentLows  = lows.slice(-20);
      const recentHighs = highs.slice(-20);
      const sup = Math.min(...recentLows);
      const res2 = Math.max(...recentHighs);

      const { tag, cls } = rsiTag(rsi);

      MARKET_META[coin] = {
        tag,
        cls,
        rsi: rsi !== null ? rsi : '—',
        sup: fmtSup(sup, coin),
        res: fmtSup(res2, coin),
      };
    } catch (e) {
      console.warn(`fetchMarketMeta ${coin}:`, e.message);
    }
  }));

  // Re-render si la pestaña mercado está activa
  if (state.currentTab === 'mkt') renderMkt();
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
    await fetch('/api/trades/sync', {
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
    const res  = await fetch('/api/trades/closed-by-server');
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
      await fetch('/api/trades/confirm-closed', {
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

  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
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
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

/* ── Contexto técnico real para los prompts ──────────────────────────────── */
function buildTechContext() {
  const lines = state.watchedCoins.map(coin => {
    const meta  = MARKET_META[coin];
    const price = state.prices[coin];
    if (!meta || !price) return null;

    const rsiVal = typeof meta.rsi === 'number' ? meta.rsi : null;
    let rsiSignal = 'neutro';
    if (rsiVal !== null) {
      if (rsiVal < 30)  rsiSignal = 'SOBREVENDIDO — posible rebote alcista';
      else if (rsiVal < 45) rsiSignal = 'zona de acumulación';
      else if (rsiVal > 70) rsiSignal = 'SOBRECOMPRADO — riesgo de corrección';
      else if (rsiVal > 60) rsiSignal = 'momentum alcista, cautela';
    }

    const distSup = price && meta.sup !== '...' ? ((price - parseFloat(meta.sup.replace(/[$K]/g,'').replace('K','000'))) / price * 100).toFixed(1) : '?';
    const distRes = price && meta.res !== '...' ? ((parseFloat(meta.res.replace(/[$K]/g,'').replace('K','000')) - price) / price * 100).toFixed(1) : '?';

    return `${coin}: precio $${price} | RSI(4H)=${rsiVal ?? '?'} (${rsiSignal}) | soporte=${meta.sup} (${distSup}% abajo) | resistencia=${meta.res} (${distRes}% arriba)`;
  }).filter(Boolean);

  return lines.join('\n');
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
  const techCtx = buildTechContext();
  const tradeHistory = buildTradeHistory();

  const raw = await callClaude(
    `Genera 2-3 propuestas de trading accionables AHORA basándote en el contexto técnico REAL.

PERFIL DEL TRADER:
- Estilo: ${profile.style} | Riesgo: ${profile.risk_tolerance}
- Capital: $${profile.capital} | Riesgo/op: ${profile.risk_pct}% ($${(profile.capital * profile.risk_pct / 100).toFixed(0)})
- Apalancamiento: ${profile.leverage || 1}x
- Monedas preferidas: ${profile.preferred_coins.join(', ') || 'BTC, ETH'}
- Notas del trader: ${profile.notes || 'ninguna'}
- Estrategia adaptada: ${strategy?.estrategiaAdaptada?.estiloRecomendado || 'N/A'} en ${strategy?.estrategiaAdaptada?.timeframe || '4H'}

HISTORIAL REAL:
${tradeHistory}

DATOS TÉCNICOS REALES BINANCE (4H):
${techCtx}

INSTRUCCIONES:
- Usa el RSI para identificar zonas de entrada: sobrevendido (<30) favorece LONG, sobrecomprado (>70) favorece SHORT
- El SL debe estar al otro lado del soporte/resistencia más cercano, no arbitrario
- El TP1 debe ser el siguiente nivel de resistencia/soporte real
- Solo propone monedas donde el setup técnico es claro y el R:R mínimo es 1.5
- La "razon" debe mencionar explícitamente el RSI actual y los niveles de precio
- Si tienes historial de conversación previo, ten en cuenta las propuestas anteriores y no repitas las mismas

Responde SOLO JSON sin markdown:
{"proposals":[{"par":"BTC/USDT","tipo":"LONG","setup":"RSI sobrevendido + soporte","entrada":70500,"stopLoss":68900,"tp1":73000,"tp2":76000,"rr":"1.8","confianza":74,"razon":"RSI(4H)=28 sobrevendido en soporte $68.9K, entrada con momentum. TP1 en resistencia $73K."}],"analisis_mercado":"Resumen técnico del mercado ahora.","recomendacion_ia":"Consejo personalizado para este trader."}`,
    'Eres analista técnico de cripto experto. Usas RSI, soportes y resistencias reales para generar setups precisos. Responde SOLO con JSON válido sin markdown.',
    true // usar historial de conversación
  );
  return parseJSON(raw);
}

async function aiScanMarket() {
  const { profile, strategy, alerts, activeTrades } = state;
  const techCtx      = buildTechContext();
  const tradeHistory = buildTradeHistory();
  const recentAlerts = alerts.slice(0, 3).map(a => `${a.par} ${a.tipo} @${a.entrada}`).join(', ');

  const raw = await callClaude(
    `Analiza el mercado AHORA y decide si existe una oportunidad técnica real y accionable.

DATOS TÉCNICOS REALES BINANCE (4H):
${techCtx}

PERFIL: ${profile.style}, riesgo ${profile.risk_tolerance}, capital $${profile.capital}, riesgo/op ${profile.risk_pct}%, apalancamiento ${profile.leverage || 1}x
HISTORIAL: ${tradeHistory}
ESTRATEGIA activa: ${strategy?.estrategiaAdaptada?.estiloRecomendado || 'swing'} ${strategy?.estrategiaAdaptada?.timeframe || '4H'}
Alertas recientes (no duplicar): ${recentAlerts || 'ninguna'}
Posiciones abiertas: ${activeTrades.length}

CRITERIOS para hay_oportunidad=true (todos deben cumplirse):
1. RSI en zona extrema (<35 para LONG, >65 para SHORT) O precio tocando soporte/resistencia clave
2. R:R mínimo 1.5 usando niveles técnicos reales
3. No hay alerta reciente del mismo par y dirección
4. El setup encaja con el estilo del trader (${profile.style})

Responde SOLO JSON:
{"hay_oportunidad":true,"urgencia":"ALTA","par":"BTC/USDT","tipo":"LONG","setup":"RSI 28 + soporte","entrada":70500,"stopLoss":68900,"tp1":73000,"tp2":76000,"rr":"1.8","confianza":78,"razon":"RSI(4H)=28 sobrevendido tocando soporte $68.9K. Patrón de reversión en timeframe 4H.","contexto_mercado":"Descripción técnica del mercado general."}
Si NO hay oportunidad: {"hay_oportunidad":false,"razon":"motivo técnico concreto"}`,
    'Eres analista técnico cripto muy selectivo. Solo señalas oportunidades con setup claro basado en datos reales. Responde SOLO con JSON válido.'
  );
  return parseJSON(raw);
}

async function aiAdaptStrategy() {
  const { profile, closedTrades } = state;
  const techCtx = buildTechContext();
  const wins    = closedTrades.filter(t => t.result === 'WIN').length;

  // Análisis por par
  const byPair = {};
  closedTrades.forEach(t => {
    if (!byPair[t.par]) byPair[t.par] = { wins: 0, total: 0, pnl: 0 };
    byPair[t.par].total++;
    byPair[t.par].pnl += t.pnl || 0;
    if (t.result === 'WIN') byPair[t.par].wins++;
  });
  const pairStats = Object.entries(byPair)
    .map(([par, s]) => `${par}: ${s.wins}/${s.total} wins, P&L $${s.pnl.toFixed(0)}`)
    .join(' | ');

  const raw = await callClaude(
    `Analiza el historial real de este trader y adapta su estrategia.

HISTORIAL COMPLETO:
- WinRate: ${closedTrades.length > 0 ? (wins/closedTrades.length*100).toFixed(0) : 0}% (${wins}G/${closedTrades.length - wins}P de ${closedTrades.length} ops)
- P&L total: $${closedTrades.reduce((a,t) => a+(t.pnl||0), 0).toFixed(2)}
- Por par: ${pairStats || 'sin datos'}
- Últimas 8 ops: ${closedTrades.slice(0, 8).map(t=>`${t.par} ${t.tipo} ${t.result} PnL:$${(t.pnl||0).toFixed(0)}${t.notes?` [${t.notes}]`:''}`).join(' | ')}

PERFIL: ${profile.style}, ${profile.risk_tolerance}, capital $${profile.capital}, apalancamiento ${profile.leverage||1}x

CONTEXTO TÉCNICO ACTUAL:
${techCtx}

Responde SOLO JSON:
{"diagnostico":"...","fortalezas":["..."],"debilidades":["..."],"alertas":["..."],"cambios":[{"area":"...","descripcion":"...","impacto":"ALTO"}],"estrategiaAdaptada":{"estiloRecomendado":"Swing","timeframe":"4H","riesgoRecomendado":2,"activos":["BTC","ETH"],"resumen":"...","reglas":["..."]}}`,
    'Eres coach de trading experto. Analizas datos reales para dar consejos precisos y accionables. Responde SOLO con JSON válido.'
  );
  return parseJSON(raw);
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

  w.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="display:flex;flex-direction:column;gap:1px">
          <span style="font-size:9px;color:var(--muted);font-weight:500;letter-spacing:.8px;text-transform:uppercase">Saldo total</span>
          <span style="font-family:var(--serif);font-size:16px;font-weight:600;color:var(--text);line-height:1">$${total.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
        </div>
        <div style="width:1px;height:28px;background:var(--border)"></div>
        <div style="display:flex;gap:12px">
          <div style="display:flex;flex-direction:column;gap:1px">
            <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">P&L cerrado</span>
            <span style="font-size:12px;font-weight:600;color:${closedPnl>=0?'var(--green)':'var(--red)'}">${closedPnl>=0?'+':''}$${closedPnl.toFixed(2)}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:1px">
            <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">P&L activo</span>
            <span style="font-size:12px;font-weight:600;color:${activePnl>=0?'var(--green)':'var(--red)'}">${activePnl>=0?'+':''}$${activePnl.toFixed(2)}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:1px">
            <span style="font-size:9px;color:var(--muted);letter-spacing:.5px">Total P&L</span>
            <span style="font-size:12px;font-weight:600;color:${totalColor}">${totalSign}$${totalPnl.toFixed(2)}</span>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px" id="balance-edit-area">
        <span style="font-size:9px;color:var(--muted)">Capital base: $${capital.toLocaleString('en')}</span>
        <button onclick="toggleBalanceEdit()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:10px;color:var(--muted);cursor:pointer">✏ Actualizar</button>
      </div>
    </div>
    <div id="balance-quick-edit" style="display:none;margin-top:8px;display:none;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--muted)">Capital real en exchange:</span>
      <input class="inp" type="number" id="balance-input" value="${capital}" step="any" style="width:120px;padding:5px 8px;font-size:12px"/>
      <button class="btn btng" style="padding:5px 12px;font-size:11px" onclick="saveQuickCapital()">✓ Guardar</button>
      <button onclick="toggleBalanceEdit()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:18px;line-height:1">×</button>
    </div>`;
}
function calcSize(riskUSD, entry, stopLoss, leverage = 1) {
  // Con apalancamiento: la posición efectiva se multiplica, pero el riesgo en USD no cambia.
  // Unidades = riesgo / (distancia_precio * apalancamiento)
  // Así, si el precio llega al SL, la pérdida sigue siendo exactamente riskUSD.
  const dist = Math.abs(entry - stopLoss);
  return dist > 0 ? riskUSD / (dist * leverage) : 0.001;
}

function acceptProposal(proposal) {
  const { profile, prices } = state;
  const riskUSD   = profile.capital * profile.risk_pct / 100;
  const leverage  = profile.leverage || 1;
  const coin      = coinOf(proposal.par);
  const realEntry = prices[coin] || proposal.entrada;
  const size      = calcSize(riskUSD, realEntry, proposal.stopLoss, leverage);

  const trade = {
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

  state.activeTrades.unshift(trade);
  saveKey('activeTrades', state.activeTrades);
  syncTradesToServer();
  showToast(`✓ ${proposal.par} ejecutada al precio real: ${fmtP(realEntry, coin)}`);
  return trade;
}

function acceptAlert(alert) {
  const trade = acceptProposal(alert);
  state.alerts = state.alerts.map(a => a.id === alert.id ? { ...a, status: 'accepted' } : a);
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

    const hitSL = trade.tipo === 'LONG' ? price <= trade.stopLoss : price >= trade.stopLoss;
    const hitTP = trade.tipo === 'LONG'
      ? price >= (trade.tp2 || trade.tp1)
      : price <= (trade.tp2 || trade.tp1);

    if (hitSL || hitTP) {
      state.autoClosedIds.add(trade.id);
      const result = hitTP ? 'WIN' : 'LOSS';
      const lev    = trade.leverage || 1;
      const exitPrice = hitTP ? (trade.tp2 || trade.tp1) : trade.stopLoss;
      const pnl    = trade.tipo === 'LONG'
        ? (exitPrice - trade.entrada) * trade.size * lev
        : (trade.entrada - exitPrice) * trade.size * lev;
      const closed = { ...trade, result, pnl, closedAt: nowFull() };
      state.closedTrades.unshift(closed);
      showToast(
        result === 'WIN'
          ? `✓ ${trade.par} cerrada en TP! ${fmtUSD(pnl)}`
          : `✕ ${trade.par} SL alcanzado. ${fmtUSD(pnl)}`,
        result !== 'WIN'
      );
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
  state.scannerOn ? stopScanner() : startScanner();
}

function updateScannerUI() {
  const scanBtn = qs('#scanner-toggle');
  const scanHdr = qs('#scanner-toggle-hdr');
  const mini    = qs('#scanner-mini');
  const sweep   = qs('#scanner-sweep');

  if (scanBtn) {
    scanBtn.className = 'scanner-btn ' + (state.scannerOn ? 'on' : 'off');
    scanBtn.innerHTML = state.scanning
      ? `<span class="spinner-p"></span> ESCANEANDO...`
      : state.scannerOn ? '⏹ DETENER' : '▶ ACTIVAR';
  }
  if (scanHdr) {
    scanHdr.className = 'scanner-btn ' + (state.scannerOn ? 'on' : 'off');
    scanHdr.innerHTML = state.scanning
      ? `<span class="spinner-p"></span> ESCÁNER ON`
      : state.scannerOn ? '📡 ESCÁNER ON' : '📡 ESCÁNER OFF';
  }
  if (mini) mini.style.display = state.scannerOn ? 'block' : 'none';
  if (sweep) sweep.style.display = state.scannerOn ? 'block' : 'none';

  const miniTime = qs('#scanner-mini-time');
  if (miniTime && state.lastScan) miniTime.textContent = 'Último: ' + state.lastScan;
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
        <button class="btn btng" style="font-size:10px;padding:7px 14px;flex:1" onclick="acceptAlertById('${alert.id}');qs('#screen-notif').remove()">✓ Ejecutar ya</button>
      </div>
    </div>`;
  document.body.appendChild(div);
  setTimeout(() => { if (div.parentNode) div.remove(); }, 12000);
}

function urgencyClass(u) {
  return u === 'ALTA' ? 'tr' : u === 'MEDIA' ? 'ty' : 'tb';
}

function acceptAlertById(id) {
  const alert = state.alerts.find(a => a.id === id);
  if (alert) { acceptAlert(alert); renderAll(); }
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
      const coin = coinOf(p.par);
      const live = state.prices[coin];
      const lc   = p.tipo === 'LONG' ? 'var(--green)' : 'var(--red)';
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
              <span class="lv lv-t">TP1: ${fmtP(p.tp1, coin)}</span>
              ${p.tp2 ? `<span class="lv lv-t">TP2: ${fmtP(p.tp2, coin)}</span>` : ''}
              <span style="font-size:10px;color:var(--yellow)">R:R 1:${p.rr}</span>
            </div>
            <div style="font-size:10px;color:var(--muted);line-height:1.5;margin-top:8px;margin-bottom:10px">${p.razon}</div>
          </div>
          <div class="proposal-actions">
            <button class="btn btng" style="font-size:10px;padding:7px 16px" onclick="onAcceptProposal(${i})">✓ ACEPTAR Y EJECUTAR</button>
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
              <span class="lv lv-t">TP1: ${fmtP(o.tp1, coin)}</span>
              ${o.tp2 ? `<span class="lv lv-t">TP2: ${fmtP(o.tp2, coin)}</span>` : ''}
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

  // Alert list
  if (state.alerts.length === 0) {
    html += `<div class="empty"><div class="ei">🔔</div><div class="et">Sin alertas aún.<br>Activa el escáner para que la IA monitorice<br>el mercado y te avise de oportunidades.</div></div>`;
  } else {
    state.alerts.forEach(a => {
      const coin    = coinOf(a.par);
      const isPending = a.status === 'pending';
      const lc      = a.tipo === 'LONG' ? 'var(--green)' : 'var(--red)';

      if (isPending) {
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
                <span class="lv lv-t">TP1: ${fmtP(a.tp1, coin)}</span>
                ${a.tp2 ? `<span class="lv lv-t">TP2: ${fmtP(a.tp2, coin)}</span>` : ''}
                <span style="font-size:10px;color:var(--yellow)">R:R 1:${a.rr}</span>
              </div>
              <div style="font-size:10px;color:var(--muted);line-height:1.5;margin-bottom:6px">${a.razon}</div>
              ${a.contexto_mercado ? `<div style="font-size:10px;color:var(--muted);background:rgba(0,0,0,.2);padding:6px 8px;border-radius:5px">${a.contexto_mercado}</div>` : ''}
            </div>
            <div class="alert-card-actions">
              <button class="btn btng" style="font-size:10px;padding:7px 16px" onclick="acceptAlertById('${a.id}');renderAll()">✓ ACEPTAR Y EJECUTAR</button>
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
      <div class="stl">Historial Cerradas</div>
      ${histRows}
    </div>`;
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
            src="https://www.tradingview.com/widgetembed/?symbol=BINANCE:${coin}USDT&interval=4H&theme=light&style=1&locale=es&toolbar_bg=%23FFFFFF&hide_top_toolbar=0&hide_side_toolbar=0&allow_symbol_change=0&save_image=0&calendar=0&studies=RSI%4014"
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
    const fullName = COIN_NAMES[coin] || coin;

    cards += `
      <div class="card" id="mkt-${coin}" style="border-color:${bc};transition:border-color .5s">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div>
            <div style="font-family:var(--serif);font-size:15px;font-weight:600;color:var(--text);line-height:1.2">${fullName}</div>
            <div style="font-size:10px;color:var(--muted);font-weight:500;margin-top:1px">${coin} · USDT</div>
          </div>
          <span class="tag ${meta.cls}">${meta.tag}</span>
        </div>
        <div style="font-size:20px;font-weight:600;color:${up?'var(--green)':dn?'var(--red)':'var(--text)'};font-family:var(--serif);margin-bottom:3px;transition:color .3s" id="mkt-price-${coin}">
          ${p ? fmtP(p, coin) : '<span style="color:var(--muted);font-size:13px">...</span>'}
        </div>
        <div style="font-size:10px;margin-bottom:10px;color:${up?'var(--green)':dn?'var(--red)':'var(--muted)'}" id="mkt-chg-${coin}">—</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:10px">
          <div class="cs"><div class="csl">RSI</div><div class="csv" style="color:${meta.rsi<30?'var(--green)':meta.rsi>70?'var(--red)':'var(--text)'}">${meta.rsi}</div></div>
          <div class="cs"><div class="csl">Soporte</div><div class="csv" style="color:var(--green);font-size:11px">${meta.sup}</div></div>
          <div class="cs"><div class="csl">Resist.</div><div class="csv" style="color:var(--red);font-size:11px">${meta.res}</div></div>
        </div>
        <button class="btn" style="width:100%;justify-content:center;font-size:10px;padding:5px" onclick="openChart('${coin}')">
          📈 Ver gráfico
        </button>
      </div>`;
  });

  root.innerHTML = `
    <div class="stl">Mercado — Binance Live</div>
    <div style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-bottom:16px">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:blink 2.5s infinite"></span>
      Precios en tiempo real · WebSocket Binance
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
    </div>`;
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
  const levOptions = [1, 2, 3, 5, 10, 20];

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

  // Render the selected section
  const renders = {
    ops:     renderOps,
    alerts:  renderAlerts,
    perf:    renderPerf,
    mkt:     renderMkt,
    strat:   renderStrategy,
    profile: renderProfile,
    capital: renderCapital,
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

  // Cerrar el trade con precio real y notas
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
function onAcceptProposal(i) {
  const p = state.pending[i];
  if (!p) return;
  acceptProposal(p);
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
  if (id === 'ops')     renderOps();
  if (id === 'alerts')  renderAlerts();
  if (id === 'perf')    renderPerf();
  if (id === 'mkt')     renderMkt();
  if (id === 'strat')   renderStrategy();
  if (id === 'profile') renderProfile();
  if (id === 'capital') renderCapital();
}

/* ── Init ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Load persisted data
  loadAll();

  // Hide loading screen
  const loader = qs('#loading-screen');
  if (loader) loader.remove();

  // Wire nav buttons
  qsa('.nb').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  // Wire header buttons
  qs('#btn-gen')            ?.addEventListener('click', onGenerate);
  qs('#btn-adapt')          ?.addEventListener('click', onAdaptStrategy);
  qs('#scanner-toggle-hdr') ?.addEventListener('click', toggleScanner);

  // Inicializar MARKET_META con las monedas guardadas
  initMarketMeta(state.watchedCoins);

  // Start WebSocket
  connectWS();

  // Initial render
  setTab('ops');
  renderStoragePanel();
  renderBalanceWidget();
  updateAlertBadge();

  // Show/hide adapt button
  const adaptBtn = qs('#btn-adapt');
  if (adaptBtn) adaptBtn.style.display = state.closedTrades.length >= 3 ? '' : 'none';

  // Cargar datos de mercado reales (RSI, soporte, resistencia)
  fetchMarketMeta();
  setInterval(fetchMarketMeta, 15 * 60 * 1000); // refrescar cada 15 min

  // Sincronizar trades con servidor y polling de cierres automáticos
  syncTradesToServer();
  setInterval(pollServerClosedTrades, 15000); // revisar cada 15 segundos
});

// Expose globals needed by inline onclick handlers
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
  resetAll, renderAll,
});