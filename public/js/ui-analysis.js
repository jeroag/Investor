/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — ui-analysis.js
   ═══════════════════════════════════════════════════ */

'use strict';

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

  // Historial — paginado 50 trades por página
  const HIST_PER_PAGE = 50;
  const totalPages    = Math.max(1, Math.ceil(closedTrades.length / HIST_PER_PAGE));
  if (state.histPage >= totalPages) state.histPage = totalPages - 1;
  const pageTrades    = closedTrades.slice(state.histPage * HIST_PER_PAGE, (state.histPage + 1) * HIST_PER_PAGE);

  let histRows = '';
  if (closedTrades.length === 0) {
    histRows = `<div class="empty" style="padding:16px"><div class="et">Sin operaciones cerradas.</div></div>`;
  } else {
    pageTrades.forEach(t => {
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

  const paginationHtml = totalPages > 1 ? `
    <div style="display:flex;align-items:center;justify-content:space-between;padding-top:12px;border-top:1px solid var(--border)">
      <button onclick="histPageNav(-1)" ${state.histPage===0?'disabled':''} style="background:none;border:1px solid var(--border);border-radius:8px;padding:5px 14px;font-size:11px;color:var(--muted);cursor:pointer;opacity:${state.histPage===0?'0.4':'1'}">← Anterior</button>
      <span style="font-size:11px;color:var(--muted)">Pág. ${state.histPage+1}/${totalPages} · ${closedTrades.length} ops</span>
      <button onclick="histPageNav(1)" ${state.histPage>=totalPages-1?'disabled':''} style="background:none;border:1px solid var(--border);border-radius:8px;padding:5px 14px;font-size:11px;color:var(--muted);cursor:pointer;opacity:${state.histPage>=totalPages-1?'0.4':'1'}">Siguiente →</button>
    </div>` : '';

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
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button onclick="showEquityCurve()" style="background:none;border:1px solid var(--border);border-radius:8px;padding:5px 12px;font-size:11px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:5px;transition:all .2s" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
            📈 Equity Curve
          </button>
          <button onclick="exportTradesCSV()" style="background:none;border:1px solid var(--border);border-radius:8px;padding:5px 12px;font-size:11px;color:var(--muted);cursor:pointer;display:flex;align-items:center;gap:5px;transition:all .2s" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
            ⬇ Exportar CSV
          </button>
        </div>` : ''}
      </div>
      ${histRows}
      ${paginationHtml}
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

/* ══════════════════════════════════════════════════════════════════
   EQUITY CURVE — Modal con Chart.js
   ══════════════════════════════════════════════════════════════════ */

/** Carga Chart.js desde CDN si no está disponible */
function loadChartJs() {
  return new Promise((resolve, reject) => {
    if (window.Chart) return resolve(window.Chart);
    const s   = document.createElement('script');
    s.src     = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
    s.onload  = () => resolve(window.Chart);
    s.onerror = () => reject(new Error('No se pudo cargar Chart.js'));
    document.head.appendChild(s);
  });
}

async function showEquityCurve(filterDays, filterCoin) {
  try {
    const res  = await authFetch('/api/trades/equity-curve');
    const data = await res.json();

    if (!data.points?.length) {
      showToast('Sin trades cerrados para mostrar la curva.', true);
      return;
    }

    // Eliminar modal anterior
    document.getElementById('eq-modal')?.remove();

    // Filtrar por fecha y/o moneda
    const activeDays = filterDays || 0;
    const activeCoin = filterCoin || '';
    const cutoff = activeDays > 0 ? Date.now() - activeDays * 86_400_000 : 0;
    let allPoints = data.points;
    let filteredPoints = allPoints;
    if (cutoff > 0) filteredPoints = filteredPoints.filter(p => new Date(p.date || 0).getTime() >= cutoff);
    if (activeCoin) filteredPoints = filteredPoints.filter(p => (p.par || '').startsWith(activeCoin));

    // Recalcular cumPnl para el rango filtrado
    let cum = 0;
    filteredPoints = filteredPoints.map(p => { cum += p.pnl; return { ...p, cumPnl: parseFloat(cum.toFixed(2)) }; });

    const points = filteredPoints;
    const wins   = points.filter(p => p.result === 'WIN').length;
    const losses = points.length - wins;
    const totalPnl = points.reduce((a, p) => a + (p.pnl || 0), 0);
    const avgWin  = wins > 0 ? (points.filter(p => p.result === 'WIN').reduce((a, p) => a + p.pnl, 0) / wins).toFixed(2) : '0.00';
    const avgLoss = losses > 0 ? Math.abs(points.filter(p => p.result !== 'WIN').reduce((a, p) => a + p.pnl, 0) / losses).toFixed(2) : '0.00';
    let maxDD = 0, peak = 0;
    points.forEach(p => { if (p.cumPnl > peak) peak = p.cumPnl; const dd = peak - p.cumPnl; if (dd > maxDD) maxDD = dd; });
    const summary = {
      total: points.length, wins, losses,
      winRate: points.length > 0 ? ((wins / points.length) * 100).toFixed(0) : 0,
      totalPnl: totalPnl.toFixed(2), avgWin, avgLoss,
      maxDrawdown: maxDD.toFixed(2),
    };

    const isDark = document.body.classList.contains('dark');
    const textColor  = isDark ? '#e1e1e1' : '#1a1a2e';
    const gridColor  = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const accent     = '#6c63ff';
    const winColor   = '#00c896';
    const lossColor  = '#ff4757';

    const filterBtns = [
      { label: 'Todo', days: 0 },
      { label: '7d',   days: 7 },
      { label: '30d',  days: 30 },
      { label: '90d',  days: 90 },
    ].map(f => `
      <button onclick="showEquityCurve(${f.days}, '${activeCoin}')"
        style="padding:4px 10px;border-radius:6px;font-size:11px;border:1px solid var(--border);cursor:pointer;
               background:${activeDays === f.days ? 'var(--accent)' : 'var(--s2)'};
               color:${activeDays === f.days ? '#fff' : 'var(--muted)'}">
        ${f.label}
      </button>`).join('');

    // Coins that appear in trade history
    const coinsInHistory = [...new Set(allPoints.map(p => (p.par || '').split('/')[0]).filter(Boolean))].sort();
    const coinFilterBtns = ['', ...coinsInHistory].map(c => `
      <button onclick="showEquityCurve(${activeDays}, '${c}')"
        style="padding:4px 10px;border-radius:6px;font-size:11px;border:1px solid var(--border);cursor:pointer;
               background:${activeCoin === c ? 'var(--yellow)' : 'var(--s2)'};
               color:${activeCoin === c ? '#000' : 'var(--muted)'}">
        ${c || 'Todos'}
      </button>`).join('');

    const modal = document.createElement('div');
    modal.id    = 'eq-modal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;
      display:flex;align-items:center;justify-content:center;padding:16px;
    `;

    modal.innerHTML = `
      <div style="background:var(--card);border-radius:16px;padding:24px;width:min(820px,100%);
                  max-height:90vh;overflow-y:auto;position:relative;box-shadow:0 24px 80px rgba(0,0,0,.4)">
        <button onclick="document.getElementById('eq-modal').remove()"
          style="position:absolute;top:12px;right:12px;background:none;border:none;
                 font-size:22px;cursor:pointer;color:var(--muted);line-height:1">✕</button>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;flex-wrap:wrap;gap:8px">
          <h3 style="margin:0;font-size:16px;font-weight:700">📈 Equity Curve</h3>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${filterBtns}</div>
        </div>
        ${coinsInHistory.length > 1 ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;margin-bottom:4px">${coinFilterBtns}</div>` : ''}
        <p style="margin:4px 0 16px;font-size:12px;color:var(--muted)">
          ${summary.total} trades · ${activeDays > 0 ? 'Últimos ' + activeDays + ' días' : 'Histórico completo'}${activeCoin ? ' · Moneda: ' + activeCoin : ''}
        </p>

        <!-- KPIs -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:20px">
          ${kpiCard('P&L Total', (summary.totalPnl >= 0 ? '+' : '') + '$' + summary.totalPnl, summary.totalPnl >= 0 ? winColor : lossColor)}
          ${kpiCard('Win Rate', summary.winRate + '%', summary.winRate >= 50 ? winColor : lossColor)}
          ${kpiCard('Trades', `${summary.wins}W / ${summary.losses}L`, textColor)}
          ${kpiCard('Avg WIN', '+$' + summary.avgWin, winColor)}
          ${kpiCard('Avg LOSS', '$' + summary.avgLoss, lossColor)}
          ${kpiCard('Max Drawdown', '-$' + summary.maxDrawdown, lossColor)}
        </div>

        <!-- Gráfica -->
        <div style="position:relative;height:300px">
          <canvas id="eq-canvas"></canvas>
        </div>

        <!-- Distribución -->
        <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
          ${points.map(p => `
            <div title="${p.par} ${p.tipo} | P&L: ${p.pnl >= 0 ? '+' : ''}$${p.pnl} | Acum: $${p.cumPnl}"
              style="width:20px;height:20px;border-radius:4px;cursor:pointer;flex-shrink:0;
                     background:${p.result === 'WIN' ? winColor : lossColor}33;
                     border:1.5px solid ${p.result === 'WIN' ? winColor : lossColor}">
            </div>`).join('')}
        </div>
        <p style="font-size:10px;color:var(--muted);margin:6px 0 0">
          Cada cuadro = 1 trade · Hover para detalles · Verde=WIN · Rojo=LOSS
        </p>
      </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // Renderizar Chart.js
    await loadChartJs();
    const ctx = document.getElementById('eq-canvas').getContext('2d');

    // Zona bajo la curva (gradiente)
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0,   accent + '44');
    gradient.addColorStop(1,   accent + '00');

    new Chart(ctx, {
      type: 'line',
      data: {
        labels:   points.map(p => p.date || `#${p.index}`),
        datasets: [
          {
            label:           'P&L Acumulado ($)',
            data:            points.map(p => p.cumPnl),
            borderColor:     accent,
            backgroundColor: gradient,
            borderWidth:     2.5,
            pointRadius:     points.length > 30 ? 2 : 4,
            pointBackgroundColor: points.map(p => p.result === 'WIN' ? winColor : lossColor),
            pointBorderColor:     'transparent',
            tension:         0.3,
            fill:            true,
          },
        ],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDark ? '#1e1e2e' : '#fff',
            titleColor:      textColor,
            bodyColor:       textColor,
            borderColor:     accent,
            borderWidth:     1,
            callbacks: {
              label: ctx => {
                const p = points[ctx.dataIndex];
                return [
                  `Acum: ${ctx.raw >= 0 ? '+' : ''}$${ctx.raw}`,
                  `Trade: ${p.par} ${p.tipo} · ${p.result}`,
                  `Este trade: ${p.pnl >= 0 ? '+' : ''}$${p.pnl}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            ticks:  { color: textColor, font: { size: 10 }, maxTicksLimit: 10 },
            grid:   { color: gridColor },
          },
          y: {
            ticks: {
              color:    textColor,
              font:     { size: 10 },
              callback: v => (v >= 0 ? '+' : '') + '$' + v,
            },
            grid:       { color: gridColor },
            // Línea de cero
            afterBuildTicks(axis) {
              if (!axis.ticks.find(t => t.value === 0))
                axis.ticks.push({ value: 0 });
            },
          },
        },
      },
    });

  } catch (e) {
    showToast('Error cargando equity curve: ' + e.message, true);
  }
}

function kpiCard(label, value, color = 'var(--fg)') {
  return `
    <div style="background:var(--bg);border-radius:10px;padding:10px 12px;text-align:center;border:1px solid var(--border)">
      <div style="font-size:13px;font-weight:700;color:${color}">${value}</div>
      <div style="font-size:10px;color:var(--muted);margin-top:2px">${label}</div>
    </div>`;
}
