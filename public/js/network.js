/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — network.js v3.1 (AUDITADO)
   ═══════════════════════════════════════════════════

   CORRECCIÓN [ALTO] — Token de sesión en URL del WebSocket:
   La versión original construía la URL del WS server-side incluyendo
   el token como query param (?token=...). Este token queda expuesto en:
   - Logs del servidor Railway y cualquier proxy/CDN
   - Historial del navegador en algunos casos
   Un atacante con acceso a logs podría robar sesiones activas.

   SOLUCIÓN: El WebSocket autentica EXCLUSIVAMENTE via cookie httpOnly.
   La cookie cp_token se envía automáticamente por el browser en el
   handshake de upgrade (mismo dominio + SameSite=Strict).
   Se elimina el fallback ?token= del cliente.
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── Sincronización con servidor (cliente → servidor) ───────────────────── */
async function syncTradesToServer() {
  try {
    await authFetch('/api/trades/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeTrades: state.activeTrades }),
    });
  } catch (e) {
    console.warn('[sync]', e.message);
  }
}

async function pollServerClosedTrades() {
  try {
    const res = await authFetch('/api/trades/closed-by-server', {}, { skipRedirect: true });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.closed || data.closed.length === 0) return;

    let changed = false;
    const confirmedIds = [];

    for (const closed of data.closed) {
      const alreadyDone = state.closedTrades.some(t => t.id === closed.id);
      if (alreadyDone) { confirmedIds.push(closed.id); continue; }

      const idx = state.activeTrades.findIndex(t => t.id === closed.id);
      if (idx === -1) { confirmedIds.push(closed.id); continue; }

      state.activeTrades.splice(idx, 1);
      state.closedTrades.unshift(closed);
      confirmedIds.push(closed.id);
      changed = true;
      _toastTradeClosed(closed);
    }

    if (confirmedIds.length) {
      await authFetch('/api/trades/confirm-closed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: confirmedIds }),
      }).catch(() => { });
    }

    if (changed) {
      saveKey('activeTrades', state.activeTrades);
      saveKey('closedTrades', state.closedTrades);
      renderAll();
    }
  } catch (e) {
    console.warn('[poll]', e.message);
  }
}

/* ── WebSocket del servidor — fuente única de verdad ───────────────────── */
let serverWs, serverWsRetry;
let serverWsReconnectAttempt = 0;

function connectServerWS() {
  clearTimeout(serverWsRetry);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  // CORRECCIÓN: eliminado ?token= de la URL.
  // El browser envía la cookie cp_token automáticamente en el handshake WS
  // cuando comparte el mismo dominio. SameSite=Strict + HttpOnly la protegen.
  const url = `${protocol}//${location.host}/ws`;
  try { serverWs = new WebSocket(url); } catch { return; }

  const connectTime = Date.now();

  serverWs.onopen = () => {
    // Conexión estable → reset backoff
    if (Date.now() - connectTime > 10_000) serverWsReconnectAttempt = 0;
    serverWsReconnectAttempt = 0;
  };

  serverWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'PRICES_SNAPSHOT': _handlePricesSnapshot(msg.prices); break;
        case 'PRICE_UPDATE': _handlePriceUpdate(msg.coin, msg.price); break;
        case 'TRADE_CLOSED': _handleServerTradeClosed(msg.trade); break;
        case 'PARTIAL_CLOSE': _handlePartialClose(msg); break;
        case 'BREAKEVEN': _handleBreakeven(msg.trade); break;
        case 'SCANNER_ALERT': handleServerScannerAlert(msg.alert); break;
      }
    } catch { }
  };

  serverWs.onclose = () => {
    // Backoff exponencial: 8s, 16s, 32s, 64s, max 120s
    serverWsReconnectAttempt++;
    const delay = Math.min(8000 * Math.pow(2, serverWsReconnectAttempt - 1), 120_000);
    serverWsRetry = setTimeout(connectServerWS, delay);
  };
  serverWs.onerror = () => { };
}

/* ─────────────────────────────────────────────────────────────────────────
   HANDLERS DE EVENTOS WS
   ───────────────────────────────────────────────────────────────────────── */

function _handlePricesSnapshot(prices) {
  if (!prices) return;
  Object.assign(state.prices, prices);
  updateTradesPnl();
  renderBalanceWidget();
}

function _handlePriceUpdate(coin, price) {
  if (!coin || !price) return;
  state.prevPrices[coin] = state.prices[coin] || price;
  state.prices[coin] = price;
  onPriceUpdate(coin, price);
}

/**
 * TRADE_CLOSED — el servidor cerró un trade (TP o SL alcanzado).
 */
function _handleServerTradeClosed(closed) {
  if (!closed?.id) return;
  if (state.closedTrades.some(t => t.id === closed.id)) return;
  const idx = state.activeTrades.findIndex(t => t.id === closed.id);
  if (idx !== -1) state.activeTrades.splice(idx, 1);

  if (window._tradeChartInstances?.[closed.id]) {
    try { window._tradeChartInstances[closed.id].remove(); } catch { }
    delete window._tradeChartInstances[closed.id];
    delete window._tradeChartTimeframes?.[closed.id];
  }

  state.closedTrades.unshift(closed);
  saveKey('activeTrades', state.activeTrades);
  saveKey('closedTrades', state.closedTrades);

  _toastTradeClosed(closed);

  authFetch('/api/trades/confirm-closed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [closed.id] }),
  }).catch(() => { });

  renderAll();
}

/**
 * PARTIAL_CLOSE — TP1 alcanzado: 50% cerrado, SL movido a breakeven.
 */
function _handlePartialClose(msg) {
  const { trade, partialQty, partialPnl, partialFees, newSL, bitunixOk } = msg;
  if (!trade?.id) return;

  const idx = state.activeTrades.findIndex(t => t.id === trade.id);
  if (idx !== -1) {
    Object.assign(state.activeTrades[idx], {
      size: trade.size,
      stopLoss: trade.stopLoss,
      tp1Hit: true,
      breakevenSet: true,
      partialClosed: true,
      partialCloseQty: trade.partialCloseQty,
      partialClosePnl: trade.partialClosePnl,
      partialClosePrice: trade.partialClosePrice,
    });
    saveKey('activeTrades', state.activeTrades);
  }

  const coin = coinOf(trade.par || '');
  const pnlStr = partialPnl != null ? `+$${Math.abs(partialPnl).toFixed(2)}` : '';
  showToast(
    `✂️ ${trade.par} — TP1 alcanzado! 50% cerrado ${pnlStr ? '(' + pnlStr + ' neto)' : ''}` +
    ` | SL → BE $${fmtP(newSL, coin)}` +
    `${!bitunixOk && window.bitunix?.configured ? ' ⚠️ Error Bitunix' : ''}`
  );

  if (state.currentTab === 'ops') renderOps();
  if (state.currentTab === 'dash') renderDash();
}

/**
 * BREAKEVEN — SL movido manualmente a breakeven por el servidor.
 */
function _handleBreakeven(trade) {
  if (!trade?.id) return;
  const idx = state.activeTrades.findIndex(t => t.id === trade.id);
  if (idx !== -1) {
    state.activeTrades[idx].stopLoss = trade.stopLoss;
    state.activeTrades[idx].breakevenSet = true;
    saveKey('activeTrades', state.activeTrades);
  }
  const coin = coinOf(trade.par || '');
  showToast(`🔒 ${trade.par} — SL → breakeven $${fmtP(trade.stopLoss, coin)}`);
  if (state.currentTab === 'ops') renderOps();
}

function handleServerScannerAlert(alert) {
  if (!alert?.id) return;
  if (state.alerts.some(a => a.id === alert.id)) return;
  state.alerts.unshift({ ...alert, status: 'pending' });
  if (state.alerts.length > 30) state.alerts.pop();
  saveKey('alerts', state.alerts);
  showScreenNotif(alert);
  if (state.currentTab === 'alerts') renderAlerts();
  updateScannerBadge();
  updateAlertBadge();
}

/* ── Toast helper ──────────────────────────────────────────────────────── */
function _toastTradeClosed(closed) {
  if (closed.result === 'WIN') {
    const label = closed.partialClosed
      ? `TP2 alcanzado! Neto total: +$${Math.abs(closed.pnl).toFixed(2)}`
      : `TP alcanzado! Neto: +$${Math.abs(closed.pnl).toFixed(2)}`;
    showToast(`✅ ${closed.par} — ${label}`);
  } else if (closed.result === 'BREAKEVEN') {
    showToast(`↔ ${closed.par} — Breakeven. P&L real: $${closed.pnl.toFixed(2)}`);
  } else {
    const be = closed.breakevenSet ? ' (BE activo, pérdida por fees)' : '';
    showToast(`❌ ${closed.par} — SL: -$${Math.abs(closed.pnl).toFixed(2)}${be}`, true);
  }
}

/* ── Control del escáner server-side ─────────────────────────────────── */
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
      logActivity('scanner_on', `Escáner activado — cada ${data.intervalMin}min`);
      showToast(`🔍 Escáner SERVER activo (24/7) — cada ${data.intervalMin}min`);
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
    logActivity('scanner_off', 'Escáner detenido');
    showToast('⏹ Escáner detenido');
    updateScannerBadge();
  } catch { }
}

async function toggleServerScanner() {
  if (state.scannerActive) await stopServerScanner();
  else await startServerScanner();
  if (state.currentTab === 'alerts') renderAlerts();
}

function updateScannerBadge() {
  const btn = qs('#scanner-toggle-btn');
  if (!btn) return;
  btn.textContent = state.scannerActive ? '⏹ DETENER' : '▶ ESCÁNER 24/7';
  btn.style.background = state.scannerActive ? 'rgba(242,54,69,.2)' : '';
  btn.style.borderColor = state.scannerActive ? 'rgba(242,54,69,.5)' : '';
  btn.style.color = state.scannerActive ? 'var(--red)' : '';
}

/* ── Binance WebSocket ─────────────────────────────────────────────────── */
let ws, wsRetryTimer;
let wsReconnectAttempt = 0;

function connectWS() {
  if (ws) { try { ws.close(); } catch { } }
  clearTimeout(wsRetryTimer);
  setWsStatus('connecting');
  ws = new WebSocket(buildWsUrl(state.watchedCoins));

  const connectTime = Date.now();

  ws.onopen = () => {
    setWsStatus('live');
    if (Date.now() - connectTime > 15_000) wsReconnectAttempt = 0;
    wsReconnectAttempt = 0;
  };

  ws.onmessage = (e) => {
    const { data: d } = JSON.parse(e.data);
    if (!d) return;
    const coin = d.s.replace('USDT', '');
    const price = parseFloat(d.c);
    state.prevPrices[coin] = state.prices[coin] || price;
    state.prices[coin] = price;

    if (state.currentTab === 'dash') {
      clearTimeout(window._dashRefreshTimer);
      window._dashRefreshTimer = setTimeout(renderDash, 3000);
    }

    onPriceUpdate(coin, price);
  };

  ws.onerror = () => setWsStatus('error');
  ws.onclose = () => {
    setWsStatus('error');
    // Backoff exponencial: 4s, 8s, 16s, 32s, max 60s
    wsReconnectAttempt++;
    const delay = Math.min(4000 * Math.pow(2, wsReconnectAttempt - 1), 60_000);
    wsRetryTimer = setTimeout(connectWS, delay);
  };
}

function setWsStatus(s) {
  state.wsStatus = s;
  const dot = qs('.ws-dot, #ws-dot-ref');
  const label = qs('#ws-label');
  if (dot) dot.className = 'ws-dot ' + s;
  if (label) {
    label.textContent = s === 'live' ? 'LIVE' : s === 'connecting' ? 'CONECTANDO' : 'RECONECTANDO';
    label.style.color = s === 'live' ? 'var(--green)' : s === 'connecting' ? 'var(--yellow)' : 'var(--red)';
  }
  const genBtn = qs('#btn-gen');
  if (genBtn) genBtn.disabled = (s !== 'live') || state.readOnlyMode;
}

/**
 * onPriceUpdate — SOLO actualiza UI y alertas de precio.
 * NO llama a checkTPSL — responsabilidad exclusiva del servidor.
 */
function onPriceUpdate(coin, price) {
  updateTradesPnl();
  checkPriceAlerts();
  if (state.currentTab === 'mkt') updateMarketPrice(coin, price);
}