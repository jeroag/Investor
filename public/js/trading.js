/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — trading.js v3
   NOTA: buildTrade, checkTPSL, calcProposalMoney, calcSize
   están definidos en strategy.js (que se carga después).
   Este archivo solo contiene lógica que NO sobreescribe.
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── Widget de saldo ────────────────────────────────────────────────────── */
function calcEquity() {
  const { profile, closedTrades, activeTrades, prices } = state;
  const closedPnl = closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const activePnl = activeTrades.reduce((acc, t) => {
    const coin = coinOf(t.par);
    const p = prices[coin] || t.entrada;
    const lev = t.leverage || 1;
    const pnl = t.tipo === 'LONG'
      ? (p - t.entrada) * t.size * lev
      : (t.entrada - p) * t.size * lev;
    return acc + pnl;
  }, 0);
  return { capital: profile.capital, closedPnl, activePnl, total: profile.capital + closedPnl + activePnl };
}

function renderBalanceWidget() {
  const w = qs('#balance-widget');
  if (!w) return;
  const { capital, closedPnl, activePnl, total } = calcEquity();
  const totalPnl = closedPnl + activePnl;
  const totalColor = totalPnl >= 0 ? 'var(--green)' : 'var(--red)';

  const acc = bitunix.account;
  function readField(obj, ...keys) {
    if (!obj) return null;
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
        const v = parseFloat(obj[k]); if (!isNaN(v)) return v;
      }
    }
    return null;
  }

  const realEquity = readField(acc, 'equity', 'totalEquity', 'walletBalance', 'balance');
  const realAvailable = readField(acc, 'available', 'availableBalance', 'availAmt', 'freeBalance');
  const realUnPnl = readField(acc, 'crossUnPnl', 'unrealizedPnl', 'unPnl', 'unrealisedPnl');
  const realBalance = readField(acc, 'balance', 'walletBalance', 'totalBalance');
  const hasRealData = acc && (realEquity !== null || realAvailable !== null);

  const badgeColor = bitunix.configured ? (hasRealData ? 'var(--green)' : 'var(--yellow)') : 'var(--muted)';
  const badgeBg = bitunix.configured ? (hasRealData ? 'rgba(0,209,122,.12)' : 'rgba(245,184,0,.12)') : 'var(--s2)';
  const badgeBorder = bitunix.configured ? (hasRealData ? 'rgba(0,209,122,.3)' : 'rgba(245,184,0,.3)') : 'var(--border)';
  const badgeLabel = bitunix.configured ? (hasRealData ? '🔗 BITUNIX LIVE' : '⚠️ SIN DATOS') : '🔌 CONECTAR';
  const badgeClick = !bitunix.configured ? 'onclick="showBitunixSetup()"' : '';

  const mainValue = hasRealData ? (realEquity ?? realAvailable ?? 0) : total;
  const mainLabel = hasRealData ? 'EQUITY REAL' : 'EQUITY ESTIMADO';

  // Feasible coins strip
  let feasibleStrip = '';
  if (bitunix.configured) {
    const { feasible, infeasible } = buildFeasibleCoins();
    if (feasible.length || infeasible.length) {
      const fChips = feasible.map(f =>
        `<span class="tag tg" title="Margen ~$${f.margin} · Posición ~$${f.notional}">${f.coin}</span>`
      ).join('');
      const iChips = infeasible.slice(0, 4).map(f =>
        `<span class="tag tm" title="Capital mín ~$${f.minCapitalNeeded}" style="text-decoration:line-through;opacity:.5">${f.coin}</span>`
      ).join('');
      feasibleStrip = `
        <div style="margin-top:6px;display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          <span class="bw-label">EJECUTABLES:</span>
          ${fChips || '<span class="tag tr">Ninguna — aumenta capital o leverage</span>'}
          ${iChips}
        </div>`;
    }
  }

  w.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div>
          <div class="bw-label" style="display:flex;align-items:center;gap:6px">
            ${mainLabel}
            <span style="font-size:8px;padding:1px 6px;border-radius:3px;background:${badgeBg};
                         border:1px solid ${badgeBorder};color:${badgeColor};cursor:${badgeClick ? 'pointer' : 'default'}"
                  ${badgeClick}>${badgeLabel}</span>
          </div>
          <div class="bw-value">$${mainValue.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div style="width:1px;height:30px;background:var(--border)"></div>
        <div style="display:flex;gap:14px;flex-wrap:wrap">
          ${hasRealData ? `
            ${realAvailable != null ? `<div><div class="bw-label">DISPONIBLE</div><div style="font-family:var(--font-mono);font-size:13px;font-weight:600">$${realAvailable.toFixed(2)}</div></div>` : ''}
            ${realBalance != null ? `<div><div class="bw-label">BALANCE</div><div style="font-family:var(--font-mono);font-size:13px;font-weight:600">$${realBalance.toFixed(2)}</div></div>` : ''}
            ${realUnPnl != null ? `<div><div class="bw-label">P&L ABIERTO</div><div style="font-family:var(--font-mono);font-size:13px;font-weight:600;color:${realUnPnl >= 0 ? 'var(--green)' : 'var(--red)'}">${realUnPnl >= 0 ? '+' : ''}$${realUnPnl.toFixed(2)}</div></div>` : ''}
          ` : `
            <div><div class="bw-label">P&L CERRADO</div><div style="font-family:var(--font-mono);font-size:13px;font-weight:600;color:${closedPnl >= 0 ? 'var(--green)' : 'var(--red)'}">${closedPnl >= 0 ? '+' : ''}$${closedPnl.toFixed(2)}</div></div>
            <div><div class="bw-label">P&L LATENTE</div><div style="font-family:var(--font-mono);font-size:13px;font-weight:600;color:${activePnl >= 0 ? 'var(--green)' : 'var(--red)'}">${activePnl >= 0 ? '+' : ''}$${activePnl.toFixed(2)}</div></div>
          `}
          <div><div class="bw-label">P&L TOTAL</div><div style="font-family:var(--font-mono);font-size:13px;font-weight:600;color:${totalColor}">${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</div></div>
          <div><div class="bw-label">RIESGO/OP</div><div style="font-family:var(--font-mono);font-size:13px;font-weight:600;color:var(--accent)">1% ($${(mainValue * 0.01).toFixed(2)})</div></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        ${bitunix.configured ? `<button class="btn" style="padding:3px 8px;font-size:9px" onclick="refreshBitunixData()">↻ SYNC</button>` : ''}
        <button class="btn" style="padding:3px 8px;font-size:9px" onclick="toggleBalanceEdit()">✏ CAPITAL</button>
      </div>
    </div>
    <div id="balance-quick-edit" style="display:none;margin-top:8px;align-items:center;gap:8px">
      <span class="bw-label">CAPITAL:</span>
      <input class="inp" type="number" id="balance-input" value="${capital}" step="any" style="width:130px"/>
      <button class="btn btng" style="padding:5px 12px;font-size:11px" onclick="saveQuickCapital()">✓</button>
      <button onclick="toggleBalanceEdit()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:18px">×</button>
    </div>
    ${feasibleStrip}`;
}

/* ── Correlation check ──────────────────────────────────────────────────── */
function checkCorrelation(tipo) {
  const CORRELATED = ['BTC', 'ETH', 'SOL', 'BNB', 'AVAX', 'LINK'];
  const same = state.activeTrades.filter(t => t.tipo === tipo && CORRELATED.includes(coinOf(t.par)));
  if (!same.length) return null;
  const coins = same.map(t => coinOf(t.par)).join(', ');
  const totalRisk = same.reduce((a, t) => a + (t.riskUSD || 0), 0);
  return {
    count: same.length, coins, totalRisk,
    warning: `Ya tienes ${same.length} ${tipo} en activos correlacionados (${coins}). Riesgo acumulado: $${totalRisk.toFixed(2)}.`,
  };
}

function checkTradeExecutability(proposal) {
  if (!bitunix.configured) return null;
  const coin = coinOf(proposal.par);
  const price = state.prices[coin] || proposal.entrada;
  const minQty = BITUNIX_MIN_QTY[coin];
  if (!minQty) return null;
  const equity = typeof getCurrentEquity === 'function' ? getCurrentEquity() : state.profile.capital;
  const riskUSD = equity * 0.01; // estrategia: 1%
  const leverage = state.profile.leverage || 1;
  const slDist = Math.abs(price - proposal.stopLoss);
  const size = slDist > 0 ? riskUSD / slDist : 0;
  if (size < minQty) {
    const minCap = (minQty * slDist) / 0.01;
    return `❌ ${coin}: qty ${size.toFixed(5)} < mínimo Bitunix ${minQty}.\nNecesitas ~$${minCap.toFixed(0)} de equity o mayor leverage.`;
  }
  return null;
}

/* ── commitTrade — guarda y sincroniza ─────────────────────────────────── */
function commitTrade(trade) {
  state.activeTrades.unshift(trade);
  saveKey('activeTrades', state.activeTrades);
  syncTradesToServer();
  logActivity('trade_open',
    `${trade.tipo} ${trade.par} @ ${trade.entrada} · SL ${trade.stopLoss}` +
    ` · TP1 ${trade.tp1}${trade.tp2 ? ' · TP2 ' + trade.tp2 : ''}` +
    `${trade.leverage > 1 ? ' · ' + trade.leverage + 'x' : ''}` +
    ` · Riesgo $${trade.riskUSD?.toFixed(2) || '?'} (1% equity)`
  );
  showToast(`✓ ${trade.par} — entrada ${fmtP(trade.entrada, coinOf(trade.par))}`);
}

function acceptProposal(proposal) {
  const trade = buildTrade(proposal);  // definida en strategy.js
  commitTrade(trade);
  return trade;
}

async function acceptAlert(alert) {
  const execError = checkTradeExecutability(alert);
  if (execError) { showToast(execError, true); return null; }

  const trade = buildTrade(alert);   // definida en strategy.js

  if (bitunix.configured) {
    const confirmed = await showTradeConfirmModal(trade);
    if (!confirmed) return null;
    const result = await placeBitunixOrder(trade);
    if (!result || !result.ok) {
      showToast(`❌ Bitunix rechazó la orden.`, true);
      state.alerts = state.alerts.map(a => a.id === alert.id ? { ...a, status: 'rejected_bitunix' } : a);
      saveKey('alerts', state.alerts);
      renderAlerts();
      return null;
    }
  }

  commitTrade(trade);
  state.alerts = state.alerts.map(a => a.id === alert.id ? { ...a, status: 'accepted' } : a);
  saveKey('alerts', state.alerts);
  setTab('dash');
  return trade;
}

/* ── closeTrade — cierre manual con precio real ─────────────────────────── */
function closeTrade(tradeId, result, pnlOverride) {
  const idx = state.activeTrades.findIndex(t => t.id === tradeId);
  if (idx === -1) return;
  const trade = state.activeTrades[idx];
  const pnl = pnlOverride !== undefined ? pnlOverride
    : result === 'WIN' ? Math.abs(trade.riskUSD || 0) * parseFloat(trade.rr || 1)
      : -Math.abs(trade.riskUSD || 0);
  const closed = { ...trade, result, pnl, closedAt: nowFull() };
  state.closedTrades.unshift(closed);
  state.activeTrades.splice(idx, 1);
  saveKey('activeTrades', state.activeTrades);
  saveKey('closedTrades', state.closedTrades);
  authFetch('/api/trades/close', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trade: closed }),
  }).catch(() => { });
  syncTradesToServer();
  if (bitunix.configured) setTimeout(() => fetchBitunixAccount().then(() => renderBalanceWidget()), 4000);
  return closed;
}

function cancelTrade(tradeId) {
  const trade = state.activeTrades.find(t => t.id === tradeId);
  state.activeTrades = state.activeTrades.filter(t => t.id !== tradeId);
  saveKey('activeTrades', state.activeTrades);
  logActivity('trade_cancel', `Operación cancelada: ${trade?.par || tradeId}`);
  showToast('Operación cancelada.');
  syncTradesToServer();
  renderOps();
}

/* ── updateTradesPnl — actualización DOM directa sin re-render ─────────── */
function updateTradesPnl() {
  if (state.currentTab !== 'ops') return;
  state.activeTrades.forEach(trade => {
    const coin = coinOf(trade.par);
    const price = state.prices[coin] || trade.entrada;
    const prev = state.prevPrices[coin];
    const lev = trade.leverage || 1;
    trade.currentPrice = price;
    trade.pnl = trade.tipo === 'LONG'
      ? (price - trade.entrada) * trade.size * lev
      : (trade.entrada - price) * trade.size * lev;
    trade.pnlPct = trade.tipo === 'LONG'
      ? ((price - trade.entrada) / trade.entrada) * 100 * lev
      : ((trade.entrada - price) / trade.entrada) * 100 * lev;

    const card = qs(`[data-trade-id="${trade.id}"]`);
    if (!card) return;
    const pnlEl = qs('.op-pnl', card);
    const priceEl = qs('.live-price', card);
    if (pnlEl) {
      pnlEl.textContent = `${fmtUSD(trade.pnl)} (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}%)`;
      pnlEl.style.color = trade.pnl >= 0 ? 'var(--green)' : 'var(--red)';
    }
    if (priceEl) {
      priceEl.textContent = (price > prev ? '▲ ' : price < prev ? '▼ ' : '') + fmtP(price, coin);
      priceEl.className = 'live-price ' + (price > prev ? 'up' : price < prev ? 'dn' : 'flat');
    }
  });
}

/* ── Price Alerts ─────────────────────────────────────────────────────── */
function addPriceAlert(coin, targetPrice, direction) {
  const pa = { id: uid(), coin, targetPrice: parseFloat(targetPrice), direction, createdAt: nowTime(), triggered: false };
  state.priceAlerts.push(pa);
  saveKey('priceAlerts', state.priceAlerts);
  renderPriceAlertsPanel();
  showToast(`🔔 Alerta: ${coin} ${direction === 'above' ? '≥' : '≤'} ${fmtP(pa.targetPrice, coin)}`);
  authFetch('/api/price-alerts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alert: pa }),
  }).catch(() => { });
}

function deletePriceAlert(id) {
  state.priceAlerts = state.priceAlerts.filter(a => a.id !== id);
  saveKey('priceAlerts', state.priceAlerts);
  renderPriceAlertsPanel();
  authFetch('/api/price-alerts/' + id, { method: 'DELETE' }).catch(() => { });
}

function checkPriceAlerts() {
  let fired = false;
  state.priceAlerts.forEach(pa => {
    if (pa.triggered) return;
    const price = state.prices[pa.coin];
    if (!price) return;
    const hit = pa.direction === 'above' ? price >= pa.targetPrice : price <= pa.targetPrice;
    if (hit) {
      pa.triggered = true; pa.triggeredAt = nowTime(); pa.triggeredPrice = price; fired = true;
      const msg = `🔔 ${pa.coin} ${pa.direction === 'above' ? 'superó' : 'bajó de'} ${fmtP(pa.targetPrice, pa.coin)} → ${fmtP(price, pa.coin)}`;
      showToast(msg);
      if (state.notifPermission === 'granted') {
        try { new Notification(`🔔 Alerta: ${pa.coin}`, { body: msg, tag: 'pa-' + pa.id }); } catch { }
      }
    }
  });
  if (fired) { saveKey('priceAlerts', state.priceAlerts); if (state.currentTab === 'alerts') renderAlerts(); }
}

function renderPriceAlertsPanel() {
  const root = qs('#price-alerts-panel');
  if (!root) return;
  const active = state.priceAlerts.filter(a => !a.triggered);
  const triggered = state.priceAlerts.filter(a => a.triggered);
  const coinOpts = state.watchedCoins.map(c => `<option value="${c}">${c} — ${COIN_NAMES[c] || c}</option>`).join('');

  root.innerHTML = `
    <div class="stl">🔔 Alertas de Precio</div>
    <div style="display:grid;grid-template-columns:1fr 1fr auto auto;gap:8px;align-items:end;margin-bottom:14px">
      <div><div class="lbl">Moneda</div><select class="inp" id="pa-coin">${coinOpts}</select></div>
      <div><div class="lbl">Precio</div><input class="inp" type="number" id="pa-price" placeholder="Ej: 65000" step="any"/></div>
      <div><div class="lbl">Condición</div><select class="inp" id="pa-dir"><option value="above">≥ Supera</option><option value="below">≤ Cae de</option></select></div>
      <button class="btn btng" style="padding:8px 14px;font-size:11px;align-self:end" onclick="submitPriceAlert()">+ Añadir</button>
    </div>
    ${!active.length && !triggered.length ? '<div style="font-size:11px;color:var(--muted)">Sin alertas activas.</div>' : ''}
    ${active.map(a => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--s2);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:10px">
          <span>🔔</span>
          <div><div style="font-weight:600;font-size:12px">${a.coin}</div>
          <div style="font-size:10px;color:var(--muted)">${a.direction === 'above' ? '≥' : '≤'} ${fmtP(a.targetPrice, a.coin)} · ${a.createdAt}</div></div>
        </div>
        <button onclick="deletePriceAlert('${a.id}')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px">×</button>
      </div>`).join('')}
    ${triggered.map(a => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--s2);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;opacity:.6">
        <div style="display:flex;align-items:center;gap:10px">
          <span>✓</span>
          <div><div style="font-weight:600;font-size:12px">${a.coin} ${a.direction === 'above' ? '≥' : '≤'} ${fmtP(a.targetPrice, a.coin)}</div>
          <div style="font-size:10px;color:var(--muted)">Disparada @ ${fmtP(a.triggeredPrice, a.coin)} · ${a.triggeredAt}</div></div>
        </div>
        <button onclick="deletePriceAlert('${a.id}')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px">×</button>
      </div>`).join('')}`;
}

function submitPriceAlert() {
  const coin = qs('#pa-coin')?.value;
  const price = parseFloat(qs('#pa-price')?.value);
  const dir = qs('#pa-dir')?.value;
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
    ts: nowFull(), found: result.hay_oportunidad,
    razon: result.hay_oportunidad
      ? `${result.par} ${result.tipo} — ${result.setup} (${result.confianza}% conf.)`
      : result.razon,
    coins: state.watchedCoins.join(', '),
  };
  state.scanLog.unshift(entry);
  if (state.scanLog.length > 50) state.scanLog = state.scanLog.slice(0, 50);
  saveKey('scanLog', state.scanLog);
  if (state.currentTab === 'alerts') renderScanLog();
}

function renderScanLog() {
  const root = qs('#scan-log-panel');
  if (!root) return;
  if (!state.scanLog.length) {
    root.innerHTML = '<div style="font-size:11px;color:var(--muted)">El log aparece cada vez que el escáner analiza.</div>';
    return;
  }
  root.innerHTML = state.scanLog.slice(0, 20).map(e => `
    <div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.03)">
      <span style="font-size:13px;flex-shrink:0">${e.found ? '⚡' : '○'}</span>
      <div>
        <div style="font-size:11px;color:${e.found ? 'var(--text)' : 'var(--muted)'}">
          ${e.found ? `<b style="color:var(--accent)">Oportunidad</b> — ${e.razon}` : e.razon}
        </div>
        <div style="font-size:9px;color:var(--muted);margin-top:2px;font-family:var(--font-mono)">${e.ts} · ${e.coins}</div>
      </div>
    </div>`).join('');
}

/* ── Scanner UI (delegado al server-side) ─────────────────────────────── */
function toggleScanner() { toggleServerScanner(); }
function startScanner() { startServerScanner(); }
function stopScanner() { stopServerScanner(); }

function updateScannerUI() {
  const scanHdr = qs('#scanner-toggle-hdr');
  const mini = qs('#scanner-mini');
  const isOn = state.scannerActive || state.scannerOn;

  if (scanHdr) {
    scanHdr.className = 'scanner-btn ' + (isOn ? 'on' : 'off');
    scanHdr.innerHTML = isOn ? '📡 ESCÁNER ON' : '📡 ESCÁNER OFF';
  }
  if (mini) mini.style.display = isOn ? 'block' : 'none';

  const miniTime = qs('#scanner-mini-time');
  if (miniTime && state.lastScan) miniTime.textContent = 'Último: ' + state.lastScan;

  updateScannerBadge();
}

/* ── Notifications ─────────────────────────────────────────────────────── */
async function requestNotifPermission() {
  const p = await Notification.requestPermission();
  state.notifPermission = p;
  renderAlerts();
  if (p === 'granted') showToast('✓ Notificaciones activadas');
  else showToast('Notificaciones denegadas', true);
}

function fireNotification(alert) {
  showScreenNotif(alert);
  if (state.notifPermission === 'granted') {
    try {
      new Notification(`⚡ ${alert.par} — ${alert.tipo}`, {
        body: `${alert.setup} | ${alert.confianza}% conf | R:R 1:${alert.rr}\n${alert.razon}`,
        tag: 'cp-alert',
      });
    } catch { }
  }
}

function showScreenNotif(alert) {
  qs('#screen-notif')?.remove();
  state.activeNotif = alert;
  const coin = coinOf(alert.par);
  const div = el('div', 'notif');
  div.id = 'screen-notif';
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
        <span style="font-family:var(--font-display);font-size:16px;font-weight:800">${alert.par}</span>
        <span class="tag ${alert.tipo === 'LONG' ? 'tg' : 'tr'}">${alert.tipo}</span>
        <span class="tag ${urgencyClass(alert.urgencia)}">${alert.urgencia}</span>
        <span class="tag tc">${alert.confianza}%</span>
      </div>
      <div class="notif-reason">${alert.razon}</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn" style="font-size:10px;padding:7px 14px;flex:1" onclick="setTab('alerts');qs('#screen-notif').remove()">Ver alertas</button>
        <button class="btn btng" style="font-size:10px;padding:7px 14px;flex:1" onclick="acceptAlertById('${alert.id}');qs('#screen-notif').remove()">
          ${bitunix.configured ? '📡 Ejecutar' : '✓ Simular'}
        </button>
      </div>
    </div>`;
  document.body.appendChild(div);
  setTimeout(() => { if (div.parentNode) div.remove(); }, 12000);
}

function urgencyClass(u) { return u === 'ALTA' ? 'tr' : u === 'MEDIA' ? 'ty' : 'tb'; }

async function acceptAlertById(id) {
  const alert = state.alerts.find(a => a.id === id);
  if (alert) { const trade = await acceptAlert(alert); if (trade) renderAll(); }
}

function renderTicker() { }  // ticker eliminado del header