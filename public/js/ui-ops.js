/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — ui-ops.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── Render: Ops ─────────────────────────────────────────────────────────── */
/* ══════════════════════════════════════════════════════════════════
   DASHBOARD DE INICIO
   ══════════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const root = qs('#sec-dash');
  if (!root) return;

  const { closedTrades, activeTrades, prices, profile, alerts, scannerOn, lastScan } = state;
  const now  = Date.now();
  const day  = 86_400_000;
  const week = 7 * day;

  // P&L activo
  const activePnl = activeTrades.reduce((acc, t) => {
    const p = prices[coinOf(t.par)] || t.entrada;
    return acc + (t.tipo === 'LONG' ? p - t.entrada : t.entrada - p) * (t.size||0) * (t.leverage||1);
  }, 0);

  // Stats globales
  const totalClosed = closedTrades.length;
  const totalWins   = closedTrades.filter(t => t.result === 'WIN').length;
  const totalPnl    = closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const winRate     = totalClosed > 0 ? (totalWins / totalClosed * 100).toFixed(0) : '—';

  // Stats 7 días
  const weekTrades  = closedTrades.filter(t => (now - new Date(t.closedAt||0).getTime()) < week);
  const weekPnl     = weekTrades.reduce((a, t) => a + (t.pnl||0), 0);
  const weekWins    = weekTrades.filter(t => t.result === 'WIN').length;
  const weekWR      = weekTrades.length > 0 ? (weekWins / weekTrades.length * 100).toFixed(0) : '—';

  // Última alerta
  const lastAlert   = alerts[0];

  // Trades activos con P&L
  const activeCards = activeTrades.map(t => {
    const coin  = coinOf(t.par);
    const price = prices[coin] || t.entrada;
    const pnl   = (t.tipo === 'LONG' ? price - t.entrada : t.entrada - price) * (t.size||0) * (t.leverage||1);
    const dir   = t.tipo === 'LONG' ? '🟢' : '🔴';
    const pnlColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;gap:8px;align-items:center">
          <span>${dir}</span>
          <div>
            <div style="font-weight:600;font-size:13px">${t.par}</div>
            <div style="font-size:10px;color:var(--muted)">E: ${fmtP(t.entrada, coin)} · SL: ${fmtP(t.stopLoss, coin)}</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-family:var(--serif);font-weight:700;color:${pnlColor}">${fmtUSD(pnl)}</div>
          <div style="font-size:10px;color:var(--muted)">${t.leverage||1}x leverage</div>
        </div>
      </div>`;
  }).join('');

  // BTC dominance / precio de referencia
  const btcPrice = prices['BTC'];
  const ethPrice = prices['ETH'];
  const btcMeta  = MARKET_META['BTC'];
  const ethMeta  = MARKET_META['ETH'];

  const mkRef = (coin, meta, price) => {
    if (!price) return '';
    const chg = meta?.change24h;
    const chgStr = chg != null ? `<span style="color:${chg>=0?'var(--green)':'var(--red)'};font-size:11px">${chg>=0?'▲':' ▼'}${Math.abs(chg).toFixed(2)}%</span>` : '';
    return `
      <div style="text-align:center;padding:10px;background:var(--s2);border-radius:10px;flex:1">
        <div style="font-size:11px;color:var(--muted);margin-bottom:3px">${coin}</div>
        <div style="font-family:var(--serif);font-size:16px;font-weight:700">${fmtP(price, coin)}</div>
        <div style="margin-top:2px">${chgStr}</div>
        ${meta?.macroTrend ? `<div style="font-size:9px;color:${meta.macroTrend==='ALCISTA'?'var(--green)':meta.macroTrend==='BAJISTA'?'var(--red)':'var(--muted)'};margin-top:2px">${meta.macroTrend}</div>` : ''}
      </div>`;
  };

  // Scanner status
  const scannerStatus = scannerOn
    ? `<span style="color:var(--green);font-size:11px">● ACTIVO</span>`
    : `<span style="color:var(--muted);font-size:11px">○ INACTIVO</span>`;

  root.innerHTML = `
    <div class="stl">◈ Inicio Rápido</div>

    <!-- Referencia de mercado -->
    <div style="display:flex;gap:8px;margin-bottom:12px">
      ${mkRef('BTC', btcMeta, btcPrice)}
      ${mkRef('ETH', ethMeta, ethPrice)}
      <div style="text-align:center;padding:10px;background:var(--s2);border-radius:10px;flex:1">
        <div style="font-size:11px;color:var(--muted);margin-bottom:3px">Escáner</div>
        <div style="margin:4px 0">${scannerStatus}</div>
        <div style="font-size:9px;color:var(--subtle)">${lastScan ? 'Último: ' + lastScan : 'Sin escanear'}</div>
      </div>
    </div>

    <!-- KPIs rápidos -->
    <div class="kpi-grid" style="margin-bottom:12px">
      <div class="kpi">
        <div class="kpi-lbl">P&L Total</div>
        <div class="kpi-val" style="color:${totalPnl>=0?'var(--green)':'var(--red)'}">${fmtUSD(totalPnl)}</div>
        <div class="kpi-sub">${totalClosed} ops · WR ${winRate}%</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">P&L Activo</div>
        <div class="kpi-val" style="color:${activePnl>=0?'var(--green)':'var(--red)'}">${fmtUSD(activePnl)}</div>
        <div class="kpi-sub">${activeTrades.length} posiciones</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Esta semana</div>
        <div class="kpi-val" style="color:${weekPnl>=0?'var(--green)':'var(--red)'}">${fmtUSD(weekPnl)}</div>
        <div class="kpi-sub">${weekTrades.length} ops · WR ${weekWR}%</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Capital</div>
        <div class="kpi-val">$${profile.capital.toLocaleString()}</div>
        <div class="kpi-sub">Riesgo ${profile.risk_pct}% · ${profile.leverage||1}x</div>
      </div>
    </div>

    <!-- Posiciones activas -->
    ${activeTrades.length > 0 ? `
    <div class="card" style="margin-bottom:12px">
      <div class="stl" style="margin-bottom:4px">Posiciones abiertas</div>
      ${activeCards}
    </div>` : `
    <div class="card" style="margin-bottom:12px;text-align:center;padding:20px">
      <div style="font-size:28px;margin-bottom:8px">📭</div>
      <div style="color:var(--muted);font-size:13px">Sin posiciones abiertas</div>
      <button class="btn btng" style="margin-top:12px;font-size:12px" onclick="onGenerate()">⚡ Analizar ahora</button>
    </div>`}

    <!-- Última alerta IA -->
    ${lastAlert ? `
    <div class="card" style="margin-bottom:12px">
      <div class="stl" style="margin-bottom:4px">Última alerta IA</div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-weight:600">${lastAlert.par}</span>
          <span style="color:${lastAlert.tipo==='LONG'?'var(--green)':'var(--red)'};margin-left:6px">${lastAlert.tipo}</span>
          <span style="font-size:11px;color:var(--muted);margin-left:8px">${lastAlert.timestamp||''}</span>
        </div>
        <span style="font-size:11px;color:var(--accent)">${lastAlert.confianza||0}% conf.</span>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">${lastAlert.razon||''}</div>
    </div>` : ''}

    <!-- Accesos directos -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <button class="btn" style="justify-content:center;padding:10px;font-size:12px" onclick="setTab('mkt')">🌐 Ver mercado</button>
      <button class="btn" style="justify-content:center;padding:10px;font-size:12px" onclick="setTab('historial')">📈 Historial</button>
      <button class="btn" style="justify-content:center;padding:10px;font-size:12px" onclick="setTab('alerts')">🔔 Alertas IA</button>
      <button class="btn" style="justify-content:center;padding:10px;font-size:12px" onclick="setTab('strat')">🧠 Estrategia</button>
    </div>`;
}


function renderOps() {
  const root = qs('#sec-ops');
  if (!root) return;

  // Preservar gráficos abiertos antes de re-renderizar
  const openCharts = {};
  Object.keys(_tradeChartInstances).forEach(id => {
    const panel = qs(`#chart-panel-${id}`);
    if (panel && panel.style.display !== 'none') {
      openCharts[id] = _tradeChartTimeframes[id] || '4h';
    }
    // Limpiar instancias antiguas
    try { _tradeChartInstances[id].remove(); } catch {}
    delete _tradeChartInstances[id];
  });

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
              <span class="lv lv-e" title="${o.entradaBitunix && o.entradaApp && Math.abs(o.entradaBitunix - o.entradaApp) > 0.00001 ? `App: ${fmtP(o.entradaApp, coin)} → Bitunix real: ${fmtP(o.entradaBitunix, coin)}` : 'Precio de entrada'}">
                E: ${fmtP(o.entrada, coin)}${o.entradaBitunix && o.entradaApp && Math.abs(o.entradaBitunix - o.entradaApp) > 0.00001 ? ` <span style="font-size:9px;color:var(--yellow)" title="El exchange ejecutó a un precio ligeramente diferente al que mostraba la app">⚡</span>` : ''}
              </span>
              <span class="lv lv-s op-sl">SL: ${fmtP(o.stopLoss, coin)}${o.breakevenSet ? ' 🔒' : ''}</span>
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
          <button class="btn" id="chart-btn-${o.id}" style="font-size:10px;padding:6px 10px" onclick="toggleTradeChart('${o.id}')">📊 Gráfico</button>
          <button class="btn btnr" style="font-size:10px;padding:6px 10px" onclick="cancelTrade('${o.id}');renderOps()">✕ Cancelar</button>
        </div>
        <div id="notes-panel-${o.id}" style="display:none;padding:10px 15px;border-top:1px solid var(--border);background:var(--s2)">
          <textarea class="inp" id="notes-input-${o.id}" rows="2"
            placeholder="Añade notas a esta operación..."
            style="margin-bottom:7px;font-size:12px">${o.notes || ''}</textarea>
          <button class="btn btng" style="font-size:10px;padding:5px 12px" onclick="saveTradeNotes('${o.id}')">✓ Guardar nota</button>
        </div>
        <div id="chart-panel-${o.id}" style="display:none;border-top:1px solid var(--border);background:var(--surface);overflow:hidden;border-radius:0 0 var(--radius) var(--radius)">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 14px;background:var(--s2);border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:11px;font-weight:600;color:var(--text);font-family:var(--display)">${o.par}</span>
              <span style="font-size:9px;color:var(--muted)">Entrada <b style="color:var(--accent);font-family:var(--mono)">${fmtP(o.entrada, coinOf(o.par))}</b> · SL <b style="color:var(--red);font-family:var(--mono)">${fmtP(o.stopLoss, coinOf(o.par))}</b> · TP1 <b style="color:var(--green);font-family:var(--mono)">${fmtP(o.tp1, coinOf(o.par))}</b></span>
            </div>
            <div style="display:flex;gap:4px">
              ${['1h','4h','1d'].map(tf => `<button id="chart-tf-${o.id}-${tf}" onclick="reloadTradeChart('${o.id}','${tf}')" style="font-size:9px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:${tf==='4h'?'var(--accent)':'var(--s2)'};cursor:pointer;color:${tf==='4h'?'#fff':'var(--muted)'};transition:all .15s">${tf.toUpperCase()}</button>`).join('')}
            </div>
          </div>
          <div id="chart-canvas-${o.id}" style="height:280px;width:100%;position:relative"></div>
          <div style="padding:5px 14px;background:var(--s2);border-top:1px solid var(--border);display:flex;gap:12px;font-size:9px;color:var(--muted)">
            <span style="display:flex;align-items:center;gap:3px"><span style="width:14px;height:2px;background:var(--accent);display:inline-block;border-radius:1px"></span>Entrada</span>
            <span style="display:flex;align-items:center;gap:3px"><span style="width:14px;height:2px;background:var(--red);display:inline-block;border-radius:1px;opacity:.8"></span>Stop Loss</span>
            <span style="display:flex;align-items:center;gap:3px"><span style="width:14px;height:2px;background:var(--green);display:inline-block;border-radius:1px"></span>Take Profit</span>
            <span style="margin-left:auto;color:var(--muted)">Datos: Binance · TZ UTC</span>
          </div>
        </div>
      </div>`;
  });

  root.innerHTML = html;

  // Reabrir gráficos que estaban abiertos antes del re-render
  if (Object.keys(openCharts).length) {
    requestAnimationFrame(() => {
      Object.entries(openCharts).forEach(([id, tf]) => {
        const panel = qs(`#chart-panel-${id}`);
        const btn   = qs(`#chart-btn-${id}`);
        if (!panel) return;
        panel.style.display = 'block';
        if (btn) { btn.style.background = 'var(--accent)'; btn.style.color = '#fff'; }
        loadTradeChart(id, tf || '4h');
      });
    });
  }
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
