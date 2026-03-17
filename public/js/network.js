/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — network.js
   ═══════════════════════════════════════════════════ */

'use strict';

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
      logActivity('scanner_on', `Escáner activado — cada ${data.intervalMin} min`);
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
    logActivity('scanner_off', 'Escáner detenido');
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
  // Limpiar gráfico del trade cerrado antes de re-renderizar
  if (_tradeChartInstances[closed.id]) {
    try { _tradeChartInstances[closed.id].remove(); } catch {}
    delete _tradeChartInstances[closed.id];
    delete _tradeChartTimeframes[closed.id];
  }
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
    if (state.currentTab === 'dash') {
      clearTimeout(window._dashRefreshTimer);
      window._dashRefreshTimer = setTimeout(renderDash, 3000);
    }
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
