/* ═══════════════════════════════════════════════════════════════════
   CRYPTOPLAN IA — backtester.js v2.0
   Alineado 100% con la estrategia real:
   ✓ Sesión NY (14:30–21:00 hora española, UTC+1/+2)
   ✓ Filtro de volumen (ratio > 1.0× media 20 velas)
   ✓ Circuit breaker (para tras 2 pérdidas consecutivas)
   ✓ RSI 35/65 + EMA200 + EMA20>EMA50 + ATR SL
   ✓ TP1 50% cierre parcial + breakeven real
   ✓ TP2 cierre total + R:R mínimo 2.0
   ✓ Riesgo dinámico 1% capital
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const BT = {
  TP1_RATIO: 1.2,
  TP2_RATIO: 2.5,
  PARTIAL_PCT: 0.5,
  ATR_SL_MULT: 1.5,
  MIN_RR: 2.0,
  FEE_TAKER: 0.0006,
  FEE_MAKER: 0.0002,
  RSI_OVERSOLD: 38,
  RSI_OVERBOUGHT: 62,
  EMA_FAST: 20,
  EMA_SLOW: 50,
  EMA_TREND: 200,
  RSI_PERIOD: 14,
  ATR_PERIOD: 14,
  MIN_CANDLES: 220,
  // Nuevos filtros estrategia real
  VOL_MA_PERIOD: 20,     // media de volumen para ratio
  VOL_MIN_RATIO: 1.0,    // volumen mínimo vs media
  MAX_CONSEC_LOSSES: 2,      // circuit breaker
  // Sesión NY en UTC (hora española -1 en invierno, -2 en verano)
  NY_OPEN_UTC: 13,     // 14:30 ES invierno ≈ 13:30 UTC → usamos 13h
  NY_CLOSE_UTC: 20,     // 21:00 ES ≈ 20:00 UTC
};

/* ── Indicadores — arrays completos en O(n) ─────────────────────────────── */

function _btRsiArray(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function _btEmaArray(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function _btAtrArray(highs, lows, closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  out[period] = sum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

/* ── Media móvil simple de volumen ─────────────────────────────────────── */
function _btVolMaArray(volumes, period) {
  const out = new Array(volumes.length).fill(null);
  for (let i = period - 1; i < volumes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += volumes[j];
    out[i] = sum / period;
  }
  return out;
}

/* ── Filtro sesión NY ───────────────────────────────────────────────────── */
// Comprueba si la vela SOLAPA con la sesión NY (13:30–20:00 UTC)
// en lugar de si simplemente abre dentro de ella.
// Esto es correcto: una vela 4H que abre a las 12:00 UTC cubre hasta
// las 16:00 UTC, solapando completamente con la apertura de NY.
//
// Duración de vela por timeframe (minutos):
//   1h → 60 min  |  4h → 240 min  |  1d → siempre válida
//
// Lógica de solapamiento: la vela [open, open+dur) solapa con [nyOpen, nyClose)
// si  open < nyClose  &&  open + dur > nyOpen
function _isNYSession(timestampMs, interval) {
  if (interval === '1d') return true;

  const durMin = interval === '4h' ? 240 : 60; // minutos de la vela
  const d = new Date(timestampMs);
  const candleOpenMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const candleCloseMin = candleOpenMin + durMin;

  // NY: 13:30–20:00 UTC
  const nyOpen = BT.NY_OPEN_UTC * 60 + 30; // 810 min
  const nyClose = BT.NY_CLOSE_UTC * 60;      // 1200 min

  // Solapamiento: la vela toca la sesión NY si su cierre supera nyOpen
  // y su apertura es anterior a nyClose
  return candleCloseMin > nyOpen && candleOpenMin < nyClose;
}

/* ── Descarga Binance con validación ────────────────────────────────────── */
async function btFetchKlines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.msg || msg; } catch { }
    throw new Error(`Binance error para ${symbol}: ${msg}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error(`Respuesta inesperada de Binance: ${JSON.stringify(raw).slice(0, 100)}`);
  }
  return raw.map(k => ({
    t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]),
    l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
  }));
}

/* ── Motor principal O(n) — alineado con estrategia real ───────────────── */
async function runBacktest(coin, interval, riskUSD, limit, useNYFilter, useVolFilter, useCB) {
  if (!limit) limit = 500;

  // Flags de filtros (por defecto activados — coinciden con la estrategia real)
  if (useNYFilter === undefined) useNYFilter = (interval !== '1d');
  if (useVolFilter === undefined) useVolFilter = true;
  if (useCB === undefined) useCB = true;

  const candles = await btFetchKlines(coin.toUpperCase(), interval, Math.min(limit + BT.MIN_CANDLES, 1000));
  if (!Array.isArray(candles) || candles.length < BT.MIN_CANDLES + 10) {
    throw new Error(`Datos insuficientes: ${candles?.length ?? 0} velas (mínimo ${BT.MIN_CANDLES + 10})`);
  }

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const volumes = candles.map(c => c.v);

  // Precomputar todos los indicadores UNA sola vez — O(n)
  const rsiArr = _btRsiArray(closes, BT.RSI_PERIOD);
  const ema20 = _btEmaArray(closes, BT.EMA_FAST);
  const ema50 = _btEmaArray(closes, BT.EMA_SLOW);
  const ema200 = _btEmaArray(closes, BT.EMA_TREND);
  const atrArr = _btAtrArray(highs, lows, closes, BT.ATR_PERIOD);
  const volMaArr = _btVolMaArray(volumes, BT.VOL_MA_PERIOD);

  const trades = [];
  let openTrade = null;
  let equity = 0;
  let consecLosses = 0; // circuit breaker

  // Contadores de filtros rechazados (para diagnóstico)
  const rejected = { ny: 0, vol: 0, cb: 0, rr: 0, indicator: 0 };

  for (let i = BT.MIN_CANDLES; i < candles.length - 1; i++) {
    const bar = candles[i];

    // ── Gestión de trade abierto ────────────────────────────────────────
    if (openTrade) {
      const { tipo, entrada, tp1, tp2, size } = openTrade;
      if (tipo === 'LONG') {
        if (!openTrade.tp1Hit && bar.h >= tp1) {
          const q = size * BT.PARTIAL_PCT;
          const p = (tp1 - entrada) * q - tp1 * q * BT.FEE_MAKER;
          openTrade.tp1Hit = true;
          openTrade.size = size * 0.5;
          openTrade.stopLoss = entrada; // breakeven real
          openTrade.tp1PnL = p;
          equity += p;
          continue;
        }
        if (openTrade.tp1Hit && bar.h >= tp2) {
          const q = openTrade.size;
          const p = (tp2 - entrada) * q - tp2 * q * BT.FEE_MAKER;
          const totalPnl = (openTrade.tp1PnL || 0) + p;
          trades.push({ ...openTrade, result: 'WIN', pnl: parseFloat(totalPnl.toFixed(4)), exit: tp2 });
          equity += p;
          consecLosses = 0;
          openTrade = null;
          continue;
        }
        if (bar.l <= openTrade.stopLoss) {
          const q = openTrade.size;
          const p = (openTrade.stopLoss - entrada) * q - openTrade.stopLoss * q * BT.FEE_TAKER;
          const totalPnl = (openTrade.tp1PnL || 0) + p;
          const result = openTrade.tp1Hit ? 'BREAKEVEN' : 'LOSS';
          trades.push({ ...openTrade, result, pnl: parseFloat(totalPnl.toFixed(4)), exit: openTrade.stopLoss });
          equity += p;
          if (result === 'LOSS') consecLosses++; else consecLosses = 0;
          openTrade = null;
          continue;
        }
      } else { // SHORT
        if (!openTrade.tp1Hit && bar.l <= tp1) {
          const q = size * BT.PARTIAL_PCT;
          const p = (entrada - tp1) * q - tp1 * q * BT.FEE_MAKER;
          openTrade.tp1Hit = true;
          openTrade.size = size * 0.5;
          openTrade.stopLoss = entrada;
          openTrade.tp1PnL = p;
          equity += p;
          continue;
        }
        if (openTrade.tp1Hit && bar.l <= tp2) {
          const q = openTrade.size;
          const p = (entrada - tp2) * q - tp2 * q * BT.FEE_MAKER;
          const totalPnl = (openTrade.tp1PnL || 0) + p;
          trades.push({ ...openTrade, result: 'WIN', pnl: parseFloat(totalPnl.toFixed(4)), exit: tp2 });
          equity += p;
          consecLosses = 0;
          openTrade = null;
          continue;
        }
        if (bar.h >= openTrade.stopLoss) {
          const q = openTrade.size;
          const p = (entrada - openTrade.stopLoss) * q - openTrade.stopLoss * q * BT.FEE_TAKER;
          const totalPnl = (openTrade.tp1PnL || 0) + p;
          const result = openTrade.tp1Hit ? 'BREAKEVEN' : 'LOSS';
          trades.push({ ...openTrade, result, pnl: parseFloat(totalPnl.toFixed(4)), exit: openTrade.stopLoss });
          equity += p;
          if (result === 'LOSS') consecLosses++; else consecLosses = 0;
          openTrade = null;
          continue;
        }
      }
      continue;
    }

    // ── Indicadores base ────────────────────────────────────────────────
    const rsi = rsiArr[i];
    const e200 = ema200[i];
    const e50 = ema50[i];
    const e20 = ema20[i];
    const atr = atrArr[i];
    const volMa = volMaArr[i];
    if (rsi === null || e200 === null || e50 === null || e20 === null || atr === null || atr <= 0) {
      rejected.indicator++;
      continue;
    }

    // ── FILTRO 1: Circuit breaker — 2 pérdidas consecutivas ────────────
    if (useCB && consecLosses >= BT.MAX_CONSEC_LOSSES) {
      rejected.cb++;
      continue;
    }

    // ── FILTRO 2: Sesión NY ─────────────────────────────────────────────
    if (useNYFilter && !_isNYSession(bar.t, interval)) {
      rejected.ny++;
      continue;
    }

    // ── FILTRO 3: Volumen mínimo ────────────────────────────────────────
    if (useVolFilter && volMa !== null && volumes[i] < volMa * BT.VOL_MIN_RATIO) {
      rejected.vol++;
      continue;
    }

    // ── Señal de entrada ────────────────────────────────────────────────
    const price = closes[i];
    let tipo = null;
    if (rsi <= BT.RSI_OVERSOLD && price > e200 && e20 > e50) tipo = 'LONG';
    if (rsi >= BT.RSI_OVERBOUGHT && price < e200 && e20 < e50) tipo = 'SHORT';
    if (!tipo) continue;

    const slDist = atr * BT.ATR_SL_MULT;
    if (slDist <= 0) continue;

    const entrada = price;
    const stopLoss = tipo === 'LONG' ? entrada - slDist : entrada + slDist;
    const tp1 = tipo === 'LONG' ? entrada + slDist * BT.TP1_RATIO : entrada - slDist * BT.TP1_RATIO;
    const tp2 = tipo === 'LONG' ? entrada + slDist * BT.TP2_RATIO : entrada - slDist * BT.TP2_RATIO;

    // ── FILTRO 4: R:R mínimo 2.0 ───────────────────────────────────────
    if (Math.abs(tp1 - entrada) / slDist < BT.MIN_RR) {
      rejected.rr++;
      continue;
    }

    const size = riskUSD / slDist;
    equity -= entrada * size * BT.FEE_TAKER;
    openTrade = {
      coin, tipo, entrada, stopLoss, tp1, tp2, size, riskUSD,
      rr: (Math.abs(tp1 - entrada) / slDist).toFixed(2),
      tp1Hit: false,
      tp1PnL: 0,
      rsi: Math.round(rsi),
      atr: parseFloat(atr.toFixed(4)),
      volRatio: volMa ? parseFloat((volumes[i] / volMa).toFixed(2)) : null,
      inNY: _isNYSession(bar.t, interval),
      entryBar: i,
      entryDate: new Date(candles[i].t).toLocaleDateString('es-ES'),
    };
  }

  // ── Estadísticas ────────────────────────────────────────────────────
  const t = Array.isArray(trades) ? trades : [];
  const wins = t.filter(x => x.result === 'WIN').length;
  const losses = t.filter(x => x.result === 'LOSS').length;
  const bes = t.filter(x => x.result === 'BREAKEVEN').length;
  const totalPnl = t.reduce((a, x) => a + (x.pnl || 0), 0);
  const avgWin = wins > 0 ? t.filter(x => x.result === 'WIN').reduce((a, x) => a + x.pnl, 0) / wins : 0;
  const avgLoss = losses > 0 ? Math.abs(t.filter(x => x.result === 'LOSS').reduce((a, x) => a + x.pnl, 0) / losses) : 0;
  const pf = avgLoss > 0 && losses > 0 ? (avgWin * wins) / (avgLoss * losses) : wins > 0 ? 99 : 0;

  let cumPnl = 0, peak = 0, maxDD = 0;
  const equityCurve = t.map(x => {
    cumPnl += x.pnl || 0;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
    return { date: x.entryDate, cumPnl: parseFloat(cumPnl.toFixed(2)), result: x.result };
  });

  return {
    coin, interval,
    totalTrades: t.length,
    wins, losses,
    breakevens: bes,
    winRate: parseFloat((t.length > 0 ? wins / t.length * 100 : 0).toFixed(1)),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    profitFactor: parseFloat(Math.min(pf, 99).toFixed(2)),
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
    trades: t,
    equityCurve,
    rejected,       // para diagnóstico en UI
    filtersUsed: { useNYFilter, useVolFilter, useCB },
  };
}

/* ── UI ─────────────────────────────────────────────────────────────────── */
function renderBacktester() {
  const root = qs('#sec-backtest');
  if (!root) return;
  const riskUSD = typeof getDynamicRiskUSD === 'function' ? getDynamicRiskUSD() : 0;
  root.innerHTML = `
    <div style="padding:0 0 24px">
      <div class="sec-hdr">
        <div>
          <div class="stl" style="margin:0 0 6px">📊 Backtester de Estrategia</div>
          <div style="font-size:11px;color:var(--muted)">Simula la estrategia real (EMA200 + RSI + ATR + Sesión NY + Volumen + Circuit Breaker) sobre datos históricos de Binance.</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px;align-items:end">
          <div><div class="lbl">Par</div>
            <select class="inp" id="bt-coin">
              ${(state.watchedCoins || ['BTC', 'ETH', 'SOL']).map(c => `<option value="${c}">${c}/USDT</option>`).join('')}
            </select></div>
          <div><div class="lbl">Timeframe</div>
            <select class="inp" id="bt-interval">
              <option value="1h">1H</option>
              <option value="4h" selected>4H ★</option>
              <option value="1d">1D</option>
            </select></div>
          <div><div class="lbl">Periodo</div>
            <select class="inp" id="bt-limit">
              <option value="300">Corto (~50d)</option>
              <option value="500" selected>Medio (~83d)</option>
              <option value="750">Largo (~125d)</option>
            </select></div>
          <button class="btn btng" style="padding:9px 18px;font-size:12px;font-weight:600" onclick="startBacktest()">▶ Ejecutar</button>
        </div>

        <!-- Filtros de estrategia -->
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:10px">⚙️ Filtros de la estrategia real</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px">
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="bt-ny" checked style="accent-color:var(--accent)">
              🕐 Sesión NY (14:30–21:00 ES)
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="bt-vol" checked style="accent-color:var(--accent)">
              📊 Filtro volumen (&gt;1× media 20v)
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="bt-cb" checked style="accent-color:var(--accent)">
              🛑 Circuit breaker (2 pérdidas seguidas)
            </label>
          </div>
        </div>

        <div style="font-size:10px;color:var(--muted);margin-top:10px">
          💡 Riesgo/op: <b style="color:var(--accent)">$${riskUSD.toFixed(2)}</b>
          · RSI ${BT.RSI_OVERSOLD}/${BT.RSI_OVERBOUGHT} · EMA200 · SL=${BT.ATR_SL_MULT}×ATR · R:R≥${BT.MIN_RR}
        </div>
      </div>

      <div id="bt-results"></div>
    </div>`;
}

async function startBacktest() {
  const coin = qs('#bt-coin')?.value || 'BTC';
  const interval = qs('#bt-interval')?.value || '4h';
  const limit = parseInt(qs('#bt-limit')?.value || '500', 10);
  const useNY = qs('#bt-ny')?.checked ?? true;
  const useVol = qs('#bt-vol')?.checked ?? true;
  const useCB = qs('#bt-cb')?.checked ?? true;
  const riskUSD = typeof getDynamicRiskUSD === 'function' ? getDynamicRiskUSD() : 10;
  const el = qs('#bt-results');
  if (!el) return;

  if (!riskUSD || riskUSD <= 0) {
    el.innerHTML = `<div class="card" style="border-color:rgba(255,68,85,.3);padding:20px;color:var(--red)">
      ⚠️ Riesgo/op es $0. Ve a Configuración y ajusta tu capital y % de riesgo primero.</div>`;
    return;
  }

  const activeFilters = [
    useNY ? '🕐 NY' : null,
    useVol ? '📊 Volumen' : null,
    useCB ? '🛑 CB' : null,
  ].filter(Boolean).join(' · ') || 'Sin filtros extra';

  el.innerHTML = `
    <div class="card" style="text-align:center;padding:30px">
      <div style="margin:0 auto 12px;width:24px;height:24px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite"></div>
      <div style="font-size:12px;color:var(--muted)">Descargando velas de ${coin}/USDT ${interval.toUpperCase()}…</div>
      <div style="font-size:10px;color:var(--muted);margin-top:5px">Filtros activos: ${activeFilters}</div>
    </div>`;

  try {
    const r = await runBacktest(coin, interval, riskUSD, limit, useNY, useVol, useCB);
    renderBacktestResults(r, el);
  } catch (e) {
    console.error('[Backtester]', e);
    el.innerHTML = `
      <div class="card" style="border-color:rgba(255,68,85,.3);padding:24px;text-align:center">
        <div style="font-size:20px;margin-bottom:8px">❌</div>
        <div style="color:var(--red);font-size:13px;font-weight:600;margin-bottom:6px">${e.message}</div>
        <div style="color:var(--muted);font-size:11px">Comprueba tu conexión e inténtalo de nuevo.</div>
      </div>`;
  }
}

function renderBacktestResults(r, container) {
  if (!r || typeof r !== 'object') {
    container.innerHTML = `<div class="card" style="padding:20px;color:var(--red)">Error: resultado inválido.</div>`;
    return;
  }
  const trades = Array.isArray(r.trades) ? r.trades : [];
  const pc = v => v >= 0 ? 'var(--green)' : 'var(--red)';
  const pfc = r.profitFactor >= 1.5 ? 'var(--green)' : r.profitFactor >= 1 ? 'var(--yellow)' : 'var(--red)';
  const wrc = r.winRate >= 50 ? 'var(--green)' : r.winRate >= 40 ? 'var(--yellow)' : 'var(--red)';

  // Curva SVG
  let svgHtml = '';
  const curve = Array.isArray(r.equityCurve) ? r.equityCurve : [];
  if (curve.length > 1) {
    const vals = curve.map(p => p.cumPnl);
    const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
    const W = 400, H = 60;
    const pts = vals.map((v, i) =>
      `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - ((v - mn) / rng * H)).toFixed(1)}`
    ).join(' ');
    const zy = (H - ((0 - mn) / rng * H)).toFixed(1);
    svgHtml = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:60px;margin:8px 0;display:block">
      <line x1="0" y1="${zy}" x2="${W}" y2="${zy}" stroke="rgba(255,255,255,.12)" stroke-dasharray="4"/>
      <polyline points="${pts}" fill="none" stroke="${r.totalPnl >= 0 ? '#00d17a' : '#ff4455'}" stroke-width="2" stroke-linejoin="round"/>
    </svg>`;
  }

  // Resumen de filtros rechazados
  const rej = r.rejected || {};
  const totalRej = (rej.ny || 0) + (rej.vol || 0) + (rej.cb || 0);
  const rejHtml = totalRej > 0 ? `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
      ${rej.ny ? `<span style="font-size:10px;padding:2px 8px;border-radius:12px;background:var(--s2);color:var(--muted)">🕐 NY filtró ${rej.ny} señal${rej.ny > 1 ? 'es' : ''}</span>` : ''}
      ${rej.vol ? `<span style="font-size:10px;padding:2px 8px;border-radius:12px;background:var(--s2);color:var(--muted)">📊 Volumen filtró ${rej.vol} señal${rej.vol > 1 ? 'es' : ''}</span>` : ''}
      ${rej.cb ? `<span style="font-size:10px;padding:2px 8px;border-radius:12px;background:var(--s2);color:var(--muted)">🛑 CB bloqueó ${rej.cb} señal${rej.cb > 1 ? 'es' : ''}</span>` : ''}
    </div>` : '';

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px">
      ${_btKpi('Trades', r.totalTrades, 'var(--text)', '')}
      ${_btKpi('Win Rate', r.winRate + '%', wrc, `${r.wins}W / ${r.losses}L / ${r.breakevens}BE`)}
      ${_btKpi('P&L Total', (r.totalPnl >= 0 ? '+' : '') + '$' + r.totalPnl.toFixed(2), pc(r.totalPnl), 'neto con fees')}
      ${_btKpi('Profit Factor', r.profitFactor >= 99 ? '∞' : r.profitFactor, pfc, '≥1.5 = rentable')}
      ${_btKpi('Max Drawdown', '-$' + r.maxDrawdown.toFixed(2), 'var(--red)', 'pérdida máx acumulada')}
      ${_btKpi('Avg Win', '+$' + r.avgWin.toFixed(2), 'var(--green)', 'por trade ganador')}
      ${_btKpi('Avg Loss', '-$' + r.avgLoss.toFixed(2), 'var(--red)', 'por trade perdedor')}
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="stl" style="margin-bottom:4px">📈 Curva de Equity</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:2px">
        ${r.coin}/USDT ${r.interval.toUpperCase()} · ${r.totalTrades} ops
        ${trades.length > 0 ? `· $${(trades[0].riskUSD || 0).toFixed(2)}/op` : ''}
      </div>
      ${svgHtml || '<div style="font-size:11px;color:var(--muted);padding:12px 0">Sin suficientes trades.</div>'}
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="stl" style="margin-bottom:8px">🔍 Diagnóstico</div>

      ${r.totalTrades === 0 ? `
        <div style="font-size:11px;color:var(--yellow);margin-bottom:6px">
          ⚠️ Sin señales con los filtros actuales. Prueba:
          <ul style="margin:6px 0 0 16px;line-height:2">
            <li>Desactivar el filtro de Sesión NY</li>
            <li>Usar timeframe 1H (más señales)</li>
            <li>Ampliar el periodo a Largo (~125d)</li>
            <li>Probar BTC o ETH que tienen más liquidez</li>
          </ul>
        </div>` : ''}

      ${r.totalTrades > 0 && r.totalTrades < 8 ? `
        <div style="font-size:11px;color:var(--yellow);margin-bottom:6px">
          ⚠️ Solo ${r.totalTrades} trades — estadísticas poco fiables. Amplía el periodo o desactiva algún filtro.
        </div>` : ''}

      ${r.profitFactor < 1 && r.totalTrades >= 5 ? `
        <div style="font-size:11px;color:var(--red);margin-bottom:6px">
          ❌ Profit Factor &lt;1: estrategia pierde dinero en ${r.coin} ${r.interval.toUpperCase()} con estos parámetros.
        </div>` : ''}

      ${r.profitFactor >= 1.5 && r.winRate >= 40 ? `
        <div style="font-size:11px;color:var(--green);margin-bottom:6px">
          ✅ Estrategia rentable. PF ${r.profitFactor} · WR ${r.winRate}%
        </div>` : ''}

      <!-- Filtros activos y señales rechazadas -->
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px">Filtros activos:</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
        <span style="font-size:10px;padding:2px 8px;border-radius:12px;background:${r.filtersUsed?.useNYFilter ? 'rgba(0,209,122,.12)' : 'var(--s2)'};color:${r.filtersUsed?.useNYFilter ? 'var(--green)' : 'var(--muted)'}">🕐 NY ${r.filtersUsed?.useNYFilter ? 'ON' : 'OFF'}</span>
        <span style="font-size:10px;padding:2px 8px;border-radius:12px;background:${r.filtersUsed?.useVolFilter ? 'rgba(0,209,122,.12)' : 'var(--s2)'};color:${r.filtersUsed?.useVolFilter ? 'var(--green)' : 'var(--muted)'}">📊 Volumen ${r.filtersUsed?.useVolFilter ? 'ON' : 'OFF'}</span>
        <span style="font-size:10px;padding:2px 8px;border-radius:12px;background:${r.filtersUsed?.useCB ? 'rgba(0,209,122,.12)' : 'var(--s2)'};color:${r.filtersUsed?.useCB ? 'var(--green)' : 'var(--muted)'}">🛑 CB ${r.filtersUsed?.useCB ? 'ON' : 'OFF'}</span>
      </div>
      ${rejHtml}

      <div style="font-size:10px;color:var(--muted);line-height:1.7;margin-top:8px">
        LONG: RSI≤${BT.RSI_OVERSOLD} + precio&gt;EMA200 + EMA20&gt;EMA50 · SHORT: RSI≥${BT.RSI_OVERBOUGHT} + precio&lt;EMA200 + EMA20&lt;EMA50<br>
        SL=${BT.ATR_SL_MULT}×ATR · TP1=${BT.TP1_RATIO}:1 (50% cierre + breakeven) · TP2=${BT.TP2_RATIO}:1 · R:R mín ${BT.MIN_RR}<br>
        Fees: ${(BT.FEE_TAKER * 100).toFixed(2)}% taker apertura + ${(BT.FEE_MAKER * 100).toFixed(2)}% maker cierre
      </div>
    </div>

    ${trades.length > 0 ? `
    <div class="card">
      <div class="stl" style="margin-bottom:10px">📋 Últimos ${Math.min(trades.length, 20)} trades simulados</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead><tr style="color:var(--muted);text-align:left;border-bottom:1px solid var(--border)">
            <th style="padding:4px 8px">#</th>
            <th style="padding:4px 8px">Fecha</th>
            <th style="padding:4px 8px">Tipo</th>
            <th style="padding:4px 8px">Entrada</th>
            <th style="padding:4px 8px">SL</th>
            <th style="padding:4px 8px">R:R</th>
            <th style="padding:4px 8px">RSI</th>
            <th style="padding:4px 8px">Vol×</th>
            <th style="padding:4px 8px">P&L</th>
            <th style="padding:4px 8px">Result</th>
          </tr></thead>
          <tbody>
            ${trades.slice(-20).reverse().map((t, i) => `
              <tr style="border-top:1px solid var(--border)">
                <td style="padding:5px 8px;color:var(--muted)">${trades.length - i}</td>
                <td style="padding:5px 8px;font-size:10px;font-family:var(--font-mono)">${t.entryDate || '—'}</td>
                <td style="padding:5px 8px;color:${t.tipo === 'LONG' ? 'var(--green)' : 'var(--red)'};font-weight:600">${t.tipo}</td>
                <td style="padding:5px 8px;font-family:var(--font-mono)">${fmtP(t.entrada, r.coin)}</td>
                <td style="padding:5px 8px;color:var(--red);font-family:var(--font-mono)">${fmtP(t.stopLoss, r.coin)}</td>
                <td style="padding:5px 8px">${t.rr}</td>
                <td style="padding:5px 8px;color:${t.rsi <= BT.RSI_OVERSOLD ? 'var(--green)' : t.rsi >= BT.RSI_OVERBOUGHT ? 'var(--red)' : 'var(--muted)'}">${t.rsi}</td>
                <td style="padding:5px 8px;color:${t.volRatio >= 1.5 ? 'var(--green)' : 'var(--muted)'}">${t.volRatio ? t.volRatio + '×' : '—'}</td>
                <td style="padding:5px 8px;font-weight:700;color:${(t.pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">
                  ${(t.pnl >= 0 ? '+' : '') + '$' + (t.pnl || 0).toFixed(2)}</td>
                <td style="padding:5px 8px">${t.result === 'WIN' ? '✅ WIN' : t.result === 'BREAKEVEN' ? '↔️ BE' : '❌ LOSS'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}`;
}

function _btKpi(label, value, color, sub) {
  return `<div class="card" style="padding:12px 14px">
    <div style="font-size:10px;color:var(--muted);margin-bottom:4px">${label}</div>
    <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:${color}">${value}</div>
    ${sub ? `<div style="font-size:9px;color:var(--muted);margin-top:2px">${sub}</div>` : ''}
  </div>`;
}