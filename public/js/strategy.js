/* ═══════════════════════════════════════════════════════════════════
   CRYPTOPLAN IA — strategy.js v3 (FINAL)

   Responsabilidades de este módulo (SOLO cliente):
     ✓ Position sizing 1% dinámico sobre equity real
     ✓ Cálculo de TP1 (1.2:1), TP2 (2.5:1) y breakeven con fees
     ✓ Validación completa antes de confirmar trade
       (sesión NY, circuit breaker, noticias, SL razonable)
     ✓ Badge de sesión NY en el header (se actualiza cada minuto)
     ✓ Panel de validación en el modal de confirmación

   LO QUE NO HACE este módulo:
     ✗ Cerrar trades (eso lo hace EXCLUSIVAMENTE el servidor vía tpsl.js)
     ✗ Mover el SL (ídem)
     ✗ checkTPSL() no existe aquí — el servidor emite PARTIAL_CLOSE / TRADE_CLOSED
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Constantes de estrategia ─────────────────────────────────────────── */
const STRATEGY = {
    RISK_PCT: 1.0,    // 1% equity
    TP1_RATIO: 1.2,
    TP2_RATIO: 2.5,
    PARTIAL_CLOSE_PCT: 50,
    FEE_TAKER: 0.0006,
    FEE_MAKER: 0.0002,
    FEE_ROUND_TRIP: 0.0008,
    MAX_SL_PCT: 5.0,
    CB_CONSEC_LOSSES: 2,
    NEWS_BEFORE_MIN: 15,
    NEWS_AFTER_MIN: 30,
    VOL_MULTIPLIER: 1.5,
};

/* ═══════════════════════════════════════════════════
   1. EQUITY DINÁMICO
   ═══════════════════════════════════════════════════ */

function getCurrentEquity() {
    const { profile, closedTrades, activeTrades, prices } = state;
    const closedPnl = closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
    const activePnl = activeTrades.reduce((acc, t) => {
        const p = prices[coinOf(t.par)] || t.entrada;
        const lev = t.leverage || 1;
        return acc + (t.tipo === 'LONG'
            ? (p - t.entrada) * t.size * lev
            : (t.entrada - p) * t.size * lev);
    }, 0);
    return profile.capital + closedPnl + activePnl;
}

function getDynamicRiskUSD() {
    return Math.max(0, getCurrentEquity() * STRATEGY.RISK_PCT / 100);
}

/* ═══════════════════════════════════════════════════
   2. POSITION SIZING
   ═══════════════════════════════════════════════════ */

/** qty = riskUSD / |entrada - stopLoss| */
function calcSize(riskUSD, entry, stopLoss) {
    const dist = Math.abs(entry - stopLoss);
    return dist > 0 ? riskUSD / dist : 0.001;
}

/* ═══════════════════════════════════════════════════
   3. TARGETS
   ═══════════════════════════════════════════════════ */

function calcStrategyTargets(entry, stopLoss, tipo, tp1R = STRATEGY.TP1_RATIO, tp2R = STRATEGY.TP2_RATIO) {
    const slDist = Math.abs(entry - stopLoss);
    const dir = tipo === 'LONG' ? 1 : -1;
    return {
        tp1: parseFloat((entry + dir * slDist * tp1R).toFixed(6)),
        tp2: parseFloat((entry + dir * slDist * tp2R).toFixed(6)),
        slDist, tp1Ratio: tp1R, tp2Ratio: tp2R,
    };
}

/** Breakeven real: entrada × (1 ± 0.0008) */
function calcBreakevenWithFees(entry, tipo) {
    return tipo === 'LONG'
        ? parseFloat((entry * (1 + STRATEGY.FEE_ROUND_TRIP)).toFixed(6))
        : parseFloat((entry * (1 - STRATEGY.FEE_ROUND_TRIP)).toFixed(6));
}

function calcNetPnL(trade, exitPrice, exitFeeType = 'maker') {
    const lev = trade.leverage || 1;
    const gross = trade.tipo === 'LONG'
        ? (exitPrice - trade.entrada) * trade.size * lev
        : (trade.entrada - exitPrice) * trade.size * lev;
    const feeOpen = trade.entrada * trade.size * STRATEGY.FEE_TAKER;
    const feeClose = exitPrice * trade.size * (exitFeeType === 'taker' ? STRATEGY.FEE_TAKER : STRATEGY.FEE_MAKER);
    const fees = feeOpen + feeClose;
    return { gross, fees, net: gross - fees };
}

/* ═══════════════════════════════════════════════════
   4. BUILD TRADE — sobreescribe la versión básica de trading.js
   ═══════════════════════════════════════════════════ */

function buildTrade(proposal) {
    const { profile, prices } = state;
    const leverage = profile.leverage || 1;
    const coin = coinOf(proposal.par);
    const realEntry = prices[coin] || proposal.entrada;
    const tipo = proposal.tipo;

    const equity = getCurrentEquity();
    const riskUSD = equity * STRATEGY.RISK_PCT / 100;
    const size = calcSize(riskUSD, realEntry, proposal.stopLoss);

    // Targets: usar el de la IA si es más ambicioso, si no calcular
    const stratTargets = calcStrategyTargets(realEntry, proposal.stopLoss, tipo);
    const tp1 = proposal.tp1
        ? (tipo === 'LONG' ? Math.max(proposal.tp1, stratTargets.tp1) : Math.min(proposal.tp1, stratTargets.tp1))
        : stratTargets.tp1;
    const tp2 = proposal.tp2 || stratTargets.tp2;
    const bePrice = calcBreakevenWithFees(realEntry, tipo);

    const slDist = Math.abs(realEntry - proposal.stopLoss);
    const rrReal = slDist > 0 ? (Math.abs(tp1 - realEntry) / slDist).toFixed(2) : (proposal.rr || '1.2');
    const rr2 = slDist > 0 ? (Math.abs(tp2 - realEntry) / slDist).toFixed(2) : '2.5';

    return {
        id: uid(),
        par: proposal.par,
        tipo,
        setup: proposal.setup || '',
        entrada: realEntry,
        stopLoss: proposal.stopLoss,
        tp1, tp2, bePrice,
        rr: rrReal, rr2,
        confianza: proposal.confianza,
        razon: proposal.razon,
        size: parseFloat(size.toFixed(6)),
        leverage,
        riskUSD: parseFloat(riskUSD.toFixed(2)),
        equity: parseFloat(equity.toFixed(2)),
        currentPrice: realEntry,
        pnl: 0, pnlPct: 0,
        createdAt: nowFull(),
        // Flags de estrategia (los actualiza el servidor)
        tp1Hit: false,
        breakevenSet: false,
        partialClosed: false,
        partialClosePnl: 0,
        partialCloseQty: 0,
    };
}

/* ═══════════════════════════════════════════════════
   5. SESIÓN NY
   ═══════════════════════════════════════════════════ */

function checkNYSession(now = new Date()) {
    const day = now.getUTCDay();
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

    if (day === 0 || day === 6)
        return { inSession: false, label: 'FIN SEMANA', reason: 'Mercado institucional inactivo', color: 'var(--muted)' };

    if (day === 5 && mins >= 17 * 60 + 30)
        return { inSession: false, label: 'CIERRE VIE', reason: 'Viernes tarde — liquidez reducida', color: 'var(--yellow)' };

    const start = 13 * 60 + 30;
    const end = 18 * 60;

    if (mins >= start && mins < end) {
        const left = end - mins;
        const lh = Math.floor(left / 60), lm = left % 60;
        return {
            inSession: true, label: 'NY ABIERTO',
            reason: `Sesión NY activa — ${lh > 0 ? lh + 'h ' : ''}${lm}min restantes`,
            minutesLeft: left, color: 'var(--accent)',
        };
    }
    if (mins < start) {
        const wait = start - mins;
        const wh = Math.floor(wait / 60), wm = wait % 60;
        return { inSession: false, label: 'PRE-NY', reason: `NY abre en ${wh > 0 ? wh + 'h ' : ''}${wm}min (14:30 CET)`, color: 'var(--yellow)' };
    }
    return { inSession: false, label: 'NY CERRADO', reason: 'Sesión NY cerrada (19:00 CET)', color: 'var(--muted)' };
}

/* ═══════════════════════════════════════════════════
   6. CIRCUIT BREAKER
   ═══════════════════════════════════════════════════ */

function getConsecutiveLosses() {
    let count = 0;
    for (const t of state.closedTrades) {
        if (t.result === 'LOSS') count++; else break;
    }
    return count;
}

function checkStrategyCircuitBreaker() {
    const losses = getConsecutiveLosses();
    const max = STRATEGY.CB_CONSEC_LOSSES;
    return {
        triggered: losses >= max, losses, max,
        reason: losses >= max
            ? `⛔ Circuit Breaker: ${losses} pérdidas consecutivas. Pausa operativa.`
            : losses > 0 ? `⚠️ ${losses} pérdida(s) consecutiva(s)` : null,
    };
}

/* ═══════════════════════════════════════════════════
   7. FILTRO DE NOTICIAS
   Espera a que el calendario esté cargado (race condition fix)
   ═══════════════════════════════════════════════════ */

function checkStrategyNewsFilter(now = new Date()) {
    // calendarData puede no estar cargado aún — en ese caso no bloqueamos
    // pero sí advertimos
    const events = (typeof calendarData !== 'undefined' && calendarData?.length) ? calendarData : [];
    if (!events.length) return { blocked: false, reason: null, calendarReady: false };

    const nowMs = now.getTime();
    const beforeMs = STRATEGY.NEWS_BEFORE_MIN * 60 * 1000;
    const afterMs = STRATEGY.NEWS_AFTER_MIN * 60 * 1000;

    for (const evt of events) {
        if (evt.impact !== 'High') continue;
        if (!['USD', 'BTC'].includes(evt.currency)) continue;
        let evtMs;
        try { evtMs = new Date(evt.date).getTime(); } catch { continue; }
        if (isNaN(evtMs)) continue;
        const diff = nowMs - evtMs;
        if (diff >= -beforeMs && diff <= afterMs) {
            const mins = Math.round(Math.abs(diff) / 60000);
            return {
                blocked: true, event: evt, calendarReady: true,
                reason: diff < 0
                    ? `⚠️ Noticias en ${mins}min: ${evt.currency} ${evt.title}`
                    : `⚠️ Post-evento ${mins}min: ${evt.currency} ${evt.title}`,
            };
        }
    }
    return { blocked: false, reason: null, calendarReady: true };
}

/* ═══════════════════════════════════════════════════
   8. VALIDACIÓN COMPLETA DE ENTRADA
   ═══════════════════════════════════════════════════ */

function validateStrategyEntry(proposal) {
    const errors = [];
    const warnings = [];
    const checks = {};

    // A. Sesión NY
    const session = checkNYSession();
    checks.session = session;
    if (!session.inSession) {
        const coin = coinOf(proposal.par);
        const meta = MARKET_META[coin];
        if (meta?.vol) {
            const r = meta.vol.ratio;
            if (r >= STRATEGY.VOL_MULTIPLIER) warnings.push(`${session.reason} — Volume override: ${r}×`);
            else errors.push(`${session.reason} — Volumen ${r}× (mín ${STRATEGY.VOL_MULTIPLIER}× fuera de sesión)`);
        } else {
            warnings.push(`${session.reason} — Sin datos de volumen`);
        }
    }

    // B. Circuit breaker consecutivo
    const cb = checkStrategyCircuitBreaker();
    checks.circuitBreaker = cb;
    if (cb.triggered) errors.push(cb.reason);
    else if (cb.reason) warnings.push(cb.reason);

    // C. Noticias
    const news = checkStrategyNewsFilter();
    checks.news = news;
    if (news.blocked) errors.push(news.reason);
    if (!news.calendarReady) warnings.push('⚠️ Calendario económico no cargado — filtro de noticias inactivo');

    // D. Límite diario
    const limit = parseFloat(state.profile.daily_loss_limit) || 0;
    if (limit > 0) {
        const now = Date.now();
        const todayPnl = state.closedTrades
            .filter(t => (now - new Date(t.closedAt || 0).getTime()) < 86_400_000)
            .reduce((a, t) => a + (t.pnl || 0), 0);
        checks.dailyLimit = { pnl: todayPnl, limit };
        if (todayPnl <= -Math.abs(limit))
            errors.push(`⛔ Límite diario: P&L hoy $${todayPnl.toFixed(2)} ≤ -$${limit.toFixed(2)}`);
    }

    // E. SL razonable
    const slPct = proposal.stopLoss && proposal.entrada
        ? Math.abs(proposal.entrada - proposal.stopLoss) / proposal.entrada * 100
        : 0;
    checks.slPct = slPct;
    if (slPct > STRATEGY.MAX_SL_PCT)
        warnings.push(`SL amplio: ${slPct.toFixed(2)}% del precio (máx recomendado ${STRATEGY.MAX_SL_PCT}%)`);

    return { ok: errors.length === 0, checks, errors, warnings };
}

/* ═══════════════════════════════════════════════════
   9. PROPOSAL MONEY — sobreescribe calcProposalMoney
   ═══════════════════════════════════════════════════ */

function calcProposalMoney(proposal) {
    const leverage = state.profile.leverage || 1;
    const coin = coinOf(proposal.par);
    const entry = state.prices[coin] || proposal.entrada;
    const equity = getCurrentEquity();
    const riskUSD = equity * STRATEGY.RISK_PCT / 100;

    const size = calcSize(riskUSD, entry, proposal.stopLoss);
    const notional = size * entry;
    const margin = notional / leverage;

    const targets = calcStrategyTargets(entry, proposal.stopLoss, proposal.tipo);
    const tp1 = proposal.tp1 || targets.tp1;
    const tp2 = proposal.tp2 || targets.tp2;

    const { net: tp1Net, fees: tp1Fees } = calcNetPnL({ ...proposal, size, entrada: entry, leverage }, tp1, 'maker');
    const { net: tp2Net } = calcNetPnL({ ...proposal, size, entrada: entry, leverage }, tp2, 'maker');
    const bePrice = calcBreakevenWithFees(entry, proposal.tipo);
    // Estimación total: 50% del TP1 + 50% del TP2
    const maxWin = tp1Net * 0.5 + tp2Net * 0.5;

    const validation = validateStrategyEntry(proposal);
    const warnings = [...validation.errors, ...validation.warnings];
    if (margin > equity * 0.5) warnings.push('⚠️ Posición >50% del equity');
    if (margin > equity) warnings.push('🚨 Margen supera el equity disponible');
    if (leverage > 10) warnings.push(`⚠️ Apalancamiento alto (${leverage}x)`);

    return {
        riskUSD: parseFloat(riskUSD.toFixed(2)),
        riskPct: STRATEGY.RISK_PCT,
        equity: parseFloat(equity.toFixed(2)),
        size: parseFloat(size.toFixed(6)),
        notional: parseFloat(notional.toFixed(2)),
        margin: parseFloat(margin.toFixed(2)),
        capitalPct: parseFloat((margin / equity * 100).toFixed(1)),
        leverage,
        tp1, tp2, bePrice,
        tp1Net: parseFloat(tp1Net.toFixed(2)),
        tp2Net: parseFloat(tp2Net.toFixed(2)),
        tp1Fees: parseFloat(tp1Fees.toFixed(2)),
        maxWin: parseFloat(maxWin.toFixed(2)),
        slDist: parseFloat(Math.abs(entry - proposal.stopLoss).toFixed(6)),
        warnings,
        validation,
    };
}

/* ═══════════════════════════════════════════════════
   10. PANEL DE VALIDACIÓN (UI en modal de confirmación)
   ═══════════════════════════════════════════════════ */

function renderStrategyValidationPanel(validation) {
    if (!validation) return '';
    const { checks } = validation;
    const rows = [];

    if (checks.session) {
        const s = checks.session;
        const ok = s.inSession;
        rows.push({ icon: ok ? '✅' : '⚠️', text: s.reason, color: ok ? 'var(--green)' : 'var(--yellow)' });
    }
    if (checks.circuitBreaker) {
        const cb = checks.circuitBreaker;
        rows.push({
            icon: cb.triggered ? '❌' : cb.losses > 0 ? '⚠️' : '✅',
            text: cb.triggered ? `Circuit breaker: ${cb.losses} pérdidas consecutivas`
                : cb.losses > 0 ? `${cb.losses} pérdida(s) consecutiva(s)` : 'Sin pérdidas consecutivas',
            color: cb.triggered ? 'var(--red)' : cb.losses > 0 ? 'var(--yellow)' : 'var(--green)',
        });
    }
    if (checks.news) {
        const n = checks.news;
        rows.push({
            icon: n.blocked ? '❌' : !n.calendarReady ? '⚠️' : '✅',
            text: n.blocked ? n.reason : !n.calendarReady ? 'Calendario no cargado' : 'Sin noticias de alto impacto',
            color: n.blocked ? 'var(--red)' : !n.calendarReady ? 'var(--yellow)' : 'var(--green)',
        });
    }
    if (checks.slPct !== undefined) {
        const p = checks.slPct;
        rows.push({ icon: p > 5 ? '⚠️' : '✅', text: `SL: ${p.toFixed(2)}% del precio`, color: p > 5 ? 'var(--yellow)' : 'var(--green)' });
    }

    return `
    <div style="background:var(--s2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:12px">
      <div style="font-size:8px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;
                  color:var(--muted);font-family:var(--font-display);margin-bottom:8px">VALIDACIÓN ESTRATEGIA</div>
      ${rows.map(r => `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03)">
          <span style="font-size:12px;width:16px;text-align:center;flex-shrink:0">${r.icon}</span>
          <span style="font-size:11px;color:${r.color}">${r.text}</span>
        </div>`).join('')}
    </div>`;
}

/* ═══════════════════════════════════════════════════
   11. BADGE DE SESIÓN NY (header)
   ═══════════════════════════════════════════════════ */

function updateSessionBadge() {
    const badge = qs('#session-badge');
    if (!badge) return;
    const s = checkNYSession();
    badge.className = `session-badge${s.inSession ? ' active' : ''}`;
    badge.title = s.reason;
    badge.innerHTML = `
    <span class="sb-dot"></span>
    <span style="font-family:var(--font-mono);font-size:9px;font-weight:600;letter-spacing:.5px;text-transform:uppercase">${s.label}</span>
    ${s.minutesLeft ? `<span style="font-size:8px;color:var(--muted)">${s.minutesLeft}m</span>` : ''}`;
}

/* ═══════════════════════════════════════════════════
   12. INIT
   ═══════════════════════════════════════════════════ */

// Badge actualizado en load y cada minuto
updateSessionBadge();
setInterval(updateSessionBadge, 60 * 1000);

// Exponer globalmente
Object.assign(window, {
    STRATEGY,
    getCurrentEquity,
    getDynamicRiskUSD,
    calcSize,
    calcStrategyTargets,
    calcBreakevenWithFees,
    calcNetPnL,
    checkNYSession,
    checkStrategyCircuitBreaker,
    checkStrategyNewsFilter,
    validateStrategyEntry,
    buildTrade,           // sobreescribe la de trading.js
    calcProposalMoney,    // sobreescribe la de trading.js
    renderStrategyValidationPanel,
    updateSessionBadge,
});

console.log(
    '%c[Strategy v3] CARGADO%c | Riesgo: 1% equity | TP1: 1.2:1 | TP2: 2.5:1 | BE: ±0.08% fees | Motor TP/SL: SERVIDOR',
    'background:#00E5A0;color:#000;font-weight:700;padding:2px 6px;border-radius:3px',
    'color:#00E5A0'
);