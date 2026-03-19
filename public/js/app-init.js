/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — app-init.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   DASHBOARD DE INICIO
   ═══════════════════════════════════════════════════════════════════ */
function renderDash() {
  const root = qs('#sec-dash');
  if (!root) return;

  const { closedTrades, activeTrades, prices, profile, scannerOn, alerts } = state;
  const now  = Date.now();
  const day  = 86_400_000;
  const week = 7 * day;

  // ── Métricas generales
  const totalPnl   = closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const totalWins  = closedTrades.filter(t => t.result === 'WIN').length;
  const winRate    = closedTrades.length > 0 ? ((totalWins / closedTrades.length) * 100).toFixed(0) : '—';

  // ── Hoy
  const todayTrades = closedTrades.filter(t => (now - new Date(t.closedAt || 0).getTime()) < day);
  const todayPnl    = todayTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const todayWins   = todayTrades.filter(t => t.result === 'WIN').length;

  // ── Esta semana
  const weekTrades  = closedTrades.filter(t => (now - new Date(t.closedAt || 0).getTime()) < week);
  const weekPnl     = weekTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const weekWins    = weekTrades.filter(t => t.result === 'WIN').length;
  const weekWR      = weekTrades.length > 0 ? ((weekWins / weekTrades.length) * 100).toFixed(0) : '—';

  // ── P&L latente (trades abiertos)
  const latentPnl = activeTrades.reduce((sum, t) => {
    const price = prices[t.par?.split('/')[0]];
    if (!price) return sum;
    return sum + (t.tipo === 'LONG' ? price - t.entrada : t.entrada - price) * (t.size || 0) * (t.leverage || 1);
  }, 0);

  // ── Objetivo activo (primer goal pendiente)
  const activeGoal = (state.goals || []).find(g => !g.completed);
  const goalProgress = activeGoal ? Math.min((totalPnl / activeGoal.target) * 100, 100).toFixed(0) : null;

  // ── Últimas 5 ops
  const recentTrades = closedTrades.slice(0, 5);

  // ── Precios top 4
  const topCoins = state.watchedCoins.slice(0, 4);

  const pnlColor  = v => v >= 0 ? 'var(--green)' : 'var(--red)';
  const fmtPnl    = v => (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2);
  // Scanner badge con health check
  const scanLastMs   = state.lastScan ? (Date.now() - new Date(state.lastScan).getTime()) : null;
  const scanStalled  = scanLastMs && scannerOn && scanLastMs > (state.scanInterval || 15) * 60_000 * 2.5;
  const scanLastStr  = scanLastMs
    ? (scanLastMs < 60_000 ? 'hace <1min' : scanLastMs < 3_600_000 ? `hace ${Math.floor(scanLastMs/60_000)}min` : `hace ${Math.floor(scanLastMs/3_600_000)}h`)
    : null;
  const scanDot = scannerOn
    ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${scanStalled?'var(--yellow)':'var(--green)'};margin-right:4px;box-shadow:0 0 6px ${scanStalled?'var(--yellow)':'var(--green)'}"></span>`
    : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--muted);margin-right:4px"></span>';
  const scanBadge = scanDot + (scannerOn
    ? (scanStalled ? `⚠️ POSIBLE FALLO${scanLastStr?' ('+scanLastStr+')':''}` : `ACTIVO${scanLastStr?' · '+scanLastStr:''}`)
    : 'INACTIVO');

  root.innerHTML = `
    <div style="padding:0 0 24px">

      <!-- Banner Circuit Breaker -->
      ${checkCircuitBreaker() ? `
      <div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4);border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
        <span style="font-size:20px">🛑</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--red)">Circuit Breaker activo</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">
            Has superado el límite de pérdida diaria de <b style="color:var(--red)">$${Math.abs(profile.daily_loss_limit||0).toFixed(2)}</b>.
            No puedes abrir nuevas operaciones hoy.
          </div>
        </div>
        <button onclick="setTab('config')" style="font-size:11px;padding:6px 12px;border-radius:8px;border:1px solid rgba(239,68,68,.4);background:transparent;color:var(--red);cursor:pointer;white-space:nowrap">
          ⚙️ Ajustar límite
        </button>
      </div>` : ''}

      <!-- Saludo -->
      <div style="margin-bottom:18px">
        <div style="font-family:var(--serif);font-size:20px;font-weight:700;color:var(--text)">
          ${getGreeting()} 👋
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">
          ${new Date().toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' })}
          &nbsp;·&nbsp; Escáner: ${scanBadge}
          &nbsp;·&nbsp; ${activeTrades.length} trade${activeTrades.length !== 1 ? 's' : ''} abierto${activeTrades.length !== 1 ? 's' : ''}
          &nbsp;·&nbsp; <span style="font-weight:600;color:${bitunix.configured?'var(--green)':'var(--yellow)'}" title="${bitunix.configured?'Órdenes reales en Bitunix':'Modo simulación — no se ejecutan órdenes reales'}">${bitunix.configured?'🔗 Real':'📋 Paper'}</span>
        </div>
      </div>

      <!-- KPIs principales -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px">
        ${dashKpi('P&L Total', fmtPnl(totalPnl), pnlColor(totalPnl), '📊', closedTrades.length + ' trades')}
        ${dashKpi('Win Rate', winRate + '%', winRate >= 50 ? 'var(--green)' : 'var(--red)', '🎯', totalWins + 'W / ' + (closedTrades.length - totalWins) + 'L')}
        ${dashKpi('P&L Hoy', fmtPnl(todayPnl), pnlColor(todayPnl), '📅', todayTrades.length + ' ops · ' + todayWins + 'W')}
        ${dashKpi('P&L Semana', fmtPnl(weekPnl), pnlColor(weekPnl), '📆', 'WR ' + weekWR + '% · ' + weekTrades.length + ' ops')}
        ${dashKpi('P&L Latente', fmtPnl(latentPnl), pnlColor(latentPnl), '⏳', activeTrades.length + ' posiciones abiertas')}
        ${dashKpi('Capital', '$' + (profile.capital || 0).toFixed(2), 'var(--accent)', '💰', 'Riesgo/op ' + profile.risk_pct + '% · ' + (profile.leverage || 1) + 'x')}
      </div>

      <!-- Objetivo activo -->
      ${activeGoal ? `
      <div class="card" style="margin-bottom:12px;cursor:pointer" onclick="setTab('goals')">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-size:12px;font-weight:600;color:var(--text)">🎯 Objetivo activo: ${activeGoal.name}</div>
          <div style="font-size:12px;font-weight:700;color:var(--accent)">${goalProgress}%</div>
        </div>
        <div style="height:6px;background:var(--s2);border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${goalProgress}%;background:var(--accent);border-radius:3px;transition:width .5s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:5px">
          <span>Actual: ${fmtPnl(totalPnl)}</span>
          <span>Meta: +$${activeGoal.target}</span>
        </div>
      </div>` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">

        <!-- Precios rápidos -->
        <div class="card">
          <div class="stl" style="margin-bottom:10px">💰 Precios</div>
          ${topCoins.map(coin => {
            const p    = prices[coin];
            const meta = MARKET_META[coin] || {};
            const chg  = meta.change24h;
            const fmt  = p ? (p >= 1000 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(6)) : '…';
            const chgStr = chg != null
              ? `<span style="font-size:10px;color:${chg>=0?'var(--green)':'var(--red)'}">${chg>=0?'▲ +':'▼ '}${Math.abs(chg).toFixed(2)}%</span>`
              : '';
            return `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
                <span style="font-size:12px;font-weight:600;color:var(--text)">${coin}</span>
                <div style="text-align:right">
                  <div style="font-size:12px;font-family:var(--serif);font-weight:600">$${fmt}</div>
                  ${chgStr}
                </div>
              </div>`;
          }).join('')}
          <button class="btn" style="width:100%;justify-content:center;font-size:10px;margin-top:10px;padding:5px" onclick="setTab('mkt')">
            Ver mercado completo →
          </button>
        </div>

        <!-- Últimos trades -->
        <div class="card">
          <div class="stl" style="margin-bottom:10px">🕒 Últimas operaciones</div>
          ${recentTrades.length === 0
            ? '<div style="font-size:11px;color:var(--muted);text-align:center;padding:20px 0">Sin operaciones cerradas</div>'
            : recentTrades.map(t => {
                const emoji = t.result === 'WIN' ? '✅' : '❌';
                const pnl   = t.pnl != null ? (t.pnl >= 0 ? '+$' + t.pnl.toFixed(2) : '-$' + Math.abs(t.pnl).toFixed(2)) : '?';
                return `
                  <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
                    <div>
                      <span style="font-size:11px;font-weight:600;color:var(--text)">${emoji} ${t.par}</span>
                      <span style="font-size:10px;color:var(--muted);margin-left:4px">${t.tipo}</span>
                    </div>
                    <span style="font-size:11px;font-weight:700;color:${t.pnl>=0?'var(--green)':'var(--red)'}">${pnl}</span>
                  </div>`;
              }).join('')
          }
          <button class="btn" style="width:100%;justify-content:center;font-size:10px;margin-top:10px;padding:5px" onclick="setTab('historial')">
            Ver historial completo →
          </button>
        </div>
      </div>

      <!-- Accesos rápidos -->
      <div class="card">
        <div class="stl" style="margin-bottom:10px">⚡ Accesos rápidos</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="btn btng" onclick="onGenerate()" style="font-size:11px;padding:7px 14px">⚡ Analizar ahora</button>
          <button class="btn" onclick="setTab('ops')" style="font-size:11px;padding:7px 14px">📊 Operaciones</button>
          <button class="btn" onclick="setTab('alerts')" style="font-size:11px;padding:7px 14px">🔔 Alertas</button>
          <button class="btn" onclick="setTab('mkt')" style="font-size:11px;padding:7px 14px">🌐 Mercado</button>
          <button class="btn" onclick="showEquityCurve()" style="font-size:11px;padding:7px 14px">📈 Equity Curve</button>
          <button class="btn" onclick="setTab('goals')" style="font-size:11px;padding:7px 14px">🎯 Objetivos</button>
        </div>
      </div>

    </div>`;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 6)  return 'Buenas noches';
  if (h < 12) return 'Buenos días';
  if (h < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

function dashKpi(label, value, color, icon, sub) {
  return `
    <div class="card" style="padding:12px 14px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">${icon} ${label}</div>
      <div style="font-family:var(--serif);font-size:18px;font-weight:700;color:${color};line-height:1.2">${value}</div>
      ${sub ? `<div style="font-size:10px;color:var(--muted);margin-top:3px">${sub}</div>` : ''}
    </div>`;
}


function setTab(id) {
  // Redirigir tabs antiguos a los nuevos fusionados
  if (id === 'perf') id = 'historial';
  if (id === 'profile' || id === 'capital') id = 'config';
  if (id === 'dashboard') id = 'dash';

  state.currentTab = id;
  qsa('.nb').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  qsa('.sec').forEach(s => s.classList.toggle('on', s.id === 'sec-' + id));

  const renders = {
    dash:     renderDash,
    diary:    renderDiary,
    ops:      renderOps,
    alerts:   renderAlerts,
    historial:renderHistorial,
    backtest: renderBacktester,
    mkt:      renderMkt,
    strat:    renderStrategy,
    config:   renderConfig,
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
      ? (exitPrice - trade.entrada) * trade.size
      : (trade.entrada - exitPrice) * trade.size;
    const pct  = trade.tipo === 'LONG'
      ? ((exitPrice - trade.entrada) / trade.entrada) * 100 * lev
      : ((trade.entrada - exitPrice) / trade.entrada) * 100 * lev;
    // Comisiones sobre nocional real (precio × size), sin × leverage
    const feesOpen  = trade.entrada * trade.size * 0.0006;
    const feesClose = exitPrice * trade.size * 0.0006;
    const totalFees = feesOpen + feesClose;
    const netPnl    = pnl - totalFees;
    const color     = netPnl >= 0 ? 'var(--green)' : 'var(--red)';
    const grossColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    qs('#cpm-preview').innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:5px">
        <span style="color:var(--muted)">P&L bruto</span>
        <span style="font-family:var(--serif);font-weight:600;color:${grossColor}">${fmtUSD(pnl)} <span style="font-size:10px">(${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span></span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px">
        <span style="color:var(--muted)">Comisiones taker (×2)</span>
        <span style="color:var(--red)">-${fmtUSD(totalFees)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:6px">
        <span style="font-weight:600;color:var(--text)">P&L neto</span>
        <span style="font-family:var(--serif);font-size:16px;font-weight:700;color:${color}">${fmtUSD(netPnl)}</span>
      </div>`;
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
    ? (exitPrice - trade.entrada) * trade.size
    : (trade.entrada - exitPrice) * trade.size;
  const feesOpen  = trade.entrada * trade.size * 0.0006;
  const feesClose = exitPrice * trade.size * 0.0006;
  const totalFees = feesOpen + feesClose;
  const netPnl    = rawPnl - totalFees;
  const result    = netPnl >= 0 ? 'WIN' : 'LOSS';

  const idx = state.activeTrades.findIndex(t => t.id === tradeId);
  if (idx === -1) return;
  const closed = { ...trade, result, pnl: netPnl, pnlGross: rawPnl, fees: totalFees, exitPrice, notes, closedAt: nowFull() };
  state.closedTrades.unshift(closed);
  state.activeTrades.splice(idx, 1);
  saveKey('activeTrades', state.activeTrades);
  saveKey('closedTrades', state.closedTrades);
  syncTradesToServer();

  qs('#close-price-modal')?.remove();
  logActivity('trade_close', `${result === 'WIN' ? '✅' : '❌'} ${trade.par} ${trade.tipo} cerrada @ ${exitPrice} · Neto: ${fmtUSD(netPnl)}`);
  showToast(`${trade.par} cerrada — Neto: ${fmtUSD(netPnl)} (bruto ${fmtUSD(rawPnl)}, fees -${fmtUSD(totalFees)})`, result === 'LOSS');
  renderAll();

  // Guardar en Supabase (incluye notes, exitPrice, fees, pnlGross)
  authFetch('/api/trades/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trade: closed }),
  }).then(r => r.json()).then(d => {
    if (!d.ok) console.warn('[confirmClose] Supabase error:', d.error);
  }).catch(e => console.warn('[confirmClose] Error guardando en servidor:', e.message));

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

    const coin = coinOf(trade.par);
    const lc   = trade.tipo === 'LONG' ? 'var(--green)' : 'var(--red)';

    // ── MEJORA: precio actualizado en tiempo real al abrir el modal ──────────
    // Si el precio se ha movido >0.2% desde la propuesta, advertir y
    // recalcular el R:R para que el trader sepa exactamente a qué entra.
    const livePrice     = state.prices[coin] || trade.entrada;
    const priceDrift    = Math.abs(livePrice - trade.entrada) / trade.entrada * 100;
    const hasDrift      = priceDrift > 0.2;
    const driftDir      = livePrice > trade.entrada ? '▲' : '▼';
    const driftColor    = hasDrift ? 'var(--yellow)' : 'var(--green)';

    // Recalcular R:R con el precio actual
    const slDistLive    = Math.abs(livePrice - trade.stopLoss);
    const tp1DistLive   = Math.abs(trade.tp1 - livePrice);
    const rrLive        = slDistLive > 0 ? (tp1DistLive / slDistLive).toFixed(2) : trade.rr;
    const rrOk          = parseFloat(rrLive) >= 2.0;

    // Usar el precio live para los cálculos financieros del modal
    const tradeWithLive = { ...trade, entrada: livePrice };
    const money         = calcProposalMoney(tradeWithLive);
    const tpLabel       = trade.tp2
      ? `TP1 🎯 ${fmtP(trade.tp1, coin)} → TP2 ${fmtP(trade.tp2, coin)}`
      : `TP1 🎯 ${fmtP(trade.tp1, coin)}`;

    // ── MEJORA: bloqueo de correlaciones (no solo warning) ──────────────────
    // Si ya hay 3+ posiciones correlacionadas del mismo lado → bloquear.
    const CORR_COINS  = ['BTC','ETH','SOL','BNB','AVAX','LINK'];
    const corrTrades  = state.activeTrades.filter(t =>
      t.tipo === trade.tipo && CORR_COINS.includes(coinOf(t.par))
    );
    const corrBlocked = corrTrades.length >= 3;
    const corrWarning = corrTrades.length >= 1 && !corrBlocked;
    const corrRisk    = corrTrades.reduce((a, t) => a + (t.riskUSD || 0), 0);

    const div = document.createElement('div');
    div.id = 'trade-confirm-modal';
    div.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.78);backdrop-filter:blur(4px);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .15s ease">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:420px;box-shadow:var(--shadow-lg);overflow:hidden;max-height:90vh;overflow-y:auto">

          <!-- Header -->
          <div style="padding:16px 20px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
            <div style="width:34px;height:34px;border-radius:8px;background:rgba(255,200,0,.1);border:1px solid rgba(255,200,0,.3);display:flex;align-items:center;justify-content:center;font-size:16px">⚠️</div>
            <div>
              <div style="font-weight:700;font-size:14px;color:var(--text)">Confirmar orden en Bitunix</div>
              <div style="font-size:10px;color:var(--muted)">Esta acción enviará una orden real a tu cuenta</div>
            </div>
          </div>

          <div style="padding:16px 20px">

            <!-- Par + tipo -->
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <span style="font-family:var(--display);font-size:18px;font-weight:800;color:#fff">${trade.par}</span>
              <span style="font-size:11px;padding:3px 9px;border-radius:4px;border:1px solid ${lc}50;color:${lc};font-weight:600">${trade.tipo}</span>
              ${trade.leverage > 1 ? `<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:var(--yellow)">${trade.leverage}x</span>` : ''}
              ${!rrOk ? `<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:rgba(255,68,85,.1);border:1px solid rgba(255,68,85,.3);color:var(--red)">R:R ${rrLive} ⚠️</span>` : `<span style="font-size:10px;color:var(--green)">R:R ${rrLive} ✓</span>`}
            </div>

            <!-- MEJORA: Precio en tiempo real con alerta de deslizamiento -->
            <div style="padding:10px 14px;border-radius:8px;border:1px solid ${hasDrift ? 'rgba(245,197,66,.4)' : 'var(--border)'};background:${hasDrift ? 'rgba(245,197,66,.06)' : 'var(--s2)'};margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                  <div style="font-size:9px;color:var(--muted);margin-bottom:2px">PRECIO PROPUESTO</div>
                  <div style="font-size:12px;font-weight:600;color:var(--muted);text-decoration:line-through">${fmtP(trade.entrada, coin)}</div>
                </div>
                <div style="text-align:right">
                  <div style="font-size:9px;color:var(--muted);margin-bottom:2px">PRECIO ACTUAL (LIVE)</div>
                  <div style="font-size:14px;font-weight:700;color:${driftColor}">${driftDir} ${fmtP(livePrice, coin)}</div>
                </div>
              </div>
              ${hasDrift ? `<div style="font-size:10px;color:var(--yellow);margin-top:6px">⚠️ Deslizamiento de ${priceDrift.toFixed(2)}% desde la propuesta. R:R recalculado: ${rrLive}${!rrOk ? ' — por debajo del mínimo de 2.0' : ''}</div>` : `<div style="font-size:10px;color:var(--green);margin-top:4px">✓ Precio estable — sin deslizamiento significativo</div>`}
            </div>

            <!-- Niveles -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
              <div style="padding:8px 12px;background:var(--s2);border-radius:8px;border-left:3px solid var(--red)">
                <div style="font-size:9px;color:var(--muted);margin-bottom:2px">STOP LOSS</div>
                <div style="font-size:13px;font-weight:700;color:var(--red)">${fmtP(trade.stopLoss, coin)}</div>
              </div>
              <div style="padding:8px 12px;background:var(--s2);border-radius:8px;border-left:3px solid var(--green)">
                <div style="font-size:9px;color:var(--muted);margin-bottom:2px">SL DIST</div>
                <div style="font-size:13px;font-weight:700;color:var(--text)">${fmtP(slDistLive, coin)}</div>
              </div>
              <div style="padding:8px 12px;background:var(--s2);border-radius:8px;border-left:3px solid var(--green);grid-column:span 2">
                <div style="font-size:9px;color:var(--muted);margin-bottom:2px">TAKE PROFIT</div>
                <div style="font-size:13px;font-weight:700;color:var(--green)">${tpLabel}</div>
              </div>
            </div>

            <!-- Resumen financiero -->
            <div style="padding:10px 14px;background:rgba(0,0,0,.25);border-radius:8px;border:1px solid var(--border);margin-bottom:12px">
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

            <!-- MEJORA: Advertencia/bloqueo de correlaciones -->
            ${corrBlocked ? `
            <div style="padding:10px 14px;border-radius:8px;border:1px solid rgba(255,68,85,.4);background:rgba(255,68,85,.08);margin-bottom:12px">
              <div style="font-size:12px;font-weight:700;color:var(--red);margin-bottom:4px">🛑 Límite de correlación alcanzado</div>
              <div style="font-size:11px;color:var(--text);line-height:1.5">
                Ya tienes ${corrTrades.length} posiciones ${trade.tipo} en activos correlacionados
                (${corrTrades.map(t=>coinOf(t.par)).join(', ')}) con un riesgo acumulado de $${corrRisk.toFixed(2)}.
                Máximo 3 posiciones correlacionadas simultáneas. Cierra alguna antes de abrir esta.
              </div>
            </div>` : corrWarning ? `
            <div style="padding:10px 14px;border-radius:8px;border:1px solid rgba(245,197,66,.3);background:rgba(245,197,66,.06);margin-bottom:12px">
              <div style="font-size:11px;font-weight:600;color:var(--yellow);margin-bottom:3px">⚠️ ${corrTrades.length} posición(es) correlacionada(s) activa(s)</div>
              <div style="font-size:10px;color:var(--muted)">${corrTrades.map(t=>coinOf(t.par)).join(', ')} — Riesgo acumulado: $${corrRisk.toFixed(2)}</div>
            </div>` : ''}

            ${money.warnings.filter(w => !w.includes('Posición')).length ? `
            <div style="margin-bottom:12px">${money.warnings.filter(w=>!w.includes('Posición')).map(w=>`<div style="font-size:11px;color:var(--red);padding:2px 0">${w}</div>`).join('')}</div>` : ''}

            <!-- Aviso legal -->
            <div style="font-size:10px;color:var(--muted);padding:8px 12px;background:rgba(255,200,0,.05);border:1px solid rgba(255,200,0,.15);border-radius:6px;margin-bottom:14px;line-height:1.5">
              ⚠️ Esta orden se ejecutará <b style="color:var(--yellow)">al precio de mercado actual</b>.
              El deslizamiento final puede diferir ligeramente.
            </div>

            <!-- Botones -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <button id="confirm-cancel-btn" class="btn" style="padding:10px;font-size:12px;font-weight:600">✕ Cancelar</button>
              <button id="confirm-execute-btn" class="btn btng" style="padding:10px;font-size:12px;font-weight:600"
                ${corrBlocked ? 'disabled style="opacity:.4;cursor:not-allowed"' : ''}>
                📡 Ejecutar ahora
              </button>
            </div>
          </div>
        </div>
      </div>`;

    document.body.appendChild(div);

    // Actualizar precio en tiempo real mientras el modal está abierto
    let priceInterval = setInterval(() => {
      const newPrice    = state.prices[coin];
      if (!newPrice) return;
      const newDrift    = Math.abs(newPrice - trade.entrada) / trade.entrada * 100;
      const liveEl      = div.querySelector('#modal-live-price');
      if (liveEl) liveEl.textContent = (newPrice > trade.entrada ? '▲ ' : '▼ ') + fmtP(newPrice, coin);
    }, 2000);

    const close = (result) => {
      clearInterval(priceInterval);
      div.remove();
      resolve(result);
    };

    document.getElementById('confirm-cancel-btn').onclick  = () => close(false);
    if (!corrBlocked) {
      document.getElementById('confirm-execute-btn').onclick = () => close(true);
    }
    div.querySelector('div[style*="inset:0"]').addEventListener('click', e => {
      if (e.target === e.currentTarget) close(false);
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', onKey); }
    });
  });
}

function checkCircuitBreaker() {
  const limit = parseFloat(state.profile.daily_loss_limit) || 0;
  if (!limit) return false;
  const now        = Date.now();
  const todayLoss  = state.closedTrades
    .filter(t => (now - new Date(t.closedAt || 0).getTime()) < 86_400_000)
    .reduce((a, t) => a + (t.pnl || 0), 0);
  if (todayLoss <= -Math.abs(limit)) {
    state.circuitBreakerTripped = true;
    return true;
  }
  state.circuitBreakerTripped = false;
  return false;
}

async function onAcceptProposal(i) {
  const p = state.pending[i];
  if (!p) return;

  // Read-only mode block
  if (state.readOnlyMode) {
    showToast('👁️ Modo solo lectura activo — desactívalo para operar.', true);
    return;
  }

  // Circuit Breaker
  if (checkCircuitBreaker()) {
    const limit = Math.abs(parseFloat(state.profile.daily_loss_limit) || 0);
    showToast(`🛑 Circuit Breaker activo — pérdida diaria superó $${limit.toFixed(2)}. No puedes abrir nuevas operaciones hoy.`, true);
    return;
  }

  const execError = checkTradeExecutability(p);
  if (execError) { showToast(execError, true); return; }

  // Correlación: advertir si ya hay trades en activos correlacionados del mismo lado
  const corrWarning = checkCorrelation(p.tipo);
  if (corrWarning && corrWarning.count >= 1) {
    const proceed = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px';
      overlay.innerHTML = `
        <div style="background:var(--card);border-radius:14px;padding:24px;max-width:400px;width:100%;border:1px solid var(--yellow)">
          <div style="font-size:14px;font-weight:700;color:var(--yellow);margin-bottom:12px">⚠️ Advertencia de Correlación</div>
          <div style="font-size:12px;color:var(--text);line-height:1.6;margin-bottom:16px">${corrWarning.warning}<br><br>
          Los activos crypto están altamente correlacionados. Una caída del mercado afectará a todos al mismo tiempo.</div>
          <div style="display:flex;gap:10px">
            <button onclick="this.closest('[style]').remove();window._corrResolve(false)" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--border);background:var(--s2);color:var(--muted);cursor:pointer;font-size:12px">Cancelar</button>
            <button onclick="this.closest('[style]').remove();window._corrResolve(true)" style="flex:1;padding:9px;border-radius:8px;border:none;background:var(--yellow);color:#000;cursor:pointer;font-weight:600;font-size:12px">Continuar de todas formas</button>
          </div>
        </div>`;
      window._corrResolve = resolve;
      document.body.appendChild(overlay);
    });
    if (!proceed) return;
  }

  const trade = buildTrade(p);

  if (bitunix.configured) {
    const confirmed = await showTradeConfirmModal(trade);
    if (!confirmed) return;

    const result = await placeBitunixOrder(trade);
    if (!result || !result.ok) {
      showToast(`❌ Trade no registrado: Bitunix rechazó la orden.`, true);
      return;
    }
  } else {
    // Paper trading: mostrar confirmación con el precio actual
    const coin    = coinOf(trade.par);
    const current = state.prices[coin];
    const dist    = current ? Math.abs((current - trade.entrada) / trade.entrada * 100).toFixed(2) : null;
    const distTxt = dist ? `<div style="font-size:11px;color:var(--yellow);margin-top:4px">⚠️ Precio actual: ${fmtP(current, coin)} (${dist}% de diferencia con entrada propuesta)</div>` : '';
    const ok = await new Promise(resolve => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .15s ease';
      ov.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:380px;width:100%;box-shadow:var(--shadow-lg)">
          <div style="font-size:14px;font-weight:700;margin-bottom:14px">📋 Confirmar operación (Paper)</div>
          <div style="display:grid;gap:8px;margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--muted)">Par</span><b>${trade.par} ${trade.tipo}</b></div>
            <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--muted)">Entrada propuesta</span><b style="color:var(--accent)">${fmtP(trade.entrada, coin)}</b></div>
            ${distTxt}
            <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--muted)">Stop Loss</span><b style="color:var(--red)">${fmtP(trade.stopLoss, coin)}</b></div>
            <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--muted)">Take Profit</span><b style="color:var(--green)">${fmtP(trade.tp1, coin)}</b></div>
            <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--muted)">Riesgo</span><b style="color:var(--red)">-$${(trade.riskUSD||0).toFixed(2)}</b></div>
            <div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--muted)">R:R</span><b>${trade.rr}</b></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <button onclick="this.closest('[style]').remove();window._paperResolve(false)" style="padding:9px;border-radius:8px;border:1px solid var(--border);background:var(--s2);color:var(--muted);cursor:pointer;font-size:12px">Cancelar</button>
            <button onclick="this.closest('[style]').remove();window._paperResolve(true)" style="padding:9px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-weight:600;font-size:12px">✓ Confirmar</button>
          </div>
        </div>`;
      window._paperResolve = resolve;
      document.body.appendChild(ov);
    });
    if (!ok) return;
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

/* ── Onboarding (stub — marca como completado la primera vez) ─────── */
function showOnboarding() { state.onboarded = true; saveKey('onboarded', true); }
function onboardNext()    { state.onboarded = true; saveKey('onboarded', true); }
function onboardBack()    {}
function setObRisk(v)     { state.profile.risk_pct = v; saveKey('profile', state.profile); syncProfileToServer(); }


/* ── Header buttons ──────────────────────────────────────────────────────── */
async function onGenerate() {
  if (checkCircuitBreaker()) {
    const limit = Math.abs(parseFloat(state.profile.daily_loss_limit) || 0);
    showToast(`🛑 Circuit Breaker: límite diario de $${limit.toFixed(2)} alcanzado. Sin nuevas operaciones hoy.`, true);
    return;
  }
  const btn = qs('#btn-gen');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ANALIZANDO...'; }
  state.aiMsg = null;
  try {
    const data = await aiGenerateProposals();

    // Filtro cliente: descartar propuestas de monedas no ejecutables con Bitunix
    let proposals = data.proposals || [];
    if (bitunix.configured) {
      const { feasible } = buildFeasibleCoins();
      const feasibleCoins = new Set(feasible.map(f => f.coin));
      const antes = proposals.length;
      proposals = proposals.filter(p => {
        const coin = (p.par || '').split('/')[0];
        return feasibleCoins.size === 0 || feasibleCoins.has(coin);
      });
      const filtradas = antes - proposals.length;
      if (filtradas > 0) {
        showToast(`⚠️ ${filtradas} propuesta(s) eliminadas — capital insuficiente para el mínimo de Bitunix`, true);
      }
    }

    state.pending = proposals;
    state.aiMsg   = { market: data.analisis_mercado, rec: data.recomendacion_ia };
    setTab('ops');
    showToast(`✓ IA generó ${proposals.length} propuesta(s) ejecutables con tu capital.`);
  } catch (e) {
    showToast('Error IA: ' + e.message, true);
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '<span>⚡</span> ANALIZAR AHORA'; }
}

async function onAdaptStrategy() {
  if (state.closedTrades.length < 3) { showToast('Necesitas al menos 3 ops cerradas', true); return; }
  // Buscar el botón dentro del panel de estrategia
  const btn = qs('#sec-strat button');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analizando...'; }
  try {
    state.strategy = await aiAdaptStrategy();
    saveKey('strategy', state.strategy);
    renderStrategy(); // re-render en el mismo panel
    showToast('🧠 Estrategia adaptada con tu historial real.');
  } catch (e) {
    showToast('Error IA: ' + e.message, true);
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '🧠 Adaptar estrategia'; }
}

/* ── Full render ─────────────────────────────────────────────────────────── */
/* ── Wrapper: Historial (Rendimiento + Backtesting fusionados) ───────────── */
function histPageNav(dir) {
  const total = Math.max(1, Math.ceil(state.closedTrades.length / 50));
  state.histPage = Math.max(0, Math.min(total - 1, state.histPage + dir));
  renderHistorial();
}


function renderHistorial() {
  const root = qs('#sec-historial');
  if (!root) return;
  // Inyectar sub-divs con IDs originales — renderPerf y renderBacktest los encontrarán
  root.innerHTML = `
    <div id="sec-perf"     style="display:block"></div>
    <div id="sec-backtest" style="display:block;margin-top:8px"></div>
    ${state.bitunix?.configured !== false ? '<div id="sec-bitunix-history" style="display:block;margin-top:8px"></div>' : ''}`;
  renderPerf();
  renderBacktest();
  if (state.bitunix?.configured !== false) renderBitunixHistory();
}

/* ── Wrapper: Configuración (Perfil + Capital fusionados) ───────────────── */
function renderConfig() {
  const root = qs('#sec-config');
  if (!root) return;

  const tabs = [
    { id: 'perfil',    label: '👤 Perfil' },
    { id: 'capital',   label: '💰 Capital' },
    { id: 'sizing',    label: '📐 Sizing' },
    { id: 'bitunix',   label: '🔗 Bitunix' },
    { id: 'avanzado',  label: '⚙️ Avanzado' },
  ];
  const active = state.configTab || 'perfil';

  const tabBar = tabs.map(t => `
    <button onclick="setConfigTab('${t.id}')"
      style="padding:7px 14px;font-size:11px;border-radius:8px;border:1px solid ${active===t.id?'var(--accent)':'var(--border)'};
             background:${active===t.id?'var(--accent)':'var(--s2)'};color:${active===t.id?'#fff':'var(--muted)'};
             cursor:pointer;white-space:nowrap;transition:all .15s">
      ${t.label}
    </button>`).join('');

  root.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid var(--border)">
      ${tabBar}
    </div>
    <div id="config-tab-content"></div>`;

  renderConfigTabContent(active);
}

/* ══════════════════════════════════════════════════════════════════
   CONFIG TAB: SIZING (Calculadora de Position Sizing)
   ══════════════════════════════════════════════════════════════════ */
function renderSizingCalc(root) {
  const p = state.profile;
  root.innerHTML = `
    <div class="stl">📐 Calculadora de Position Sizing</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:16px">
      Calcula el tamaño exacto de cada operación según tu capital, riesgo y distancia al stop loss.
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
        <div>
          <div class="lbl">Capital ($)</div>
          <input class="inp" type="number" id="sz-capital" value="${p.capital}" oninput="calcSizing()" placeholder="1000">
        </div>
        <div>
          <div class="lbl">Riesgo por operación (%)</div>
          <input class="inp" type="number" id="sz-risk" value="${p.risk_pct}" step="0.1" oninput="calcSizing()" placeholder="2">
        </div>
        <div>
          <div class="lbl">Precio de entrada</div>
          <input class="inp" type="number" id="sz-entry" step="any" oninput="calcSizing()" placeholder="Ej: 65000">
        </div>
        <div>
          <div class="lbl">Stop Loss</div>
          <input class="inp" type="number" id="sz-sl" step="any" oninput="calcSizing()" placeholder="Ej: 63000">
        </div>
        <div>
          <div class="lbl">Take Profit 1 (opcional)</div>
          <input class="inp" type="number" id="sz-tp1" step="any" oninput="calcSizing()" placeholder="Ej: 68000">
        </div>
        <div>
          <div class="lbl">Apalancamiento</div>
          <input class="inp" type="number" id="sz-lev" value="${p.leverage || 1}" min="1" max="100" oninput="calcSizing()" placeholder="1">
        </div>
      </div>
      <button class="btn btng" onclick="calcSizing()" style="font-size:11px;padding:7px 16px">⚡ Calcular</button>
    </div>

    <div id="sizing-result" style="display:none"></div>

    <div class="card" style="margin-top:12px">
      <div class="stl" style="margin-bottom:10px">📋 Tabla rápida — distintos riesgos</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead>
            <tr style="background:var(--s2)">
              <th style="padding:7px 10px;text-align:left;border-bottom:1px solid var(--border);color:var(--muted)">Riesgo %</th>
              <th style="padding:7px 10px;text-align:right;border-bottom:1px solid var(--border);color:var(--muted)">En USD</th>
              <th style="padding:7px 10px;text-align:right;border-bottom:1px solid var(--border);color:var(--muted)">Posición (1x)</th>
              <th style="padding:7px 10px;text-align:right;border-bottom:1px solid var(--border);color:var(--muted)">Posición (5x)</th>
              <th style="padding:7px 10px;text-align:right;border-bottom:1px solid var(--border);color:var(--muted)">Posición (10x)</th>
            </tr>
          </thead>
          <tbody id="sizing-table-body">
          </tbody>
        </table>
      </div>
    </div>`;
  calcSizing();
  renderSizingTable();
}

function calcSizing() {
  const capital = parseFloat(qs('#sz-capital')?.value) || 0;
  const riskPct = parseFloat(qs('#sz-risk')?.value)    || 0;
  const entry   = parseFloat(qs('#sz-entry')?.value)   || 0;
  const sl      = parseFloat(qs('#sz-sl')?.value)      || 0;
  const tp1     = parseFloat(qs('#sz-tp1')?.value)     || 0;
  const lev     = parseFloat(qs('#sz-lev')?.value)     || 1;
  const result  = qs('#sizing-result');
  if (!result) return;

  renderSizingTable();

  if (!capital || !riskPct || !entry || !sl) {
    result.style.display = 'none';
    return;
  }

  const riskUSD     = capital * riskPct / 100;
  const slDist      = Math.abs(entry - sl);
  const slPct       = (slDist / entry) * 100;
  if (slDist === 0) { result.style.display = 'none'; return; }

  const direction   = entry > sl ? 'LONG' : 'SHORT';
  const qty         = riskUSD / slDist;               // unidades sin apalancamiento
  const posSize     = qty * entry;                    // valor nocional sin lev
  const margin      = posSize / lev;                  // margen requerido
  const rr          = tp1 > 0 ? (Math.abs(tp1 - entry) / slDist).toFixed(2) : null;
  const potGain     = tp1 > 0 ? (Math.abs(tp1 - entry) * qty).toFixed(2) : null;
  const feeOpen     = posSize * 0.0006;
  const feeClose    = posSize * 0.0006;
  const totalFees   = feeOpen + feeClose;
  const netRisk     = riskUSD + totalFees;

  const colors = {
    LONG:  'var(--green)',
    SHORT: 'var(--red)',
  };

  result.style.display = 'block';
  result.innerHTML = `
    <div class="card" style="border-left:3px solid ${colors[direction]}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <span style="font-size:13px;font-weight:700;color:${colors[direction]}">${direction}</span>
        <span style="font-size:11px;color:var(--muted)">· Entrada ${entry} · SL ${sl} · Lev ${lev}x</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">
        ${szKpi('Riesgo en USD', '$' + riskUSD.toFixed(2), 'var(--red)', 'Máximo a perder')}
        ${szKpi('Cantidad', qty.toFixed(4) + ' u', 'var(--text)', 'Unidades a comprar')}
        ${szKpi('Valor nocional', '$' + posSize.toFixed(2), 'var(--text)', 'qty × precio entrada')}
        ${szKpi('Margen necesario', '$' + margin.toFixed(2), 'var(--accent)', 'a ' + lev + 'x')}
        ${szKpi('Dist. SL', slPct.toFixed(2) + '%', 'var(--yellow)', '$' + slDist.toFixed(4))}
        ${rr ? szKpi('R:R ratio', '1:' + rr, parseFloat(rr) >= 2 ? 'var(--green)' : 'var(--yellow)', 'Ganancia potencial $' + potGain) : ''}
        ${szKpi('Comisiones est.', '$' + totalFees.toFixed(2), 'var(--muted)', 'Taker 0.06% × 2')}
        ${szKpi('Riesgo neto', '$' + netRisk.toFixed(2), 'var(--red)', 'con comisiones')}
      </div>
      ${margin > capital ? '<div style="margin-top:12px;padding:8px 12px;background:rgba(239,68,68,.1);border-radius:6px;font-size:11px;color:var(--red)">⚠️ El margen requerido supera tu capital disponible. Reduce el apalancamiento o ajusta el SL.</div>' : ''}
    </div>`;
}

function szKpi(label, value, color, sub) {
  return `
    <div style="background:var(--s2);border-radius:8px;padding:10px 12px">
      <div style="font-size:10px;color:var(--muted);margin-bottom:2px">${label}</div>
      <div style="font-size:14px;font-weight:700;color:${color}">${value}</div>
      ${sub ? `<div style="font-size:9px;color:var(--muted);margin-top:1px">${sub}</div>` : ''}
    </div>`;
}

function renderSizingTable() {
  const tbody   = qs('#sizing-table-body');
  if (!tbody) return;
  const capital = parseFloat(qs('#sz-capital')?.value) || state.profile.capital;
  const risks   = [0.5, 1, 1.5, 2, 3, 5];
  tbody.innerHTML = risks.map(r => {
    const rUSD    = (capital * r / 100);
    const pos1x   = rUSD.toFixed(2);
    const pos5x   = (rUSD * 5).toFixed(2);
    const pos10x  = (rUSD * 10).toFixed(2);
    const color   = r <= 1 ? 'var(--green)' : r <= 3 ? 'var(--yellow)' : 'var(--red)';
    return `
      <tr style="border-bottom:1px solid var(--border)${r === state.profile.risk_pct ? ';background:rgba(108,99,255,.08)' : ''}">
        <td style="padding:6px 10px;color:${color};font-weight:600">${r}%</td>
        <td style="padding:6px 10px;text-align:right">$${rUSD.toFixed(2)}</td>
        <td style="padding:6px 10px;text-align:right;color:var(--muted)">$${pos1x}</td>
        <td style="padding:6px 10px;text-align:right;color:var(--muted)">$${pos5x}</td>
        <td style="padding:6px 10px;text-align:right;color:var(--muted)">$${pos10x}</td>
      </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════
   CONFIG TAB: BITUNIX
   ══════════════════════════════════════════════════════════════════ */
function renderConfigBitunix(root) {
  root.innerHTML = `
    <div class="stl">🔗 Bitunix Exchange</div>
    <div id="bitunix-config-status" style="margin-bottom:14px">
      <div style="font-size:11px;color:var(--muted)">Comprobando conexión...</div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.7">
        Para conectar Bitunix añade estas variables en tu panel de Railway y haz redeploy:
      </div>
      <div style="background:var(--s2);border-radius:8px;padding:12px 14px;font-size:11px;font-family:monospace;margin-bottom:14px;line-height:2">
        BITUNIX_API_KEY = tu_api_key<br>
        BITUNIX_SECRET = tu_secret_key
      </div>
      <div style="font-size:10px;color:var(--muted);line-height:1.6">
        ⚠️ Crea la API Key con permisos de <b>trading</b> únicamente. Nunca actives permisos de retiro.
      </div>
    </div>

    <div id="bitunix-account-panel"></div>

    <div class="card" style="margin-top:12px">
      <div class="stl" style="margin-bottom:10px">📊 Historial de órdenes</div>
      <div id="sec-bitunix-history"><div style="font-size:11px;color:var(--muted)">Cargando...</div></div>
    </div>`;

  // Load status
  checkBitunixStatus().then(ok => {
    const el = qs('#bitunix-config-status');
    if (!el) return;
    el.innerHTML = ok
      ? '<div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:rgba(34,197,94,.1);border-radius:8px;font-size:11px;color:var(--green)">✅ Conectado — Bitunix Live activo</div>'
      : '<div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:rgba(234,179,8,.1);border-radius:8px;font-size:11px;color:var(--yellow)">⚠️ No conectado — añade las variables en Railway</div>';
    if (ok) {
      fetchBitunixAccount().then(() => {
        const panel = qs('#bitunix-account-panel');
        if (!panel) return;
        const b = state.bitunixBalance || {};
        panel.innerHTML = `
          <div class="card">
            <div class="stl" style="margin-bottom:10px">💰 Cuenta actual</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">
              ${szKpi('Equity', '$' + (b.equity || '—'), 'var(--accent)', '')}
              ${szKpi('Balance', '$' + (b.balance || '—'), 'var(--text)', '')}
              ${szKpi('Margen usado', '$' + (b.usedMargin || '—'), 'var(--yellow)', '')}
              ${szKpi('P&L no realizado', (b.unrealized >= 0 ? '+' : '') + '$' + (b.unrealized || '0'), b.unrealized >= 0 ? 'var(--green)' : 'var(--red)', '')}
            </div>
          </div>`;
      });
      renderBitunixHistory().catch(() => {
        const hp = qs('#sec-bitunix-history');
        if (hp) hp.innerHTML = '<div style="font-size:11px;color:var(--muted)">Sin historial disponible</div>';
      });
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   CONFIG TAB: AVANZADO
   ══════════════════════════════════════════════════════════════════ */
function renderConfigAvanzado(root) {
  const scanInterval = state.profile.scan_interval || 15;
  root.innerHTML = `
    <div class="stl">⚙️ Configuración avanzada</div>

    <div class="card" style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:12px">🔔 Monedas vigiladas</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">
        Selecciona qué monedas aparecen en Mercado y se usan en el análisis IA. Mínimo 2, máximo 10.
      </div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:14px" id="adv-coin-chips"></div>
      <div style="font-size:10px;color:var(--muted)">Activas: <b style="color:var(--text)">${state.watchedCoins.join(', ')}</b></div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:12px">📡 Escáner automático</div>
      <div class="lbl">Intervalo de escaneo (minutos)</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input class="inp" type="number" id="scan-interval-input" value="${scanInterval}" min="5" max="240" style="max-width:100px">
        <button class="btn btng" onclick="saveScanInterval()" style="font-size:11px;padding:7px 12px">Guardar</button>
      </div>
      <div style="font-size:10px;color:var(--muted)">Recomendado: 15–30 min para no consumir demasiadas peticiones a la API.</div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:12px">📊 Logs de actividad</div>
      <div id="activity-log-panel">
        ${renderActivityLogHTML()}
      </div>
    </div>

    <div class="card" style="border-color:rgba(239,68,68,.3)">
      <div style="font-size:12px;font-weight:600;color:var(--red);margin-bottom:8px">⚠️ Zona peligrosa</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">Estas acciones son irreversibles.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="exportTradesCSV()" style="font-size:11px;padding:7px 12px">📥 Exportar trades CSV</button>
        <button class="btn" onclick="resetAll()" style="font-size:11px;padding:7px 12px;border-color:rgba(239,68,68,.4);color:var(--red)">🗑️ Borrar todos los datos</button>
      </div>
    </div>`;
  // Render coin chips (can't use template literals inside template literals easily)
  const advChips = qs('#adv-coin-chips');
  if (advChips) {
    advChips.innerHTML = ALL_COINS.map(c => {
      const active = state.watchedCoins.includes(c);
      return '<span class="chip' + (active ? ' on' : '') + '" onclick="toggleWatchedCoin(\'' + c + '\')">' + c + ' <span style="font-size:9px;color:var(--muted)">' + (COIN_NAMES[c] || '') + '</span></span>';
    }).join('');
  }
}

function saveScanInterval() {
  const val = parseInt(qs('#scan-interval-input')?.value);
  if (!val || val < 5 || val > 240) { showToast('Intervalo entre 5 y 240 minutos', true); return; }
  state.profile.scan_interval = val;
  saveKey('profile', state.profile);
  showToast('✓ Intervalo guardado — se aplicará en el próximo ciclo');
}


function setConfigTab(tabId) {
  state.configTab = tabId;
  renderConfig();
}

function renderConfigTabContent(tab) {
  const root = qs('#config-tab-content');
  if (!root) return;
  if (tab === 'perfil')   { root.innerHTML = '<div id="sec-profile"></div>'; renderProfile(); }
  if (tab === 'capital')  { root.innerHTML = '<div id="sec-capital"></div>'; renderCapital(); }
  if (tab === 'sizing')   { renderSizingCalc(root); }
  if (tab === 'bitunix')  { renderConfigBitunix(root); }
  if (tab === 'avanzado') { renderConfigAvanzado(root); }
}


function renderAll() {
  renderStoragePanel();
  renderBalanceWidget();
  updateAlertBadge();

  const id = state.currentTab;
  if (id === 'ops')       renderOps();
  if (id === 'alerts')    renderAlerts();
  if (id === 'historial') renderHistorial();
  if (id === 'mkt')       renderMkt();
  if (id === 'strat')     renderStrategy();
  if (id === 'config')    renderConfig();
  if (id === 'goals')     renderGoals();
  if (id === 'diary')     renderDiary();
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
  updateReadOnlyBadge();
  // Actualizar tema del chart inline si está abierto, sin cerrarlo
  const tvModal = qs('#tv-modal');
  if (tvModal) {
    const iframe = tvModal.querySelector('iframe');
    if (iframe) {
      const src = iframe.src;
      iframe.src = src.replace(/theme=(dark|light)/, 'theme=' + (on ? 'dark' : 'light'));
    }
  }
}

function toggleReadOnly() {
  state.readOnlyMode = !state.readOnlyMode;
  storage.set('cp:readOnly', state.readOnlyMode);
  updateReadOnlyBadge();
  showToast(state.readOnlyMode ? '👁️ Modo solo lectura activado — no puedes abrir operaciones.' : '✏️ Modo edición activado.', state.readOnlyMode);
}

function updateReadOnlyBadge() {
  const badge = qs('#ro-badge');
  if (!badge) return;
  badge.textContent  = state.readOnlyMode ? '👁️ Solo lectura' : '✏️ Editar';
  badge.title        = state.readOnlyMode ? 'Modo solo lectura activo — click para desactivar' : 'Click para activar solo lectura';
  badge.style.background = state.readOnlyMode ? 'rgba(251,191,36,.15)' : 'var(--s2)';
  badge.style.color      = state.readOnlyMode ? 'var(--yellow)' : 'var(--muted)';
  badge.style.border     = state.readOnlyMode ? '1px solid rgba(251,191,36,.4)' : '1px solid var(--border)';
  // Deshabilitar botón generar
  const genBtn = qs('#btn-gen');
  if (genBtn) genBtn.disabled = state.readOnlyMode || state.wsStatus !== 'live';
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
  logActivity('goal_add', 'Objetivo añadido: ' + goal.title + ' → +$' + goal.targetPnl);
  renderGoals();
  showToast(`🎯 Objetivo "${title}" creado`);
}

function deleteGoal(id) {
  state.goals = state.goals.filter(g => g.id !== id);
  saveKey('goals', state.goals);
  logActivity('goal_delete', 'Objetivo eliminado');
  renderGoals();
}

function renderGoals() {
  const root = qs('#sec-goals') || qs('#goals-section');
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

  // ── Multi-tab: evitar conflictos si hay más de una pestaña abierta ──
  const TAB_KEY = 'cplan_active_tab';
  const myTabId = Date.now() + '_' + Math.random().toString(36).slice(2);
  let isLeaderTab = true;

  const claimLeader = () => localStorage.setItem(TAB_KEY, myTabId);
  claimLeader();

  // Cada 4s renovar el claim; si otro tab lo tomó, mostrar aviso
  setInterval(() => {
    const current = localStorage.getItem(TAB_KEY);
    if (current && current !== myTabId) {
      // Otro tab es líder — mostrar banner no intrusivo
      if (isLeaderTab) {
        isLeaderTab = false;
        const banner = document.createElement('div');
        banner.id = 'multi-tab-banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#1a1000;border-bottom:2px solid var(--yellow,#c8aa50);padding:8px 16px;font-size:12px;color:#c8aa50;text-align:center';
        banner.innerHTML = '⚠️ CryptoPlan IA ya está abierto en otra pestaña. Para evitar conflictos, usa solo una pestaña a la vez. <button onclick="document.getElementById(\'multi-tab-banner\').remove();window._multiTabAck=true" style="margin-left:12px;background:none;border:1px solid currentColor;border-radius:4px;padding:2px 8px;color:inherit;cursor:pointer;font-size:11px">Entendido</button>';
        document.body.prepend(banner);
      }
    } else {
      claimLeader(); // seguimos siendo líder
      if (!isLeaderTab && !window._multiTabAck) isLeaderTab = true;
    }
  }, 4_000);

  // Al cerrar esta pestaña, liberar el claim
  window.addEventListener('beforeunload', () => {
    if (localStorage.getItem(TAB_KEY) === myTabId) localStorage.removeItem(TAB_KEY);
  });

  // Aplicar modo oscuro guardado ANTES de mostrar nada
  applyDarkMode(state.darkMode);

  const loader = qs('#loading-screen');
  if (loader) loader.remove();

  qsa('.nb').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  qs('#btn-gen')            ?.addEventListener('click', onGenerate);
  qs('#scanner-toggle-hdr') ?.addEventListener('click', toggleScanner);

  initMarketMeta(state.watchedCoins);
  connectWS();

  setTab('dashboard');
  renderBalanceWidget();
  updateAlertBadge();

  // Datos de mercado + calendario — diferidos para que el UI cargue primero
  setTimeout(() => {
    fetchMarketMeta();
    fetchEconomicCalendar();
  }, 300);
  setInterval(fetchMarketMeta, 15 * 60 * 1000);

  // Detectar escáner muerto — avisa si lleva >2h activo sin ejecutarse
  setInterval(() => {
    if (!state.scannerOn) return;
    const last = state.lastScan ? new Date(state.lastScan).getTime() : 0;
    if (last && (Date.now() - last) > 120 * 60 * 1000) {
      showToast('⚠️ El escáner lleva más de 2h sin ejecutarse. Puede estar detenido.', true);
    }
  }, 30 * 60 * 1000);
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

  // ── Cargar perfil desde servidor (tiene prioridad sobre localStorage)
  authFetch('/api/profile').then(r => r.json()).then(data => {
    if (data.ok && data.profile && typeof data.profile === 'object') {
      // Merge: servidor gana en los campos que existen, localStorage en el resto
      state.profile = { ...DEFAULT_PROFILE, ...state.profile, ...data.profile };
      storage.set(STORAGE_KEYS.profile, state.profile);
      console.log('[Profile] Cargado desde servidor:', JSON.stringify({
        capital: state.profile.capital,
        risk_pct: state.profile.risk_pct,
        leverage: state.profile.leverage,
      }));
      // Re-renderizar si hay cambios relevantes
      renderAll();
    }
  }).catch(() => {});

  syncTradesToServer();
  // Cargar price alerts desde Supabase y merge con localStorage
  authFetch('/api/price-alerts').then(r => r.json()).then(data => {
    if (!data.ok || !data.alerts?.length) return;
    const localIds = new Set((state.priceAlerts || []).map(a => a.id));
    const merged   = [...(state.priceAlerts || [])];
    data.alerts.forEach(a => { if (!localIds.has(a.id) && !a.triggered) merged.push(a); });
    state.priceAlerts = merged;
    saveKey('priceAlerts', state.priceAlerts);
    if (state.currentTab === 'alerts') renderAlerts();
  }).catch(() => {});

  // Cargar diary desde Supabase y merge con localStorage
  authFetch('/api/diary').then(r => r.json()).then(data => {
    if (!data.ok || !data.entries?.length) return;
    const localDiary = state.diary || [];
    const localIds   = new Set(localDiary.map(e => e.id));
    const merged     = [...localDiary];
    data.entries.forEach(e => { if (!localIds.has(e.id)) merged.push(e); });
    merged.sort((a, b) => b.date.localeCompare(a.date));
    state.diary = merged;
    storage.set('cp:diary', state.diary);
    if (state.currentTab === 'diary') renderDiary();
  }).catch(() => {});
  updateReadOnlyBadge();
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
  toggleTradeChart, reloadTradeChart,
  submitPriceAlert, deletePriceAlert,
  toggleScanLog, toggleBalanceEdit, saveQuickCapital,
  // Nuevas funciones
  toggleDarkMode,
  applyBtFilter, resetBtFilters,
  submitGoal, deleteGoal,
  onboardNext, onboardBack, setObRisk,
  refreshCalendar,
  showBitunixSetup, refreshBitunixData,
  doLogout,
  resetAll, renderAll, syncProfileToServer,
  exportTradesCSV,
  showEquityCurve,
  renderBitunixHistory,
  histPageNav,
  renderDashboard,
  // Nuevas
  setConfigTab,
  renderConfigTabContent,
  calcSizing,
  renderSizingTable,
  saveScanInterval,
  saveDiaryEntry,
  deleteDiaryEntry,
  logActivity,
});
/* ══════════════════════════════════════════════════════════════════
   HISTORIAL BITUNIX — Órdenes reales de la cuenta
   ══════════════════════════════════════════════════════════════════ */
async function renderBitunixHistory() {
  const containerId = 'sec-bitunix-history';
  const container   = qs('#' + containerId);
  if (!container) return;

  // Estado de carga
  container.innerHTML = `
    <div class="card">
      <div class="stl">📋 Historial Bitunix</div>
      <div class="empty" style="padding:20px">
        <div class="et">Cargando órdenes...</div>
      </div>
    </div>`;

  try {
    const res  = await authFetch('/api/bitunix/history');
    const data = await res.json();

    if (!data.ok) {
      container.innerHTML = `
        <div class="card">
          <div class="stl">📋 Historial Bitunix</div>
          <div class="empty" style="padding:20px">
            <div class="et" style="color:var(--red)">Error: ${data.error || 'No se pudo obtener el historial'}</div>
          </div>
        </div>`;
      return;
    }

    const orders = data.orders || [];

    if (!orders.length) {
      container.innerHTML = `
        <div class="card">
          <div class="stl">📋 Historial Bitunix</div>
          <div class="empty" style="padding:20px">
            <div class="et">Sin órdenes en el historial de Bitunix.</div>
          </div>
        </div>`;
      return;
    }

    // Calcular resumen
    const filled  = orders.filter(o => o.status === 'FILLED' || o.status === 'filled');
    const longs   = filled.filter(o => o.side === 'BUY'  || o.side === 'buy');
    const shorts  = filled.filter(o => o.side === 'SELL' || o.side === 'sell');
    const totalPnl = filled.reduce((a, o) => a + parseFloat(o.realizedPnl || o.pnl || 0), 0);

    // Filas de órdenes
    const rows = orders.map(o => {
      const side      = (o.side || '').toUpperCase();
      const isLong    = side === 'BUY';
      const status    = (o.status || '').toUpperCase();
      const isFilled  = status === 'FILLED';
      const symbol    = (o.symbol || '').replace('USDT', '/USDT');
      const qty       = parseFloat(o.qty || o.quantity || 0);
      const price     = parseFloat(o.price || o.avgPrice || o.dealPrice || 0);
      const pnl       = parseFloat(o.realizedPnl || o.pnl || 0);
      const hasPnl    = o.realizedPnl != null || o.pnl != null;
      const orderType = (o.orderType || o.type || 'MARKET').toUpperCase();

      // Formatear timestamp
      let dateStr = '—';
      const ts = o.createTime || o.createdTime || o.time || o.timestamp;
      if (ts) {
        const d = new Date(typeof ts === 'string' ? parseInt(ts) : ts);
        if (!isNaN(d)) dateStr = d.toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
      }

      return `
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:10px 12px;border-bottom:1px solid var(--border);gap:8px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:10px;min-width:0">
            <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;flex-shrink:0;
                         background:${isLong ? 'var(--green)' : 'var(--red)'}22;
                         color:${isLong ? 'var(--green)' : 'var(--red)'}">
              ${isLong ? 'LONG' : 'SHORT'}
            </span>
            <div style="min-width:0">
              <div style="font-weight:600;font-size:13px">${symbol}</div>
              <div style="font-size:10px;color:var(--muted)">${dateStr} · ${orderType}</div>
            </div>
          </div>
          <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
            <div style="text-align:right">
              <div style="font-size:11px;color:var(--muted)">Precio</div>
              <div style="font-size:12px;font-weight:600">${price > 0 ? '$' + price.toLocaleString('es-ES', {minimumFractionDigits:2, maximumFractionDigits:6}) : '—'}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:11px;color:var(--muted)">Qty</div>
              <div style="font-size:12px;font-weight:600">${qty > 0 ? qty : '—'}</div>
            </div>
            ${hasPnl ? `
            <div style="text-align:right">
              <div style="font-size:11px;color:var(--muted)">P&L</div>
              <div style="font-size:12px;font-weight:700;color:${pnl >= 0 ? 'var(--green)' : 'var(--red)'}">
                ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
              </div>
            </div>` : ''}
            <span style="font-size:10px;padding:2px 7px;border-radius:4px;flex-shrink:0;
                         background:${isFilled ? 'var(--green)' : 'var(--border)'}22;
                         color:${isFilled ? 'var(--green)' : 'var(--muted)'}">
              ${status || '—'}
            </span>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)">
          <div class="stl" style="margin:0">📋 Historial Bitunix <span style="font-size:11px;font-weight:400;color:var(--muted)">(${orders.length} órdenes)</span></div>
          <button onclick="renderBitunixHistory()"
            style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 10px;
                   font-size:11px;color:var(--muted);cursor:pointer">
            ↻ Actualizar
          </button>
        </div>

        <!-- Resumen rápido -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:0;border-bottom:1px solid var(--border)">
          <div style="padding:12px 16px;text-align:center;border-right:1px solid var(--border)">
            <div style="font-size:18px;font-weight:700">${orders.length}</div>
            <div style="font-size:10px;color:var(--muted)">Total órdenes</div>
          </div>
          <div style="padding:12px 16px;text-align:center;border-right:1px solid var(--border)">
            <div style="font-size:18px;font-weight:700;color:var(--green)">${longs.length}</div>
            <div style="font-size:10px;color:var(--muted)">LONGs ejecutados</div>
          </div>
          <div style="padding:12px 16px;text-align:center;border-right:1px solid var(--border)">
            <div style="font-size:18px;font-weight:700;color:var(--red)">${shorts.length}</div>
            <div style="font-size:10px;color:var(--muted)">SHORTs ejecutados</div>
          </div>
          ${totalPnl !== 0 ? `
          <div style="padding:12px 16px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:${totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}">
              ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}
            </div>
            <div style="font-size:10px;color:var(--muted)">P&L realizado</div>
          </div>` : ''}
        </div>

        <!-- Lista de órdenes -->
        <div style="max-height:500px;overflow-y:auto">
          ${rows}
        </div>
      </div>`;

  } catch (e) {
    container.innerHTML = `
      <div class="card">
        <div class="stl">📋 Historial Bitunix</div>
        <div class="empty" style="padding:20px">
          <div class="et" style="color:var(--red)">Error al cargar: ${e.message}</div>
        </div>
      </div>`;
  }
}

/* ══════════════════════════════════════════════════════════════════
   LOGS DE ACTIVIDAD
   ══════════════════════════════════════════════════════════════════ */
function logActivity(action, detail) {
  const entry = {
    id:     Date.now(),
    ts:     new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }),
    action,
    detail: detail || '',
  };
  state.activityLog.unshift(entry);
  if (state.activityLog.length > 200) state.activityLog.length = 200;
  storage.set('cp:activity', state.activityLog);
  // Refresh panel if visible
  const panel = qs('#activity-log-panel');
  if (panel) panel.innerHTML = renderActivityLogHTML();
}

function renderActivityLogHTML() {
  const log = state.activityLog || [];
  if (!log.length) return '<div style="font-size:11px;color:var(--muted)">Sin actividad registrada aún.</div>';

  const icons = {
    'trade_open':    '🟢',
    'trade_close':   '🔵',
    'trade_cancel':  '⚫',
    'scanner_alert': '🔔',
    'scanner_on':    '▶️',
    'scanner_off':   '⏸',
    'login':         '🔑',
    'goal_add':      '🎯',
    'goal_delete':   '🗑️',
    'diary_entry':   '📓',
    'config_save':   '⚙️',
  };

  const rows = log.slice(0, 50).map(e => {
    const icon = icons[e.action] || '•';
    return `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:11px">
      <span style="color:var(--muted);white-space:nowrap;min-width:90px">${e.ts}</span>
      <span>${icon}</span>
      <span style="color:var(--text)">${e.detail || e.action}</span>
    </div>`;
  }).join('');

  return rows + (log.length > 50
    ? `<div style="font-size:10px;color:var(--muted);padding-top:6px">... y ${log.length - 50} entradas más</div>`
    : '');
}

/* ══════════════════════════════════════════════════════════════════
   DIARIO DE TRADING
   ══════════════════════════════════════════════════════════════════ */
function exportDiaryCSV() {
  const entries = state.diary || [];
  if (!entries.length) { showToast('Sin entradas en el diario.', true); return; }
  const headers = ['Fecha','Ánimo','P&L($)','Operaciones','Notas','Lección','Tags'];
  const moodLabels = { great:'Excelente', good:'Bueno', neutral:'Neutral', bad:'Malo', terrible:'Pésimo' };
  const rows = entries.map(e => [
    e.date,
    moodLabels[e.mood] || e.mood || '',
    e.pnl != null ? e.pnl.toFixed(2) : '',
    e.ops || '',
    (e.notes || '').replace(/"/g, '""'),
    (e.lessons || '').replace(/"/g, '""'),
    (e.tags || []).join(';'),
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `diario_trading_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 Diario exportado como CSV');
}

async function showWeeklySummary() {
  const btn = qs('.btn.btny');
  const origText = btn?.innerHTML || '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generando...'; }
  try {
    const r    = await authFetch('/api/diary/weekly-summary');
    const data = await r.json();
    if (!data.ok) { showToast('Error generando resumen: ' + (data.error || ''), true); return; }
    const { summary, stats } = data;

    const modal = document.createElement('div');
    modal.id = 'weekly-summary-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .2s ease';
    modal.innerHTML = `
      <div style="background:var(--card);border-radius:16px;padding:24px;width:min(480px,100%);max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.4);position:relative">
        <button onclick="document.getElementById('weekly-summary-modal').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted)">✕</button>
        <h3 style="margin:0 0 4px;font-size:16px;font-weight:700">${summary.titulo}</h3>
        <div style="font-size:11px;color:var(--muted);margin-bottom:18px">
          ${stats.trades} ops · ${stats.wins}W/${stats.trades - stats.wins}L · P&L: <span style="color:${stats.pnl >= 0 ? 'var(--green)' : 'var(--red)'};">${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}</span>
        </div>
        <div style="display:grid;gap:12px">
          <div style="padding:12px 14px;background:var(--s2);border-radius:10px;border-left:3px solid var(--accent)">
            <div style="font-size:10px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">Balance general</div>
            <div style="font-size:12px;line-height:1.6">${summary.balance}</div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div style="padding:12px 14px;background:rgba(0,200,150,.06);border-radius:10px;border-left:3px solid var(--green)">
              <div style="font-size:10px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">💪 Fortaleza</div>
              <div style="font-size:11px;line-height:1.5;color:#c8f0d8">${summary.fortaleza}</div>
            </div>
            <div style="padding:12px 14px;background:rgba(255,71,87,.06);border-radius:10px;border-left:3px solid var(--red)">
              <div style="font-size:10px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">🔧 Mejorar</div>
              <div style="font-size:11px;line-height:1.5;color:#f0c8c8">${summary.mejora}</div>
            </div>
          </div>
          <div style="padding:12px 14px;background:rgba(108,99,255,.08);border-radius:10px;border-left:3px solid var(--accent)">
            <div style="font-size:10px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">💡 Lección clave</div>
            <div style="font-size:12px;line-height:1.6">${summary.leccion}</div>
          </div>
          <div style="padding:12px 14px;background:rgba(255,200,0,.07);border-radius:10px;border-left:3px solid var(--yellow)">
            <div style="font-size:10px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">🎯 Objetivo próxima semana</div>
            <div style="font-size:12px;line-height:1.6;color:var(--yellow)">${summary.objetivo_proxima}</div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  } catch (err) {
    showToast('Error: ' + err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origText; }
  }
}

function renderDiary() {
  const root = qs('#sec-diary');
  if (!root) return;

  const entries = state.diary || [];
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayEntry = entries.find(e => e.date === todayKey);

  // Group by month for display
  const byMonth = {};
  entries.forEach(e => {
    const month = e.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(e);
  });

  const moodEmojis = { great: '🚀', good: '😊', neutral: '😐', bad: '😟', terrible: '💀' };
  const moodLabels = { great: 'Excelente', good: 'Bueno', neutral: 'Neutral', bad: 'Malo', terrible: 'Pésimo' };

  const monthsHTML = Object.keys(byMonth).sort().reverse().map(month => {
    const [y, m] = month.split('-');
    const monthName = new Date(y, m - 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    const cards = byMonth[month].sort((a,b) => b.date.localeCompare(a.date)).map(e => {
      const mood  = moodEmojis[e.mood] || '😐';
      const pnl   = e.pnl != null ? `<span style="color:${e.pnl>=0?'var(--green)':'var(--red)'};font-weight:600">${e.pnl>=0?'+':''}$${e.pnl.toFixed(2)}</span>` : '';
      const date  = new Date(e.date + 'T12:00:00').toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'short' });
      return `
        <div class="card" style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--text);text-transform:capitalize">${date}</div>
              <div style="font-size:10px;color:var(--muted);margin-top:1px">${mood} ${moodLabels[e.mood]||''}${e.ops ? ' · ' + e.ops + ' operaciones' : ''}${e.pnl != null ? ' · P&L: ' : ''}${pnl}</div>
            </div>
            <button onclick="deleteDiaryEntry('${e.id}')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;padding:2px">×</button>
          </div>
          ${e.notes ? `<div style="font-size:12px;color:var(--text);line-height:1.6;white-space:pre-wrap">${e.notes}</div>` : ''}
          ${e.lessons ? `<div style="margin-top:8px;padding:8px 10px;background:rgba(108,99,255,.08);border-left:3px solid var(--accent);border-radius:4px;font-size:11px;color:var(--text);line-height:1.5"><b style="color:var(--accent)">💡 Lección:</b> ${e.lessons}</div>` : ''}
          ${e.tags?.length ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">${e.tags.map(t => `<span style="padding:2px 8px;border-radius:12px;font-size:10px;background:var(--s2);color:var(--muted)">#${t}</span>`).join('')}</div>` : ''}
        </div>`;
    }).join('');
    return `
      <div style="margin-bottom:20px">
        <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">${monthName}</div>
        ${cards}
      </div>`;
  }).join('');

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <div class="stl" style="margin-bottom:0">📓 Diario de Trading</div>
      <div style="display:flex;gap:6px">
        <button class="btn" style="font-size:11px;padding:7px 12px" onclick="exportDiaryCSV()">⬇️ CSV</button>
        <button class="btn btny" style="font-size:11px;padding:7px 14px" onclick="showWeeklySummary()">📅 Resumen semanal IA</button>
      </div>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:16px">Registra tu estado mental, decisiones y lecciones aprendidas cada día.</div>

    <!-- Nueva entrada -->
    <div class="card" style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:12px">
        ✏️ Entrada de hoy — ${new Date().toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long' })}
        ${todayEntry ? ' <span style="font-size:10px;color:var(--accent)">(ya existe, se sobreescribirá)</span>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <div class="lbl">Estado de ánimo</div>
          <select class="inp" id="diary-mood" style="font-size:12px">
            <option value="great">🚀 Excelente</option>
            <option value="good" selected>😊 Bueno</option>
            <option value="neutral">😐 Neutral</option>
            <option value="bad">😟 Malo</option>
            <option value="terrible">💀 Pésimo</option>
          </select>
        </div>
        <div>
          <div class="lbl">P&L del día ($) — opcional</div>
          <input class="inp" type="number" id="diary-pnl" step="any" placeholder="Ej: 45.50" style="font-size:12px">
        </div>
      </div>
      <div style="margin-bottom:10px">
        <div class="lbl">Notas del día — ¿qué pasó en el mercado? ¿cómo te sentiste?</div>
        <textarea class="inp" id="diary-notes" rows="4" placeholder="Hoy el mercado estuvo lateral. BTC rebotó en soporte..." style="resize:vertical;font-size:12px;line-height:1.6"></textarea>
      </div>
      <div style="margin-bottom:10px">
        <div class="lbl">Lección aprendida (opcional)</div>
        <input class="inp" type="text" id="diary-lessons" placeholder="Ej: No operar contra la tendencia mayor" style="font-size:12px">
      </div>
      <div style="margin-bottom:14px">
        <div class="lbl">Tags (separados por coma)</div>
        <input class="inp" type="text" id="diary-tags" placeholder="Ej: disciplina, fomo, breakeven" style="font-size:12px">
      </div>
      <button class="btn btng" onclick="saveDiaryEntry()" style="font-size:11px;padding:8px 18px">💾 Guardar entrada</button>
    </div>

    <!-- Historial -->
    ${entries.length === 0
      ? '<div class="empty"><div class="ei">📓</div><div class="et">Sin entradas aún. Escribe tu primera nota del día.</div></div>'
      : monthsHTML
    }`;

  // Pre-fill today if exists
  if (todayEntry) {
    const moodSel = qs('#diary-mood');
    if (moodSel) moodSel.value = todayEntry.mood || 'good';
    const notesTa = qs('#diary-notes');
    if (notesTa) notesTa.value = todayEntry.notes || '';
    const lessonIn = qs('#diary-lessons');
    if (lessonIn) lessonIn.value = todayEntry.lessons || '';
    const tagsIn = qs('#diary-tags');
    if (tagsIn) tagsIn.value = (todayEntry.tags || []).join(', ');
    const pnlIn = qs('#diary-pnl');
    if (pnlIn && todayEntry.pnl != null) pnlIn.value = todayEntry.pnl;
  }
}

function saveDiaryEntry() {
  const mood    = qs('#diary-mood')?.value    || 'neutral';
  const notes   = qs('#diary-notes')?.value?.trim()   || '';
  const lessons = qs('#diary-lessons')?.value?.trim() || '';
  const tagsRaw = qs('#diary-tags')?.value?.trim()    || '';
  const pnlRaw  = qs('#diary-pnl')?.value;
  const pnl     = pnlRaw !== '' && pnlRaw != null ? parseFloat(pnlRaw) : null;

  if (!notes) { showToast('Escribe algo en las notas antes de guardar', true); return; }

  const todayKey = new Date().toISOString().slice(0, 10);
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];

  // Remove existing today entry
  state.diary = state.diary.filter(e => e.date !== todayKey);
  // Borrar entrada anterior del día en Supabase si existe
  const prevEntry = state.diary.find(e => e.date === todayKey);
  if (prevEntry) authFetch('/api/diary/' + prevEntry.id, { method: 'DELETE' }).catch(() => {});

  const entry = { id: Date.now(), date: todayKey, mood, notes, lessons, tags, pnl,
    ops: state.closedTrades.filter(t => {
      const d = new Date(t.closedAt || 0);
      return d.toISOString().slice(0,10) === todayKey;
    }).length,
  };
  state.diary.unshift(entry);
  storage.set('cp:diary', state.diary);
  // Sincronizar con Supabase
  authFetch('/api/diary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry }),
  }).catch(() => {});
  logActivity('diary_entry', 'Entrada del diario — ' + new Date().toLocaleDateString('es-ES'));
  showToast('📓 Entrada guardada');
  renderDiary();
}

function deleteDiaryEntry(id) {
  if (!confirm('¿Eliminar esta entrada del diario?')) return;
  state.diary = state.diary.filter(e => String(e.id) !== String(id));
  storage.set('cp:diary', state.diary);
  authFetch('/api/diary/' + id, { method: 'DELETE' }).catch(() => {});
  renderDiary();
}