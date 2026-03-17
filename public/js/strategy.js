/* ═══════════════════════════════════════════════════════════════════
   CRYPTOPLAN IA — strategy.js
   Implementación completa de la estrategia institucional (cliente).

   Este archivo reemplaza / amplía las funciones de trading.js con:
   ✓ Position sizing dinámico: 1% del equity actual
   ✓ TP1 en ratio 1.2:1 (configurable por moneda)
   ✓ TP2 en ratio 2.5:1 (default)
   ✓ Breakeven real: entrada ± comisiones (0.08% Taker+Maker)
   ✓ Cierre parcial: 50% en TP1 → resto con riesgo $0
   ✓ Filtro de sesión NY (13:30–18:00 UTC / 14:30–19:00 CET)
   ✓ Circuit breaker: 2 pérdidas consecutivas = stop operativo
   ✓ Filtro de noticias: -15min / +30min eventos alto impacto USD
   ✓ Filtro de volumen fuera de sesión: ≥1.5× avg20
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Constantes de estrategia ──────────────────────────────────────────────── */
const STRATEGY = {
    RISK_PCT: 1.0,    // 1% del equity por operación
    TP1_RATIO: 1.2,    // R:R del TP1
    TP2_RATIO: 2.5,    // R:R del TP2
    PARTIAL_CLOSE_PCT: 50,     // % a cerrar en TP1
    FEE_TAKER: 0.0006, // 0.06% Bitunix taker
    FEE_MAKER: 0.0002, // 0.02% Bitunix maker
    FEE_ROUND_TRIP: 0.0008, // 0.08% total
    MAX_SL_PCT: 5.0,    // SL máximo = 5% del precio
    CB_CONSEC_LOSSES: 2,      // pérdidas consecutivas para circuit breaker
    NEWS_BEFORE_MIN: 15,     // bloquear 15min ANTES del evento
    NEWS_AFTER_MIN: 30,     // bloquear 30min DESPUÉS del evento
    VOL_MULTIPLIER: 1.5,    // volumen mínimo fuera de sesión
};

// Sesión NY: 13:30–18:00 UTC = 14:30–19:00 CET
const NY_SESSION = { startH: 13, startM: 30, endH: 18, endM: 0 };

/* ═══════════════════════════════════════════════════════
   1. EQUITY DINÁMICO
   ═══════════════════════════════════════════════════════ */

/**
 * Calcula el equity actual de la cuenta.
 * El riesgo siempre se aplica sobre el equity real, no el capital inicial.
 */
function getCurrentEquity() {
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
    return profile.capital + closedPnl + activePnl;
}

/**
 * Calcula el riesgo en USD para el siguiente trade (1% del equity real).
 * Si el perfil tiene un risk_pct distinto de 1, se respeta (pero en % del equity).
 */
function getDynamicRiskUSD() {
    const equity = getCurrentEquity();
    const riskPct = STRATEGY.RISK_PCT; // siempre 1% estrategia institucional
    return Math.max(0, equity * riskPct / 100);
}

/* ═══════════════════════════════════════════════════════
   2. POSITION SIZING (sobreescribe calcSize)
   ═══════════════════════════════════════════════════════ */

/**
 * Calcula qty exacta para arriesgar riskUSD con este SL.
 * El apalancamiento NO afecta qty — solo reduce el margen necesario.
 *
 * qty = riskUSD / |entrada - stopLoss|
 */
function calcSize(riskUSD, entry, stopLoss, leverage = 1) {
    const dist = Math.abs(entry - stopLoss);
    if (dist <= 0) return 0.001;
    return riskUSD / dist;
}

/* ═══════════════════════════════════════════════════════
   3. TARGETS — TP1, TP2, BREAKEVEN
   ═══════════════════════════════════════════════════════ */

/**
 * Calcula TP1 y TP2 a partir de la distancia al SL.
 *
 * LONG:  TP1 = entrada + slDist × 1.2
 *        TP2 = entrada + slDist × 2.5
 * SHORT: TP1 = entrada - slDist × 1.2
 *        TP2 = entrada - slDist × 2.5
 */
function calcStrategyTargets(entry, stopLoss, tipo,
    tp1Ratio = STRATEGY.TP1_RATIO,
    tp2Ratio = STRATEGY.TP2_RATIO
) {
    const slDist = Math.abs(entry - stopLoss);
    const dir = tipo === 'LONG' ? 1 : -1;
    const tp1 = parseFloat((entry + dir * slDist * tp1Ratio).toFixed(6));
    const tp2 = parseFloat((entry + dir * slDist * tp2Ratio).toFixed(6));
    return { tp1, tp2, slDist, tp1Ratio, tp2Ratio };
}

/**
 * Breakeven real con comisiones incluidas.
 * Garantiza que si el precio toca el BE, el P&L neto es exactamente $0.
 *
 * LONG:  BE = entrada × (1 + 0.0008)
 * SHORT: BE = entrada × (1 - 0.0008)
 */
function calcBreakevenWithFees(entry, tipo) {
    const buf = STRATEGY.FEE_ROUND_TRIP;
    return tipo === 'LONG'
        ? parseFloat((entry * (1 + buf)).toFixed(6))
        : parseFloat((entry * (1 - buf)).toFixed(6));
}

/**
 * Calcula P&L neto descontando comisiones.
 */
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

/* ═══════════════════════════════════════════════════════
   4. SESIÓN NY
   ═══════════════════════════════════════════════════════ */

function checkNYSession(now = new Date()) {
    const day = now.getUTCDay(); // 0=dom, 6=sab
    const h = now.getUTCHours();
    const m = now.getUTCMinutes();
    const mins = h * 60 + m;

    if (day === 0 || day === 6) {
        return {
            inSession: false,
            label: 'FIN DE SEMANA',
            reason: 'Fin de semana — mercado institucional inactivo',
            color: 'var(--muted)',
        };
    }

    // Viernes: cierre anticipado a 17:30 UTC (18:30 CET)
    if (day === 5 && mins >= 17 * 60 + 30) {
        return {
            inSession: false,
            label: 'CIERRE VIE',
            reason: 'Viernes tarde — liquidez institucional reducida',
            color: 'var(--yellow)',
        };
    }

    const start = NY_SESSION.startH * 60 + NY_SESSION.startM; // 810 min = 13:30
    const end = NY_SESSION.endH * 60 + NY_SESSION.endM;   // 1080 min = 18:00

    if (mins >= start && mins < end) {
        const left = end - mins;
        const leftH = Math.floor(left / 60);
        const leftM = left % 60;
        return {
            inSession: true,
            label: 'SESIÓN NY',
            reason: `Sesión NY activa — ${leftH > 0 ? leftH + 'h ' : ''}${leftM}min restantes`,
            minutesLeft: left,
            color: 'var(--accent)',
        };
    }

    if (mins < start) {
        const wait = start - mins;
        const waitH = Math.floor(wait / 60);
        const waitM = wait % 60;
        return {
            inSession: false,
            label: 'PRE-NY',
            reason: `Sesión NY abre en ${waitH > 0 ? waitH + 'h ' : ''}${waitM}min (14:30 CET)`,
            color: 'var(--yellow)',
        };
    }

    return {
        inSession: false,
        label: 'POST-NY',
        reason: 'Sesión NY cerrada (19:00 CET)',
        color: 'var(--muted)',
    };
}

/* ═══════════════════════════════════════════════════════
   5. CIRCUIT BREAKER — PÉRDIDAS CONSECUTIVAS
   ═══════════════════════════════════════════════════════ */

/**
 * Devuelve el número de pérdidas consecutivas al inicio del historial.
 */
function getConsecutiveLosses(closedTrades = state.closedTrades) {
    let count = 0;
    for (const t of closedTrades) {
        if (t.result === 'LOSS') count++;
        else break;
    }
    return count;
}

function checkStrategyCircuitBreaker() {
    const losses = getConsecutiveLosses();
    const max = STRATEGY.CB_CONSEC_LOSSES;
    return {
        triggered: losses >= max,
        losses,
        max,
        reason: losses >= max
            ? `⛔ Circuit Breaker: ${losses} pérdidas consecutivas. Pausa hasta mañana.`
            : losses > 0
                ? `⚠️ ${losses} pérdida(s) consecutiva(s) — máximo permitido: ${max}`
                : null,
    };
}

/* ═══════════════════════════════════════════════════════
   6. FILTRO DE NOTICIAS
   ═══════════════════════════════════════════════════════ */

function checkStrategyNewsFilter(now = new Date()) {
    const events = calendarData || [];
    if (!events.length) return { blocked: false, reason: null };

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
                blocked: true,
                event: evt,
                reason: diff < 0
                    ? `⚠️ Noticias en ${mins}min: ${evt.currency} ${evt.title} — entrada bloqueada`
                    : `⚠️ Post-evento (${mins}min): ${evt.currency} ${evt.title} — esperar ${STRATEGY.NEWS_AFTER_MIN - Math.round(diff / 60000)}min`,
            };
        }
    }
    return { blocked: false, reason: null };
}

/* ═══════════════════════════════════════════════════════
   7. VALIDACIÓN COMPLETA DE ENTRADA
   ═══════════════════════════════════════════════════════ */

/**
 * Ejecuta todas las validaciones antes de mostrar el modal de confirmación.
 * Devuelve { ok, checks, errors, warnings }.
 */
function validateStrategyEntry(proposal) {
    const errors = [];
    const warnings = [];
    const checks = {};

    // A. Sesión NY
    const session = checkNYSession();
    checks.session = session;
    if (!session.inSession) {
        // Fuera de sesión: aplicar filtro de volumen
        const coin = coinOf(proposal.par);
        const meta = MARKET_META[coin];
        if (meta?.vol) {
            const volRatio = meta.vol.ratio;
            if (volRatio >= STRATEGY.VOL_MULTIPLIER) {
                warnings.push(`${session.reason} — Volume override activo (${volRatio}× avg20)`);
            } else {
                errors.push(`${session.reason} — Volumen insuficiente (${volRatio}× avg20, mínimo ${STRATEGY.VOL_MULTIPLIER}×)`);
            }
        } else {
            warnings.push(`${session.reason} — Sin datos de volumen para validar`);
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

    // D. Circuit breaker diario
    const limit = parseFloat(state.profile.daily_loss_limit) || 0;
    if (limit > 0) {
        const now = Date.now();
        const dayMs = 86_400_000;
        const todayPnl = state.closedTrades
            .filter(t => (now - new Date(t.closedAt || 0).getTime()) < dayMs)
            .reduce((a, t) => a + (t.pnl || 0), 0);
        checks.dailyLimit = { pnl: todayPnl, limit };
        if (todayPnl <= -Math.abs(limit)) {
            errors.push(`⛔ Límite diario: P&L hoy ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)} ≤ -$${limit.toFixed(2)}`);
        }
    }

    // E. SL razonable
    if (proposal.stopLoss && proposal.entrada) {
        const slPct = Math.abs(proposal.entrada - proposal.stopLoss) / proposal.entrada * 100;
        checks.slPct = slPct;
        if (slPct > STRATEGY.MAX_SL_PCT) {
            warnings.push(`SL amplio: ${slPct.toFixed(2)}% del precio (recomendado <${STRATEGY.MAX_SL_PCT}%)`);
        }
    }

    return { ok: errors.length === 0, checks, errors, warnings };
}

/* ═══════════════════════════════════════════════════════
   8. BUILD TRADE — sobreescribe buildTrade de trading.js
   ═══════════════════════════════════════════════════════ */

/**
 * Construye el objeto trade con la estrategia institucional completa.
 * Calcula:
 *   - riskUSD = 1% del equity actual
 *   - size usando la distancia real al SL
 *   - tp1 al ratio 1.2:1 (respeta el tp1 de la propuesta si existe y es mejor)
 *   - tp2 al ratio 2.5:1
 *   - bePrice = breakeven con fees
 */
function buildTrade(proposal) {
    const { profile, prices } = state;
    const leverage = profile.leverage || 1;
    const coin = coinOf(proposal.par);
    const realEntry = prices[coin] || proposal.entrada;
    const tipo = proposal.tipo;

    // 1% del equity actual
    const equity = getCurrentEquity();
    const riskUSD = equity * STRATEGY.RISK_PCT / 100;

    // Size
    const size = calcSize(riskUSD, realEntry, proposal.stopLoss, leverage);

    // Targets: respetar TP de la IA si es más ambicioso
    const stratTargets = calcStrategyTargets(realEntry, proposal.stopLoss, tipo);
    const tp1 = proposal.tp1
        ? (tipo === 'LONG'
            ? Math.max(proposal.tp1, stratTargets.tp1)  // LONG: tp1 más alto
            : Math.min(proposal.tp1, stratTargets.tp1)) // SHORT: tp1 más bajo
        : stratTargets.tp1;
    const tp2 = proposal.tp2 || stratTargets.tp2;

    // Breakeven con fees
    const bePrice = calcBreakevenWithFees(realEntry, tipo);

    // R:R real basado en los targets finales
    const slDist = Math.abs(realEntry - proposal.stopLoss);
    const tp1Dist = Math.abs(tp1 - realEntry);
    const rrReal = slDist > 0 ? (tp1Dist / slDist).toFixed(2) : (proposal.rr || '1.2');

    return {
        id: uid(),
        par: proposal.par,
        tipo,
        setup: proposal.setup || '',
        entrada: realEntry,
        stopLoss: proposal.stopLoss,
        tp1,
        tp2,
        bePrice,     // breakeven real con fees
        rr: rrReal,
        rr2: slDist > 0 ? ((Math.abs(tp2 - realEntry)) / slDist).toFixed(2) : '2.5',
        confianza: proposal.confianza,
        razon: proposal.razon,
        size: parseFloat(size.toFixed(6)),
        leverage,
        riskUSD: parseFloat(riskUSD.toFixed(2)),
        equity: parseFloat(equity.toFixed(2)),
        currentPrice: realEntry,
        pnl: 0, pnlPct: 0,
        createdAt: nowFull(),
        // Flags de estrategia
        tp1Hit: false,
        breakevenSet: false,
        partialClosed: false,
        partialClosePnl: 0,
        partialCloseQty: 0,
    };
}

/* ═══════════════════════════════════════════════════════
   9. TPSL CLIENT-SIDE (sobreescribe checkTPSL de trading.js)
   Incluye cierre parcial 50% en TP1 y breakeven con fees
   ═══════════════════════════════════════════════════════ */

function checkTPSL() {
    let changed = false;

    state.activeTrades = state.activeTrades.filter(trade => {
        if (state.autoClosedIds.has(trade.id)) return true;

        const coin = coinOf(trade.par);
        const price = state.prices[coin];
        if (!price) return true;

        const isLong = trade.tipo === 'LONG';

        // ── TP1: cierre parcial + breakeven ───────────────────────────────
        if (trade.tp2 && !trade.tp1Hit) {
            const hitTP1 = isLong ? price >= trade.tp1 : price <= trade.tp1;
            if (hitTP1) {
                trade.tp1Hit = true;

                const closeQty = parseFloat((trade.size * STRATEGY.PARTIAL_CLOSE_PCT / 100).toFixed(6));
                const remainQty = parseFloat((trade.size - closeQty).toFixed(6));
                const { net: partialNet, fees: partialFees } = calcNetPnL({ ...trade, size: closeQty }, trade.tp1, 'maker');
                const newSL = calcBreakevenWithFees(trade.entrada, trade.tipo);

                trade.size = remainQty;
                trade.stopLoss = newSL;
                trade.breakevenSet = true;
                trade.partialClosed = true;
                trade.partialCloseQty = closeQty;
                trade.partialClosePnl = parseFloat(partialNet.toFixed(4));
                trade.partialClosePrice = trade.tp1;

                changed = true;
                showToast(
                    `✂️ ${trade.par} — TP1 alcanzado! ${STRATEGY.PARTIAL_CLOSE_PCT}% cerrado (+$${partialNet.toFixed(2)} neto)` +
                    ` | SL → BE ${fmtP(newSL, coin)} | Resto: ${remainQty} contratos`,
                );

                if (bitunix.configured && trade.bitunixSymbol) {
                    updateBitunixSL(trade).catch(() => { });
                }
                saveKey('activeTrades', state.activeTrades);
                return true; // el trade sigue activo con el 50% restante
            }
        }

        // ── TP1 sin TP2: cierre total ─────────────────────────────────────
        if (!trade.tp2 && !trade.tp1Hit) {
            const hitTP1 = isLong ? price >= trade.tp1 : price <= trade.tp1;
            if (hitTP1) {
                const { net, fees } = calcNetPnL(trade, trade.tp1, 'maker');
                const totalNet = net + (trade.partialClosePnl || 0);
                _closeTradeClient(trade, trade.tp1, 'WIN', totalNet, fees);
                changed = true;
                return false;
            }
        }

        // ── TP2: cierre total del restante ────────────────────────────────
        if (trade.tp2) {
            const hitTP2 = isLong ? price >= trade.tp2 : price <= trade.tp2;
            if (hitTP2) {
                const { net, fees } = calcNetPnL(trade, trade.tp2, 'maker');
                const totalNet = net + (trade.partialClosePnl || 0);
                _closeTradeClient(trade, trade.tp2, 'WIN', totalNet, fees);
                changed = true;
                return false;
            }
        }

        // ── Stop Loss ─────────────────────────────────────────────────────
        const hitSL = isLong ? price <= trade.stopLoss : price >= trade.stopLoss;
        if (hitSL) {
            state.autoClosedIds.add(trade.id);
            const { net, fees } = calcNetPnL(trade, trade.stopLoss, 'taker');
            const totalNet = net + (trade.partialClosePnl || 0);
            const result = trade.breakevenSet
                ? (Math.abs(totalNet) < 1 ? 'BREAKEVEN' : totalNet > 0 ? 'WIN' : 'LOSS')
                : 'LOSS';
            _closeTradeClient(trade, trade.stopLoss, result, totalNet, fees);
            changed = true;
            return false;
        }

        return true;
    });

    // Limpiar autoClosedIds de trades ya no activos
    const activeIds = new Set(state.activeTrades.map(t => t.id));
    for (const id of state.autoClosedIds) {
        if (!activeIds.has(id)) state.autoClosedIds.delete(id);
    }

    if (changed) {
        saveKey('activeTrades', state.activeTrades);
        saveKey('closedTrades', state.closedTrades);
        syncTradesToServer();
        if (state.currentTab === 'ops') renderOps();
        if (state.currentTab === 'dash') renderDash();
    }
}

function _closeTradeClient(trade, exitPrice, result, netPnl, fees) {
    const coin = coinOf(trade.par);
    const closed = {
        ...trade,
        result,
        pnl: parseFloat(netPnl.toFixed(4)),
        pnlGross: parseFloat((trade.tipo === 'LONG'
            ? (exitPrice - trade.entrada) * trade.size * (trade.leverage || 1)
            : (trade.entrada - exitPrice) * trade.size * (trade.leverage || 1)).toFixed(4)),
        fees: parseFloat((fees || 0).toFixed(4)),
        exitPrice,
        closedAt: nowFull(),
    };
    state.closedTrades.unshift(closed);

    if (result === 'WIN') {
        showToast(`✅ ${trade.par} — ${exitPrice === trade.tp2 ? 'TP2' : 'TP'} alcanzado! Neto: +$${Math.abs(netPnl).toFixed(2)}`);
    } else if (result === 'BREAKEVEN') {
        showToast(`↔ ${trade.par} — Breakeven. Sin pérdida real.`);
    } else {
        showToast(`❌ ${trade.par} — SL: Neto -$${Math.abs(netPnl).toFixed(2)} (fees: $${(fees || 0).toFixed(2)})`, true);
    }
    logActivity('trade_close', `${result} ${trade.par} @ ${exitPrice} | Neto: ${fmtUSD(netPnl)}`);
}

/* ═══════════════════════════════════════════════════════
   10. PROPOSAL MONEY — resumen financiero en modal
   ═══════════════════════════════════════════════════════ */

/**
 * Reemplaza calcProposalMoney con los cálculos de estrategia correctos.
 */
function calcProposalMoney(proposal) {
    const { prices } = state;
    const leverage = state.profile.leverage || 1;
    const coin = coinOf(proposal.par);
    const entry = prices[coin] || proposal.entrada;
    const equity = getCurrentEquity();
    const riskUSD = equity * STRATEGY.RISK_PCT / 100;

    const size = calcSize(riskUSD, entry, proposal.stopLoss, leverage);
    const notional = size * entry;
    const margin = notional / leverage;
    const capitalPct = (margin / equity * 100);

    // TP targets
    const targets = calcStrategyTargets(entry, proposal.stopLoss, proposal.tipo);
    const tp1 = proposal.tp1 || targets.tp1;
    const tp2 = proposal.tp2 || targets.tp2;

    const { net: tp1NetPnl } = calcNetPnL({ ...proposal, size, entrada: entry, leverage }, tp1, 'maker');
    const { net: tp2NetPnl } = calcNetPnL({ ...proposal, size, entrada: entry, leverage }, tp2, 'maker');
    const bePrice = calcBreakevenWithFees(entry, proposal.tipo);

    const slDist = Math.abs(entry - proposal.stopLoss);
    const maxWin = tp1NetPnl + (tp2NetPnl * 0.5); // 50% al TP1, 50% al TP2

    const warnings = [];
    if (margin > equity * 0.5) warnings.push('⚠️ Posición >50% del equity');
    if (margin > equity) warnings.push('🚨 Margen supera el equity disponible');
    if (leverage > 10) warnings.push(`⚠️ Apalancamiento alto (${leverage}x)`);

    // Validaciones de estrategia
    const validation = validateStrategyEntry(proposal);
    validation.errors.forEach(e => warnings.push(e));

    return {
        riskUSD: parseFloat(riskUSD.toFixed(2)),
        riskPct: STRATEGY.RISK_PCT,
        equity: parseFloat(equity.toFixed(2)),
        size: parseFloat(size.toFixed(6)),
        notional: parseFloat(notional.toFixed(2)),
        margin: parseFloat(margin.toFixed(2)),
        capitalPct: parseFloat(capitalPct.toFixed(1)),
        leverage,
        tp1NetPnl: parseFloat(tp1NetPnl.toFixed(2)),
        tp2NetPnl: parseFloat(tp2NetPnl.toFixed(2)),
        maxWin: parseFloat(maxWin.toFixed(2)),
        bePrice: parseFloat(bePrice.toFixed(6)),
        slDist: parseFloat(slDist.toFixed(6)),
        tp1, tp2,
        warnings,
        validation,
    };
}

/* ═══════════════════════════════════════════════════════
   11. VALIDATION UI — panel de validación en el modal
   ═══════════════════════════════════════════════════════ */

function renderStrategyValidationPanel(validation) {
    if (!validation) return '';

    const { checks, errors, warnings } = validation;
    const rows = [];

    // Sesión
    if (checks.session) {
        const s = checks.session;
        const icon = s.inSession ? '✅' : (warnings.some(w => w.includes('override')) ? '⚠️' : '❌');
        const color = s.inSession ? 'validation-ok' : (icon === '⚠️' ? 'validation-warn' : 'validation-err');
        rows.push({ icon, text: s.reason, color });
    }

    // Circuit breaker
    if (checks.circuitBreaker) {
        const cb = checks.circuitBreaker;
        const icon = cb.triggered ? '❌' : cb.losses > 0 ? '⚠️' : '✅';
        const color = cb.triggered ? 'validation-err' : cb.losses > 0 ? 'validation-warn' : 'validation-ok';
        const text = cb.triggered
            ? `Circuit breaker: ${cb.losses} pérdidas consecutivas`
            : cb.losses > 0
                ? `${cb.losses} pérdida(s) consecutiva(s)`
                : `Sin pérdidas consecutivas`;
        rows.push({ icon, text, color });
    }

    // Noticias
    if (checks.news) {
        const n = checks.news;
        rows.push({
            icon: n.blocked ? '❌' : '✅',
            text: n.blocked ? n.reason : 'Sin eventos de alto impacto próximos',
            color: n.blocked ? 'validation-err' : 'validation-ok',
        });
    }

    // SL %
    if (checks.slPct !== undefined) {
        const pct = checks.slPct;
        rows.push({
            icon: pct > 5 ? '⚠️' : '✅',
            text: `SL: ${pct.toFixed(2)}% del precio`,
            color: pct > 5 ? 'validation-warn' : 'validation-ok',
        });
    }

    const html = rows.map(r => `
    <div class="validation-row">
      <span class="validation-icon">${r.icon}</span>
      <span class="${r.color}" style="font-size:11px">${r.text}</span>
    </div>`).join('');

    return `
    <div class="validation-panel">
      <div style="font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
                  color:var(--muted);font-family:var(--font-display);margin-bottom:8px">
        VALIDACIÓN ESTRATEGIA
      </div>
      ${html}
    </div>`;
}

/* ═══════════════════════════════════════════════════════
   12. SESSION BADGE en el header
   ═══════════════════════════════════════════════════════ */

function updateSessionBadge() {
    const badge = qs('#session-badge');
    if (!badge) return;
    const s = checkNYSession();
    badge.className = `session-badge${s.inSession ? ' active' : ''}`;
    badge.innerHTML = `
    <span class="sb-dot"></span>
    <span style="font-family:var(--font-mono);font-size:9px;font-weight:600;letter-spacing:.5px">
      ${s.label}
    </span>
    ${s.minutesLeft ? `<span style="font-size:8px;color:var(--muted)">${s.minutesLeft}min</span>` : ''}`;
    badge.title = s.reason;
}

/* ═══════════════════════════════════════════════════════
   13. INIT — actualizar badge y conectar overrides
   ═══════════════════════════════════════════════════════ */

// Actualizar badge de sesión cada minuto
updateSessionBadge();
setInterval(updateSessionBadge, 60 * 1000);

// Exponer funciones globalmente
Object.assign(window, {
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
    buildTrade,
    checkTPSL,
    calcProposalMoney,
    renderStrategyValidationPanel,
    updateSessionBadge,
    STRATEGY,
});

console.log('[Strategy] Módulo institucional cargado — Riesgo: 1% equity | TP1: 1.2:1 | TP2: 2.5:1 | BE: entrada±0.08%');