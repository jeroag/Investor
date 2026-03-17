/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — trading.js
   ═══════════════════════════════════════════════════ */

'use strict';

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
  const badgeClick = !bitunix.configured ? `onclick="showBitunixSetup()"` : '';

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
        ${bitunix.configured ? `<button onclick="refreshBitunixData()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:10px;color:var(--muted);cursor:pointer">↻ Sync</button>` : ''}
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
  // Fórmula correcta para futuros:
  // qty = riskUSD / slDist
  // El leverage NO divide qty — solo reduce el margen requerido.
  // P&L = qty × (precio_salida - entrada), independiente del leverage.
  // margin = qty × precio / leverage
  const dist = Math.abs(entry - stopLoss);
  return dist > 0 ? riskUSD / dist : 0.001;
}

// Construye el objeto trade SIN guardarlo todavía en el estado.
// Si Bitunix está configurado, solo se confirma tras su aprobación.
/**
 * Valida si una propuesta es ejecutable con el capital actual.
 * Devuelve null si es OK, o un string con el mensaje de error.
 */
function checkCorrelation(tipo) {
  const CORRELATED = ['BTC','ETH','SOL','BNB','AVAX','LINK'];
  const activeSameSide = state.activeTrades.filter(t => {
    const coin = coinOf(t.par);
    return t.tipo === tipo && CORRELATED.includes(coin);
  });
  if (activeSameSide.length === 0) return null;
  const coins = activeSameSide.map(t => coinOf(t.par)).join(', ');
  const totalRisk = activeSameSide.reduce((a, t) => a + (t.riskUSD || 0), 0);
  return {
    count: activeSameSide.length,
    coins,
    totalRisk,
    warning: `Ya tienes ${activeSameSide.length} ${tipo} abierto${activeSameSide.length > 1 ? 's' : ''} en activos correlacionados (${coins}). Riesgo acumulado: $${totalRisk.toFixed(2)}.`
  };
}

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
    const minCapital = (minQty * Math.abs(price - proposal.stopLoss)) / (state.profile.risk_pct / 100);
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
  logActivity('trade_open', `${trade.tipo} ${trade.par} @ ${trade.entrada} · SL ${trade.stopLoss} · TP ${trade.tp1}${trade.leverage > 1 ? ' · ' + trade.leverage + 'x' : ''}`);
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
  setTab('dash');
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

  // Guardar trade cerrado en Supabase vía servidor
  authFetch('/api/trades/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trade: closed }),
  }).catch(e => console.warn('[closeTrade] Error guardando en servidor:', e.message));

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
  const _cancelledTrade = state.activeTrades.find(t => t.id === tradeId) || {};
  logActivity('trade_cancel', `Operación cancelada: ${_cancelledTrade.par || tradeId}`);
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
    syncTradesToServer();
    // Solo re-renderizar completo si hubo cierres (no solo breakeven)
    // Para evitar destruir gráficos inline abiertos
    const hadClosures = state.autoClosedIds.size > 0;
    if (hadClosures) {
      if (state.currentTab === 'ops')  renderOps();
      if (state.currentTab === 'perf') renderPerf();
    }
    // Si solo fue breakeven, actualizar el SL directamente en DOM
    else if (state.currentTab === 'ops') {
      state.activeTrades.forEach(t => {
        if (!t.breakevenSet) return;
        const coin  = coinOf(t.par);
        const slEl  = qs(`[data-trade-id="${t.id}"] .op-sl`);
        if (slEl) slEl.textContent = 'SL: ' + fmtP(t.stopLoss, coin) + ' 🔒';
      });
    }
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
  // Sync to Supabase (Telegram ↔ app)
  authFetch('/api/price-alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alert: pa }),
  }).catch(() => {});
}

function deletePriceAlert(id) {
  state.priceAlerts = state.priceAlerts.filter(a => a.id !== id);
  saveKey('priceAlerts', state.priceAlerts);
  renderPriceAlertsPanel();
  authFetch('/api/price-alerts/' + id, { method: 'DELETE' }).catch(() => {});
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

    // Filtro cliente: verificar que la moneda del escáner sea ejecutable
    if (result.hay_oportunidad && bitunix.configured) {
      const coin = (result.par || '').split('/')[0];
      const { feasible } = buildFeasibleCoins();
      const ejecutable = feasible.some(f => f.coin === coin);
      if (!ejecutable) {
        console.warn(`[Escáner] Alerta de ${result.par} descartada — capital insuficiente para mínimo Bitunix`);
        result.hay_oportunidad = false;
        result.razon = `Capital insuficiente para el mínimo de Bitunix en ${result.par}. ${result.razon}`;
      }
    }

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
      logActivity('scanner_alert', `Alerta: ${alert.tipo} ${alert.par} @ ${alert.entrada} — ${alert.confianza}% confianza`);
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
function renderTicker() { /* ticker eliminado del header */ }


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
  const margin    = notional / leverage;       // dinero real bloqueado (margen inicial)
  const maxWin    = riskUSD * parseFloat(proposal.rr || 1);
  const capitalPct = (margin / capital * 100); // % del capital usado

  // Avisos
  const warnings = [];
  if (margin > capital * 0.5) warnings.push('⚠️ Posición >50% del capital');
  if (margin > capital)       warnings.push('🚨 Margen supera el capital disponible');
  if (leverage > 10)          warnings.push('⚠️ Apalancamiento muy alto');

  return { riskUSD, size, notional, margin, maxWin, capitalPct, leverage, riskPct, warnings };
}
