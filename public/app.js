/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — app.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── Constants ───────────────────────────────────────────────────────────── */
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const WS_URL = 'wss://stream.binance.com:9443/stream?streams=' +
  ['btcusdt','ethusdt','solusdt','xrpusdt','bnbusdt','dogeusdt']
    .map(s => s + '@miniTicker').join('/');

const STORAGE_KEYS = {
  activeTrades:  'cp:activeTrades',
  closedTrades:  'cp:closedTrades',
  alerts:        'cp:alerts',
  strategy:      'cp:strategy',
  profile:       'cp:profile',
  scanInterval:  'cp:scanInterval',
};

const DEFAULT_PROFILE = {
  style: 'swing',
  risk_tolerance: 'moderado',
  preferred_coins: ['BTC','ETH'],
  notes: '',
  capital: 1000,
  risk_pct: 2
};

// MARKET_META — se actualiza dinámicamente desde Binance
const MARKET_META = {
  BTC:  { tag:'—', cls:'tm', rsi:'...', sup:'...', res:'...' },
  ETH:  { tag:'—', cls:'tm', rsi:'...', sup:'...', res:'...' },
  SOL:  { tag:'—', cls:'tm', rsi:'...', sup:'...', res:'...' },
  XRP:  { tag:'—', cls:'tm', rsi:'...', sup:'...', res:'...' },
  BNB:  { tag:'—', cls:'tm', rsi:'...', sup:'...', res:'...' },
  DOGE: { tag:'—', cls:'tm', rsi:'...', sup:'...', res:'...' },
};

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
  const coins = Object.keys(MARKET_META);
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
  setWsStatus('connecting');
  ws = new WebSocket(WS_URL);

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
  // Update ticker
  renderTicker();
  // Update active trades PnL and check TP/SL
  checkTPSL();
  updateTradesPnl();
  // Update market tab if visible
  if (state.currentTab === 'mkt') updateMarketPrice(coin, price);
}

/* ── Claude API (proxy seguro vía servidor) ──────────────────────────────── */
async function callClaude(prompt, system) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error del servidor');
  return data.content[0]?.text || '';
}

function parseJSON(raw) {
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

async function aiGenerateProposals() {
  const { profile, prices, closedTrades, strategy } = state;
  const priceStr = Object.entries(prices).map(([c,p]) => `${c}: $${p}`).join(' | ');
  const statsStr = closedTrades.length > 0
    ? `WinRate: ${(closedTrades.filter(t=>t.result==='WIN').length/closedTrades.length*100).toFixed(0)}% (${closedTrades.length} ops). Estrategia: ${strategy?.estrategiaAdaptada?.estiloRecomendado || 'N/A'}`
    : 'Sin historial.';

  const raw = await callClaude(
    `Genera 2-3 propuestas de trading para este perfil:
Estilo: ${profile.style} | Riesgo: ${profile.risk_tolerance} | Capital: $${profile.capital} | Riesgo/op: ${profile.risk_pct}%
Monedas preferidas: ${profile.preferred_coins.join(', ') || 'BTC, ETH'}
${statsStr}
Notas: ${profile.notes || 'ninguna'}
PRECIOS REALES BINANCE AHORA: ${priceStr}

Responde SOLO JSON sin markdown:
{"proposals":[{"par":"BTC/USDT","tipo":"LONG","setup":"EMA50","entrada":70500,"stopLoss":68900,"tp1":73000,"tp2":76000,"rr":"1.6","confianza":74,"razon":"Explicación técnica concisa."}],"analisis_mercado":"Contexto breve.","recomendacion_ia":"Recomendación personalizada."}`,
    'Eres experto en trading cripto. Responde SOLO con JSON válido sin markdown.'
  );
  return parseJSON(raw);
}

async function aiScanMarket() {
  const { profile, prices, closedTrades, strategy, alerts, activeTrades } = state;
  const priceStr = Object.entries(prices).map(([c,p]) => `${c}: $${p}`).join(' | ');
  const recentAlerts = alerts.slice(0, 3).map(a => `${a.par} ${a.tipo} (${a.timestamp})`).join(', ');

  const raw = await callClaude(
    `Analiza el mercado ahora y decide si HAY una oportunidad real.

PRECIOS REALES BINANCE: ${priceStr}
Perfil: ${profile.style}, riesgo ${profile.risk_tolerance}, capital $${profile.capital}, riesgo/op ${profile.risk_pct}%
Monedas preferidas: ${profile.preferred_coins.join(', ') || 'BTC, ETH'}
WinRate: ${closedTrades.length > 0 ? (closedTrades.filter(t=>t.result==='WIN').length/closedTrades.length*100).toFixed(0)+'%' : 'Sin historial'}
Estrategia actual: ${strategy?.estrategiaAdaptada?.estiloRecomendado || 'swing'}
Alertas recientes (evitar duplicar): ${recentAlerts || 'ninguna'}
Operaciones activas: ${activeTrades.length}

IMPORTANTE: Solo hay_oportunidad=true si hay setup REAL y concreto ahora. Sé selectivo.

Responde SOLO JSON:
{"hay_oportunidad":true,"urgencia":"ALTA","par":"BTC/USDT","tipo":"LONG","setup":"EMA50 Breakout","entrada":70500,"stopLoss":68900,"tp1":73000,"tp2":76000,"rr":"1.8","confianza":78,"razon":"Explicación técnica concisa de por qué AHORA.","contexto_mercado":"Contexto general."}
Si NO hay oportunidad: {"hay_oportunidad":false,"razon":"motivo breve"}`,
    'Eres analista de trading cripto experto y selectivo. Responde SOLO con JSON válido.'
  );
  return parseJSON(raw);
}

async function aiAdaptStrategy() {
  const { profile, closedTrades } = state;
  const wins = closedTrades.filter(t => t.result === 'WIN').length;
  const raw = await callClaude(
    `Adapta la estrategia basándote en el historial:
Perfil: ${profile.style}, ${profile.risk_tolerance}, capital $${profile.capital}
WinRate: ${(wins/closedTrades.length*100).toFixed(0)}% (${wins}G/${closedTrades.length-wins}P)
Ops recientes: ${closedTrades.slice(-8).map(t=>`${t.par} ${t.tipo} ${t.result} PnL:$${(t.pnl||0).toFixed(0)}`).join(' | ')}

Responde SOLO JSON:
{"diagnostico":"...","fortalezas":["..."],"debilidades":["..."],"alertas":["..."],"cambios":[{"area":"...","descripcion":"...","impacto":"ALTO"}],"estrategiaAdaptada":{"estiloRecomendado":"Swing","timeframe":"4H","riesgoRecomendado":2,"activos":["BTC","ETH"],"resumen":"...","reglas":["..."]}}`,
    'Eres coach de trading experto. Responde SOLO con JSON válido.'
  );
  return parseJSON(raw);
}

/* ── Trade management ────────────────────────────────────────────────────── */
function calcSize(riskUSD, entry, stopLoss) {
  const dist = Math.abs(entry - stopLoss);
  return dist > 0 ? riskUSD / dist : 0.001;
}

function acceptProposal(proposal) {
  const { profile, prices } = state;
  const riskUSD   = profile.capital * profile.risk_pct / 100;
  const coin      = coinOf(proposal.par);
  const realEntry = prices[coin] || proposal.entrada;
  const size      = calcSize(riskUSD, realEntry, proposal.stopLoss);

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
      const pnl    = result === 'WIN'
        ? Math.abs(trade.riskUSD) * parseFloat(trade.rr || 1)
        : -Math.abs(trade.riskUSD);
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
    trade.pnl    = trade.tipo === 'LONG'
      ? (price - trade.entrada) * trade.size
      : (trade.entrada - price) * trade.size;
    trade.pnlPct = trade.tipo === 'LONG'
      ? ((price - trade.entrada) / trade.entrada) * 100
      : ((trade.entrada - price) / trade.entrada) * 100;

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

/* ── Scanner ─────────────────────────────────────────────────────────────── */
async function runScan() {
  if (state.scanning || state.wsStatus !== 'live') return;
  state.scanning = true;
  state.lastScan = nowTime();
  updateScannerUI();

  try {
    const result = await aiScanMarket();
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
    const pnl      = o.tipo === 'LONG' ? (price - o.entrada) * o.size : (o.entrada - price) * o.size;
    const pnlPct   = o.tipo === 'LONG' ? ((price - o.entrada)/o.entrada)*100 : ((o.entrada - price)/o.entrada)*100;
    const lc       = o.tipo === 'LONG' ? 'var(--green)' : 'var(--red)';
    const pnlColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    const priceDir = price > prev ? 'up' : price < prev ? 'dn' : 'flat';
    const arrow    = price > prev ? '▲ ' : price < prev ? '▼ ' : '';

    html += `
      <div class="op" data-trade-id="${o.id}">
        <div class="op-body">
          <div class="op-stripe" style="background:${lc}"></div>
          <div class="op-main">
            <div class="op-hdr">
              <span class="op-pair">${o.par}</span>
              <span style="font-size:10px;color:${lc};border:1px solid ${lc}40;padding:2px 7px;border-radius:3px">${o.tipo}</span>
              <span class="tag tc">${o.confianza}% IA</span>
              <span class="live-price ${priceDir}">${arrow}${fmtP(price, coin)}</span>
              <span class="op-pnl" style="color:${pnlColor}">${fmtUSD(pnl)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span>
            </div>
            <div class="op-meta">${o.setup} · ${o.createdAt} · Riesgo $${(o.riskUSD || 0).toFixed(2)}</div>
            <div class="op-levels">
              <span class="lv lv-e">E: ${fmtP(o.entrada, coin)}</span>
              <span class="lv lv-s">SL: ${fmtP(o.stopLoss, coin)}</span>
              <span class="lv lv-t">TP1: ${fmtP(o.tp1, coin)}</span>
              ${o.tp2 ? `<span class="lv lv-t">TP2: ${fmtP(o.tp2, coin)}</span>` : ''}
              <span style="font-size:10px;color:var(--yellow)">R:R 1:${o.rr}</span>
            </div>
            <div class="op-reason">${o.razon}</div>
          </div>
        </div>
        <div class="op-actions">
          <button class="btn btng" style="font-size:10px;padding:6px 12px" onclick="openCloseModal('${o.id}')">✓ Cerrar</button>
          <button class="btn btnr" style="font-size:10px;padding:6px 10px" onclick="cancelTrade('${o.id}');renderOps()">✕ Cancelar</button>
        </div>
      </div>`;
  });

  root.innerHTML = html;
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
function renderPerf() {
  const root = qs('#sec-perf');
  if (!root) return;

  const { closedTrades, activeTrades, prices, profile } = state;
  const wins    = closedTrades.filter(t => t.result === 'WIN').length;
  const totalPnl = closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const activePnl = activeTrades.reduce((acc, t) => {
    const coin = coinOf(t.par);
    const p = prices[coin] || t.entrada;
    const pnl = t.tipo === 'LONG' ? (p - t.entrada) * t.size : (t.entrada - p) * t.size;
    return acc + pnl;
  }, 0);
  const winRate  = closedTrades.length > 0 ? (wins / closedTrades.length * 100).toFixed(0) : 0;
  const alertsTotal = state.alerts.length;
  const alertsAcc   = state.alerts.filter(a => a.status === 'accepted').length;

  // Equity curve
  let cap = profile.capital;
  const points = [cap, ...closedTrades.slice().reverse().map(t => { cap += (t.pnl || 0); return cap; })];
  const maxEq  = Math.max(...points);
  const minEq  = Math.min(...points);

  let equityBars = '';
  points.forEach((v, i) => {
    const h    = maxEq === minEq ? 50 : ((v - minEq) / (maxEq - minEq)) * 85 + 15;
    const prev = points[i - 1];
    const col  = !prev ? 'var(--accent)' : v >= prev ? 'var(--green)' : 'var(--red)';
    equityBars += `<div class="equity-bar" style="height:${h}%;background:${col}99"></div>`;
  });

  let histRows = '';
  if (closedTrades.length === 0) {
    histRows = `<div class="empty" style="padding:16px"><div class="et">Sin operaciones cerradas.</div></div>`;
  } else {
    closedTrades.forEach(t => {
      histRows += `
        <div class="hist-row">
          <div style="display:flex;gap:8px;align-items:center">
            <span class="tag ${t.result === 'WIN' ? 'tg' : 'tr'}">${t.result === 'WIN' ? '✓ WIN' : '✕ LOSS'}</span>
            <span style="color:#fff;font-weight:bold">${t.par}</span>
            <span style="color:var(--muted)">${t.tipo}</span>
            <span style="color:var(--muted);font-size:9px">${t.closedAt}</span>
          </div>
          <span style="font-weight:800;color:${t.result === 'WIN' ? 'var(--green)' : 'var(--red)'}">${fmtUSD(t.pnl || 0)}</span>
        </div>`;
    });
  }

  root.innerHTML = `
    <div class="stl">◈ Rendimiento</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-lbl">Win Rate</div><div class="kpi-val" style="color:${parseInt(winRate)>=50?'var(--green)':'var(--red)'}">${winRate}%</div><div class="kpi-sub">${wins}/${closedTrades.length} ops</div></div>
      <div class="kpi"><div class="kpi-lbl">P&L Cerrado</div><div class="kpi-val" style="color:${totalPnl>=0?'var(--green)':'var(--red)'}">${fmtUSD(totalPnl)}</div><div class="kpi-sub">ops cerradas</div></div>
      <div class="kpi"><div class="kpi-lbl">P&L Activo</div><div class="kpi-val" style="color:${activePnl>=0?'var(--green)':'var(--red)'}">${fmtUSD(activePnl)}</div><div class="kpi-sub">${activeTrades.length} posiciones</div></div>
      <div class="kpi"><div class="kpi-lbl">Alertas IA</div><div class="kpi-val" style="color:var(--purple)">${alertsTotal}</div><div class="kpi-sub">${alertsAcc} aceptadas</div></div>
    </div>
    <div class="card">
      <div class="stl">Curva de Capital</div>
      ${points.length > 1
        ? `<div class="equity-bars">${equityBars}</div>`
        : `<div class="empty" style="padding:20px"><div class="et">Sin datos aún.</div></div>`}
    </div>
    <div class="card">
      <div class="stl">Historial Cerradas</div>
      ${histRows}
    </div>`;
}

/* ── Render: Market ──────────────────────────────────────────────────────── */
function renderMkt() {
  const root = qs('#sec-mkt');
  if (!root) return;

  let cards = '';
  Object.entries(MARKET_META).forEach(([coin, meta]) => {
    const p    = state.prices[coin];
    const prev = state.prevPrices[coin];
    const up   = p && prev && p > prev;
    const dn   = p && prev && p < prev;
    const bc   = up ? 'rgba(0,255,157,.2)' : dn ? 'rgba(255,77,109,.15)' : 'var(--border)';

    cards += `
      <div class="card" id="mkt-${coin}" style="border-color:${bc};transition:border-color .5s">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px">
          <b style="font-family:var(--display);color:#fff">${coin}</b>
          <span class="tag ${meta.cls}">${meta.tag}</span>
        </div>
        <div style="font-size:19px;font-weight:bold;color:${up?'var(--green)':dn?'var(--red)':'var(--accent)'};font-family:var(--display);margin-bottom:4px;transition:color .3s" id="mkt-price-${coin}">
          ${p ? fmtP(p, coin) : '<span style="color:var(--muted);font-size:13px">...</span>'}
        </div>
        <div style="font-size:10px;margin-bottom:8px;color:${up?'var(--green)':dn?'var(--red)':'var(--muted)'}" id="mkt-chg-${coin}">—</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px">
          <div class="cs"><div class="csl">RSI</div><div class="csv" style="color:${meta.rsi<30?'var(--green)':'var(--yellow)'}">${meta.rsi}</div></div>
          <div class="cs"><div class="csl">Soporte</div><div class="csv" style="color:var(--green);font-size:11px">${meta.sup}</div></div>
          <div class="cs"><div class="csl">Resist.</div><div class="csv" style="color:var(--red);font-size:11px">${meta.res}</div></div>
        </div>
      </div>`;
  });

  root.innerHTML = `
    <div class="stl">◈ Mercado — Binance Live</div>
    <div class="al al-b">Precios en tiempo real vía WebSocket público de Binance. Sin API key requerida.</div>
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
  if (card) card.style.borderColor = up ? 'rgba(0,255,157,.2)' : dn ? 'rgba(255,77,109,.15)' : 'var(--border)';
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
  const riskUSD = (p.capital * p.risk_pct / 100).toFixed(2);
  const cap3    = (p.capital * p.risk_pct / 100 * 3).toFixed(2);
  const capOps  = Math.floor(50 / p.risk_pct);
  const riskColor = p.risk_pct <= 1 ? 'var(--green)' : p.risk_pct <= 3 ? 'var(--yellow)' : 'var(--red)';
  const barW    = Math.min(p.risk_pct / 10 * 100, 100);

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
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:14px">
        <div class="cs"><div class="csl">Riesgo/Op</div><div class="csv" id="cap-rv" style="color:${riskColor}">${p.risk_pct}%</div></div>
        <div class="cs"><div class="csl">En USD</div><div class="csv" id="cap-rusd">$${riskUSD}</div></div>
        <div class="cs"><div class="csl">Max 3 ops</div><div class="csv" id="cap-r3" style="color:var(--muted)">$${cap3}</div></div>
        <div class="cs"><div class="csl">Capacidad</div><div class="csv" id="cap-ops" style="color:var(--accent)">~${capOps} ops</div></div>
      </div>
      <div class="lbl">Nivel de riesgo</div>
      <div class="bar" style="margin-bottom:12px"><div class="bf" id="cap-bar" style="width:${barW}%;background:${riskColor}"></div></div>
      <button class="btn btng" onclick="saveCapital()">✓ Guardar</button>
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

function saveCapital() {
  state.profile.capital  = parseFloat(qs('#cap-input')?.value)  || 1000;
  state.profile.risk_pct = parseFloat(qs('#risk-input')?.value) || 2;
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
  state.pending       = [];
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

/* ── Close Modal ─────────────────────────────────────────────────────────── */
let pendingCloseId = null;

function openCloseModal(tradeId) {
  pendingCloseId = tradeId;
  const trade = state.activeTrades.find(t => t.id === tradeId);
  if (!trade) return;
  qs('#close-modal-title').textContent = 'Cerrar — ' + trade.par;
  qs('#close-pnl-input').placeholder = Math.abs((trade.riskUSD || 0) * parseFloat(trade.rr || 1)).toFixed(2);
  qs('#close-pnl-input').value = '';
  setCloseResult('WIN');
  qs('#close-modal').classList.add('open');
}

function setCloseResult(r) {
  qs('#close-result-win').style.opacity  = r === 'WIN'  ? '1' : '.45';
  qs('#close-result-loss').style.opacity = r === 'LOSS' ? '1' : '.45';
  qs('#close-modal').dataset.result = r;
}

function confirmClose() {
  if (!pendingCloseId) return;
  const result   = qs('#close-modal').dataset.result || 'WIN';
  const pnlInput = parseFloat(qs('#close-pnl-input').value);
  const trade    = state.activeTrades.find(t => t.id === pendingCloseId);
  if (!trade) return;
  const pnl = isNaN(pnlInput)
    ? (result === 'WIN' ? Math.abs(trade.riskUSD) * parseFloat(trade.rr || 1) : -Math.abs(trade.riskUSD))
    : (result === 'WIN' ? pnlInput : -Math.abs(pnlInput));
  closeTrade(pendingCloseId, result, pnl);
  qs('#close-modal').classList.remove('open');
  pendingCloseId = null;
  showToast(`Operación ${trade.par} cerrada.`);
  renderAll();
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

  // Wire close modal buttons
  qs('#close-result-win') ?.addEventListener('click', () => setCloseResult('WIN'));
  qs('#close-result-loss')?.addEventListener('click', () => setCloseResult('LOSS'));
  qs('#btn-close-confirm')?.addEventListener('click', confirmClose);
  qs('#btn-close-cancel') ?.addEventListener('click', () => qs('#close-modal').classList.remove('open'));

  // Wire header buttons
  qs('#btn-gen')         ?.addEventListener('click', onGenerate);
  qs('#btn-adapt')       ?.addEventListener('click', onAdaptStrategy);
  qs('#scanner-toggle-hdr')?.addEventListener('click', toggleScanner);

  // Start WebSocket
  connectWS();

  // Initial render
  setTab('ops');
  renderStoragePanel();
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
  openCloseModal, setCloseResult, confirmClose,
  cancelTrade, onAcceptProposal, onRejectProposal,
  setProfileField, toggleCoin, saveProfile,
  saveCapital, updateCapCalc, resetAll, renderAll,
});