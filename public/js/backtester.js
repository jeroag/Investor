/* ═══════════════════════════════════════════════════════════════════
   CRYPTOPLAN IA — backtester.js v3.0
   Dos estrategias:
   ──────────────────────────────────────────────────────────────────
   [A] MOMENTUM (estrategia principal)
       RSI extremo + EMA200 tendencia + ATR SL
       Activa en: mercados en tendencia clara
       En standby en: mercados laterales

   [B] RANGO (estrategia complementaria)
       Bollinger Bands mean-reversion + RSI medio + EMA200 plana
       Activa en: mercados laterales (EMA200 slope < 2%)
       En standby en: tendencias fuertes
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

/* ── Parámetros estrategia MOMENTUM ────────────────────────────────────── */
const BT = {
  TP1_RATIO: 1.2,
  TP2_RATIO: 2.5,
  PARTIAL_PCT: 0.5,
  ATR_SL_MULT: 1.5,
  MIN_RR: 2.0,
  FEE_TAKER: 0.0006,
  FEE_MAKER: 0.0002,
  RSI_OVERSOLD: 40,
  RSI_OVERBOUGHT: 60,
  EMA_FAST: 20,
  EMA_SLOW: 50,
  EMA_TREND: 200,
  RSI_PERIOD: 14,
  ATR_PERIOD: 14,
  MIN_CANDLES: 220,
  VOL_MA_PERIOD: 20,
  VOL_MIN_RATIO: 1.0,
  MAX_CONSEC_LOSSES: 2,
  NY_OPEN_UTC: 13,
  NY_CLOSE_UTC: 20,
};

/* ── Parámetros estrategia RANGO ───────────────────────────────────────── */
const BT_RANGE = {
  BB_PERIOD: 20,       // periodo Bollinger Bands
  BB_MULT: 2.0,      // desviaciones estándar
  ATR_SL_MULT: 1.0,      // SL más ajustado en rango
  MIN_RR: 1.5,      // R:R mínimo (más bajo que momentum)
  FEE_TAKER: 0.0006,
  FEE_MAKER: 0.0002,
  RSI_LONG_MAX: 45,       // RSI máximo para LONG (sobreventa media)
  RSI_SHORT_MIN: 55,       // RSI mínimo para SHORT (sobrecompra media)
  RSI_PERIOD: 14,
  ATR_PERIOD: 14,
  MIN_CANDLES: 60,
  // Detección de rango: EMA200 slope < este % en las últimas N velas
  RANGE_SLOPE_PCT: 2.0,      // EMA200 con slope < 2% → mercado lateral
  RANGE_SLOPE_PERIOD: 20,       // periodo para medir el slope
  MAX_CONSEC_LOSSES: 2,
};

/* ════════════════════════════════════════════════════════════════════
   INDICADORES COMPARTIDOS
   ════════════════════════════════════════════════════════════════════ */

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

function _btVolMaArray(volumes, period) {
  const out = new Array(volumes.length).fill(null);
  for (let i = period - 1; i < volumes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += volumes[j];
    out[i] = sum / period;
  }
  return out;
}

/* ── Bollinger Bands ────────────────────────────────────────────────────── */
function _btBollingerArrays(closes, period, mult) {
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const mid = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    mid[i] = mean;
    upper[i] = mean + mult * std;
    lower[i] = mean - mult * std;
  }
  return { upper, lower, mid };
}

/* ── Sesión NY ──────────────────────────────────────────────────────────── */
function _isNYSession(timestampMs, interval) {
  if (interval === '1d') return true;
  const durMin = interval === '4h' ? 240 : 60;
  const d = new Date(timestampMs);
  const candleOpenMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const candleCloseMin = candleOpenMin + durMin;
  const nyOpen = BT.NY_OPEN_UTC * 60 + 30;
  const nyClose = BT.NY_CLOSE_UTC * 60;
  return candleCloseMin > nyOpen && candleOpenMin < nyClose;
}

/* ── Descarga Binance ───────────────────────────────────────────────────── */
async function btFetchKlines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.msg || msg; } catch { }
    throw new Error(`Binance error para ${symbol}: ${msg}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error(`Respuesta inesperada de Binance`);
  return raw.map(k => ({
    t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]),
    l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
  }));
}

/* ════════════════════════════════════════════════════════════════════
   MOTOR A — MOMENTUM (estrategia principal)
   ════════════════════════════════════════════════════════════════════ */
async function runBacktest(coin, interval, riskUSD, limit, useNYFilter, useVolFilter, useCB) {
  if (!limit) limit = 500;
  if (useNYFilter === undefined) useNYFilter = (interval === '1h');
  if (useVolFilter === undefined) useVolFilter = true;
  if (useCB === undefined) useCB = true;

  const candles = await btFetchKlines(coin.toUpperCase(), interval, Math.min(limit + BT.MIN_CANDLES, 1000));
  if (!Array.isArray(candles) || candles.length < BT.MIN_CANDLES + 10)
    throw new Error(`Datos insuficientes: ${candles?.length ?? 0} velas (mínimo ${BT.MIN_CANDLES + 10})`);

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const volumes = candles.map(c => c.v);

  const rsiArr = _btRsiArray(closes, BT.RSI_PERIOD);
  const ema200 = _btEmaArray(closes, BT.EMA_TREND);
  const atrArr = _btAtrArray(highs, lows, closes, BT.ATR_PERIOD);
  const volMaArr = _btVolMaArray(volumes, BT.VOL_MA_PERIOD);

  const trades = [];
  let openTrade = null, equity = 0, consecLosses = 0;
  const rejected = { ny: 0, vol: 0, cb: 0, rr: 0 };

  for (let i = BT.MIN_CANDLES; i < candles.length - 1; i++) {
    const bar = candles[i];

    if (openTrade) {
      const { tipo, entrada, tp1, tp2, size } = openTrade;
      if (tipo === 'LONG') {
        if (!openTrade.tp1Hit && bar.h >= tp1) {
          const q = size * BT.PARTIAL_PCT;
          const p = (tp1 - entrada) * q - tp1 * q * BT.FEE_MAKER;
          openTrade.tp1Hit = true; openTrade.size = size * 0.5;
          openTrade.stopLoss = entrada; openTrade.tp1PnL = p; equity += p; continue;
        }
        if (openTrade.tp1Hit && bar.h >= tp2) {
          const q = openTrade.size;
          const p = (tp2 - entrada) * q - tp2 * q * BT.FEE_MAKER;
          trades.push({ ...openTrade, result: 'WIN', pnl: parseFloat(((openTrade.tp1PnL || 0) + p).toFixed(4)), exit: tp2 });
          equity += p; consecLosses = 0; openTrade = null; continue;
        }
        if (bar.l <= openTrade.stopLoss) {
          const q = openTrade.size;
          const p = (openTrade.stopLoss - entrada) * q - openTrade.stopLoss * q * BT.FEE_TAKER;
          const result = openTrade.tp1Hit ? 'BREAKEVEN' : 'LOSS';
          trades.push({ ...openTrade, result, pnl: parseFloat(((openTrade.tp1PnL || 0) + p).toFixed(4)), exit: openTrade.stopLoss });
          equity += p; if (result === 'LOSS') consecLosses++; else consecLosses = 0;
          openTrade = null; continue;
        }
      } else {
        if (!openTrade.tp1Hit && bar.l <= tp1) {
          const q = size * BT.PARTIAL_PCT;
          const p = (entrada - tp1) * q - tp1 * q * BT.FEE_MAKER;
          openTrade.tp1Hit = true; openTrade.size = size * 0.5;
          openTrade.stopLoss = entrada; openTrade.tp1PnL = p; equity += p; continue;
        }
        if (openTrade.tp1Hit && bar.l <= tp2) {
          const q = openTrade.size;
          const p = (entrada - tp2) * q - tp2 * q * BT.FEE_MAKER;
          trades.push({ ...openTrade, result: 'WIN', pnl: parseFloat(((openTrade.tp1PnL || 0) + p).toFixed(4)), exit: tp2 });
          equity += p; consecLosses = 0; openTrade = null; continue;
        }
        if (bar.h >= openTrade.stopLoss) {
          const q = openTrade.size;
          const p = (entrada - openTrade.stopLoss) * q - openTrade.stopLoss * q * BT.FEE_TAKER;
          const result = openTrade.tp1Hit ? 'BREAKEVEN' : 'LOSS';
          trades.push({ ...openTrade, result, pnl: parseFloat(((openTrade.tp1PnL || 0) + p).toFixed(4)), exit: openTrade.stopLoss });
          equity += p; if (result === 'LOSS') consecLosses++; else consecLosses = 0;
          openTrade = null; continue;
        }
      }
      continue;
    }

    const rsi = rsiArr[i], e200 = ema200[i], atr = atrArr[i], volMa = volMaArr[i];
    if (rsi === null || e200 === null || atr === null || atr <= 0) continue;
    if (useCB && consecLosses >= BT.MAX_CONSEC_LOSSES) { rejected.cb++; continue; }
    if (useNYFilter && !_isNYSession(bar.t, interval)) { rejected.ny++; continue; }
    if (useVolFilter && volMa !== null && volumes[i] < volMa * BT.VOL_MIN_RATIO) { rejected.vol++; continue; }

    const price = closes[i];
    let tipo = null;
    if (rsi <= BT.RSI_OVERSOLD && price > e200) tipo = 'LONG';
    if (rsi >= BT.RSI_OVERBOUGHT && price < e200) tipo = 'SHORT';
    if (!tipo) continue;

    const slDist = atr * BT.ATR_SL_MULT;
    if (slDist <= 0) continue;
    const entrada = price;
    const stopLoss = tipo === 'LONG' ? entrada - slDist : entrada + slDist;
    const tp1 = tipo === 'LONG' ? entrada + slDist * BT.TP1_RATIO : entrada - slDist * BT.TP1_RATIO;
    const tp2 = tipo === 'LONG' ? entrada + slDist * BT.TP2_RATIO : entrada - slDist * BT.TP2_RATIO;
    if (Math.abs(tp1 - entrada) / slDist < BT.MIN_RR) { rejected.rr++; continue; }

    const size = riskUSD / slDist;
    equity -= entrada * size * BT.FEE_TAKER;
    openTrade = {
      coin, tipo, entrada, stopLoss, tp1, tp2, size, riskUSD,
      rr: (Math.abs(tp1 - entrada) / slDist).toFixed(2),
      tp1Hit: false, tp1PnL: 0,
      rsi: Math.round(rsi), atr: parseFloat(atr.toFixed(4)),
      volRatio: volMa ? parseFloat((volumes[i] / volMa).toFixed(2)) : null,
      entryBar: i, entryDate: new Date(candles[i].t).toLocaleDateString('es-ES'),
      strategy: 'MOMENTUM',
    };
  }

  return _buildStats(trades, coin, interval, rejected, { useNYFilter, useVolFilter, useCB }, 'MOMENTUM');
}

/* ════════════════════════════════════════════════════════════════════
   MOTOR B — RANGO (estrategia complementaria)
   Bollinger Bands mean-reversion con detección automática de rango
   ════════════════════════════════════════════════════════════════════ */
async function runBacktestRange(coin, interval, riskUSD, limit) {
  if (!limit) limit = 500;

  const candles = await btFetchKlines(coin.toUpperCase(), interval, Math.min(limit + 60, 1000));
  if (!Array.isArray(candles) || candles.length < BT_RANGE.MIN_CANDLES + 10)
    throw new Error(`Datos insuficientes: ${candles?.length ?? 0} velas`);

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);

  const rsiArr = _btRsiArray(closes, BT_RANGE.RSI_PERIOD);
  const atrArr = _btAtrArray(highs, lows, closes, BT_RANGE.ATR_PERIOD);
  const ema200 = _btEmaArray(closes, 200);
  const { upper, lower, mid } = _btBollingerArrays(closes, BT_RANGE.BB_PERIOD, BT_RANGE.BB_MULT);

  const trades = [];
  let openTrade = null, equity = 0, consecLosses = 0;
  const rejected = { slope: 0, rsi: 0, cb: 0, rr: 0 };
  let rangeCandles = 0, trendCandles = 0;

  const START = Math.max(BT_RANGE.MIN_CANDLES, BT_RANGE.RANGE_SLOPE_PERIOD + 1);

  for (let i = START; i < candles.length - 1; i++) {
    const bar = candles[i];

    // ── Gestión trade abierto ───────────────────────────────────────
    if (openTrade) {
      const { tipo, entrada, tp1, stopLoss, size } = openTrade;
      if (tipo === 'LONG') {
        if (bar.h >= tp1) {
          const p = (tp1 - entrada) * size - tp1 * size * BT_RANGE.FEE_MAKER;
          trades.push({ ...openTrade, result: 'WIN', pnl: parseFloat(p.toFixed(4)), exit: tp1 });
          equity += p; consecLosses = 0; openTrade = null; continue;
        }
        if (bar.l <= stopLoss) {
          const p = (stopLoss - entrada) * size - stopLoss * size * BT_RANGE.FEE_TAKER;
          trades.push({ ...openTrade, result: 'LOSS', pnl: parseFloat(p.toFixed(4)), exit: stopLoss });
          equity += p; consecLosses++; openTrade = null; continue;
        }
      } else {
        if (bar.l <= tp1) {
          const p = (entrada - tp1) * size - tp1 * size * BT_RANGE.FEE_MAKER;
          trades.push({ ...openTrade, result: 'WIN', pnl: parseFloat(p.toFixed(4)), exit: tp1 });
          equity += p; consecLosses = 0; openTrade = null; continue;
        }
        if (bar.h >= stopLoss) {
          const p = (entrada - stopLoss) * size - stopLoss * size * BT_RANGE.FEE_TAKER;
          trades.push({ ...openTrade, result: 'LOSS', pnl: parseFloat(p.toFixed(4)), exit: stopLoss });
          equity += p; consecLosses++; openTrade = null; continue;
        }
      }
      continue;
    }

    const rsi = rsiArr[i];
    const atr = atrArr[i];
    const bbUp = upper[i];
    const bbLo = lower[i];
    const bbMid = mid[i];
    const e200 = ema200[i];
    if (rsi === null || atr === null || atr <= 0 || bbUp === null) continue;

    // ── FILTRO 1: Circuit breaker ───────────────────────────────────
    if (consecLosses >= BT_RANGE.MAX_CONSEC_LOSSES) { rejected.cb++; continue; }

    // ── FILTRO 2: Detección de rango (EMA200 slope plana) ──────────
    // El slope se mide como variación % de EMA200 en las últimas N velas
    // Si EMA200 se mueve poco → mercado lateral → estrategia de rango activa
    const e200Prev = ema200[i - BT_RANGE.RANGE_SLOPE_PERIOD];
    if (e200 === null || e200Prev === null) continue;
    const slopePct = Math.abs((e200 - e200Prev) / e200Prev * 100);
    const isRange = slopePct < BT_RANGE.RANGE_SLOPE_PCT;
    if (!isRange) { rejected.slope++; trendCandles++; continue; }
    rangeCandles++;

    // ── Señal de entrada ────────────────────────────────────────────
    const price = closes[i];
    let tipo = null;

    // LONG: precio toca o cruza la banda inferior + RSI en zona media-baja
    if (price <= bbLo && rsi <= BT_RANGE.RSI_LONG_MAX) tipo = 'LONG';
    // SHORT: precio toca o cruza la banda superior + RSI en zona media-alta
    if (price >= bbUp && rsi >= BT_RANGE.RSI_SHORT_MIN) tipo = 'SHORT';
    if (!tipo) { rejected.rsi++; continue; }

    // ── Niveles: TP = banda media (mean-reversion), SL = 1×ATR ─────
    const slDist = atr * BT_RANGE.ATR_SL_MULT;
    if (slDist <= 0) continue;
    const entrada = price;
    const stopLoss = tipo === 'LONG' ? entrada - slDist : entrada + slDist;
    const tp1 = bbMid; // objetivo: volver a la media

    const rrActual = Math.abs(tp1 - entrada) / slDist;
    if (rrActual < BT_RANGE.MIN_RR) { rejected.rr++; continue; }

    const size = riskUSD / slDist;
    equity -= entrada * size * BT_RANGE.FEE_TAKER;
    openTrade = {
      coin, tipo, entrada, stopLoss, tp1, size, riskUSD,
      rr: rrActual.toFixed(2),
      tp1Hit: false, tp1PnL: 0,
      rsi: Math.round(rsi),
      atr: parseFloat(atr.toFixed(4)),
      bbWidth: parseFloat(((bbUp - bbLo) / bbMid * 100).toFixed(2)), // ancho BB en %
      slopePct: parseFloat(slopePct.toFixed(2)),
      entryBar: i,
      entryDate: new Date(candles[i].t).toLocaleDateString('es-ES'),
      strategy: 'RANGO',
    };
  }

  const rangeRatio = rangeCandles + trendCandles > 0
    ? Math.round(rangeCandles / (rangeCandles + trendCandles) * 100)
    : 0;

  return {
    ..._buildStats(trades, coin, interval, rejected, {}, 'RANGO'),
    rangeRatio,   // % de velas que estaban en rango
    trendCandles,
    rangeCandles,
  };
}

/* ── Cálculo de estadísticas compartido ────────────────────────────────── */
function _buildStats(trades, coin, interval, rejected, filtersUsed, strategy) {
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
    coin, interval, strategy,
    totalTrades: t.length, wins, losses, breakevens: bes,
    winRate: parseFloat((t.length > 0 ? wins / t.length * 100 : 0).toFixed(1)),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    profitFactor: parseFloat(Math.min(pf, 99).toFixed(2)),
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
    trades: t, equityCurve, rejected, filtersUsed,
  };
}

/* ════════════════════════════════════════════════════════════════════
   UI
   ════════════════════════════════════════════════════════════════════ */
function renderBacktester() {
  const root = qs('#sec-backtest');
  if (!root) return;
  const riskUSD = typeof getDynamicRiskUSD === 'function' ? getDynamicRiskUSD() : 0;
  root.innerHTML = `
    <div style="padding:0 0 24px">
      <div class="sec-hdr">
        <div>
          <div class="stl" style="margin:0 0 6px">📊 Backtester de Estrategia</div>
          <div style="font-size:11px;color:var(--muted)">Dos estrategias según el régimen de mercado: Momentum (tendencia) y Rango (lateral).</div>
        </div>
      </div>

      <!-- Selector de estrategia -->
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button id="bt-mode-momentum" onclick="setBtMode('momentum')"
          style="flex:1;padding:10px;border-radius:10px;border:2px solid var(--accent);background:var(--accent);color:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s">
          ⚡ Momentum<br><span style="font-size:10px;font-weight:400;opacity:.85">Tendencias · RSI extremo + EMA200</span>
        </button>
        <button id="bt-mode-range" onclick="setBtMode('range')"
          style="flex:1;padding:10px;border-radius:10px;border:2px solid var(--border);background:var(--s2);color:var(--muted);font-size:12px;font-weight:600;cursor:pointer;transition:all .2s">
          〰️ Rango<br><span style="font-size:10px;font-weight:400">Laterales · Bollinger Bands + mean-reversion</span>
        </button>
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
              <option value="500">Medio (~83d)</option>
              <option value="750" selected>Largo (~125d)</option>
            </select></div>
          <button class="btn btng" style="padding:9px 18px;font-size:12px;font-weight:600" onclick="startBacktest()">▶ Ejecutar</button>
        </div>

        <!-- Filtros Momentum (ocultos en modo rango) -->
        <div id="bt-momentum-filters" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:10px">⚙️ Filtros momentum</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px">
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="bt-ny" style="accent-color:var(--accent)">
              🕐 Sesión NY <span style="font-size:10px;color:var(--muted)">(solo en 1H)</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="bt-vol" checked style="accent-color:var(--accent)">
              📊 Filtro volumen (&gt;1× media)
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="bt-cb" checked style="accent-color:var(--accent)">
              🛑 Circuit breaker (2 pérdidas)
            </label>
          </div>
        </div>

        <!-- Info Rango (visible en modo rango) -->
        <div id="bt-range-info" style="display:none;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:8px">ℹ️ Parámetros estrategia de rango</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:10px;color:var(--muted)">
            <div>📉 Bollinger Bands (20 velas, 2σ)</div>
            <div>🎯 TP: banda media (mean-reversion)</div>
            <div>🛑 SL: 1× ATR desde la banda</div>
            <div>📐 R:R mínimo: 1.5</div>
            <div>🔍 Detección rango: EMA200 slope &lt;2%</div>
            <div>🛑 Circuit breaker: 2 pérdidas seguidas</div>
          </div>
        </div>

        <div style="font-size:10px;color:var(--muted);margin-top:10px">
          💡 Riesgo/op: <b style="color:var(--accent)">$${riskUSD.toFixed(2)}</b>
          <span id="bt-strategy-hint"> · Momentum: RSI ${BT.RSI_OVERSOLD}/${BT.RSI_OVERBOUGHT} + EMA200 · SL=${BT.ATR_SL_MULT}×ATR</span>
        </div>
      </div>

      <div id="bt-results"></div>
    </div>`;

  // Estado inicial
  window._btMode = 'momentum';
}

function setBtMode(mode) {
  window._btMode = mode;
  const isMomentum = mode === 'momentum';

  const btnM = qs('#bt-mode-momentum');
  const btnR = qs('#bt-mode-range');
  if (btnM) {
    btnM.style.borderColor = isMomentum ? 'var(--accent)' : 'var(--border)';
    btnM.style.background = isMomentum ? 'var(--accent)' : 'var(--s2)';
    btnM.style.color = isMomentum ? '#fff' : 'var(--muted)';
  }
  if (btnR) {
    btnR.style.borderColor = !isMomentum ? 'var(--accent)' : 'var(--border)';
    btnR.style.background = !isMomentum ? 'var(--accent)' : 'var(--s2)';
    btnR.style.color = !isMomentum ? '#fff' : 'var(--muted)';
  }

  const mf = qs('#bt-momentum-filters');
  const ri = qs('#bt-range-info');
  const hint = qs('#bt-strategy-hint');
  if (mf) mf.style.display = isMomentum ? 'block' : 'none';
  if (ri) ri.style.display = isMomentum ? 'none' : 'block';
  if (hint) hint.textContent = isMomentum
    ? ` · Momentum: RSI ${BT.RSI_OVERSOLD}/${BT.RSI_OVERBOUGHT} + EMA200 · SL=${BT.ATR_SL_MULT}×ATR`
    : ` · Rango: BB(20,2σ) + RSI medio · SL=1×ATR · TP=banda media`;
}

async function startBacktest() {
  const coin = qs('#bt-coin')?.value || 'BTC';
  const interval = qs('#bt-interval')?.value || '4h';
  const limit = parseInt(qs('#bt-limit')?.value || '500', 10);
  const riskUSD = typeof getDynamicRiskUSD === 'function' ? getDynamicRiskUSD() : 10;
  const el = qs('#bt-results');
  const mode = window._btMode || 'momentum';
  if (!el) return;

  if (!riskUSD || riskUSD <= 0) {
    el.innerHTML = `<div class="card" style="border-color:rgba(255,68,85,.3);padding:20px;color:var(--red)">
      ⚠️ Riesgo/op es $0. Ve a Configuración y ajusta tu capital y % de riesgo primero.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="card" style="text-align:center;padding:30px">
      <div style="margin:0 auto 12px;width:24px;height:24px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite"></div>
      <div style="font-size:12px;color:var(--muted)">Descargando ${coin}/USDT ${interval.toUpperCase()}…</div>
      <div style="font-size:10px;color:var(--muted);margin-top:5px">Estrategia: ${mode === 'momentum' ? '⚡ Momentum' : '〰️ Rango'}</div>
    </div>`;

  try {
    let r;
    if (mode === 'range') {
      r = await runBacktestRange(coin, interval, riskUSD, limit);
    } else {
      const useNY = qs('#bt-ny')?.checked ?? false;
      const useVol = qs('#bt-vol')?.checked ?? true;
      const useCB = qs('#bt-cb')?.checked ?? true;
      r = await runBacktest(coin, interval, riskUSD, limit, useNY, useVol, useCB);
    }
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
  const isRange = r.strategy === 'RANGO';
  const pc = v => v >= 0 ? 'var(--green)' : 'var(--red)';
  const pfc = r.profitFactor >= 1.5 ? 'var(--green)' : r.profitFactor >= 1 ? 'var(--yellow)' : 'var(--red)';
  const wrc = r.winRate >= 50 ? 'var(--green)' : r.winRate >= 40 ? 'var(--yellow)' : 'var(--red)';

  // Curva equity
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

  // Badge estrategia
  const stratBadge = isRange
    ? `<span style="font-size:10px;padding:2px 8px;border-radius:12px;background:rgba(108,99,255,.15);color:var(--accent);border:1px solid rgba(108,99,255,.3)">〰️ RANGO</span>`
    : `<span style="font-size:10px;padding:2px 8px;border-radius:12px;background:rgba(0,209,122,.12);color:var(--green);border:1px solid rgba(0,209,122,.3)">⚡ MOMENTUM</span>`;

  // Diagnóstico específico de rango
  let rangeDiag = '';
  if (isRange && r.rangeRatio !== undefined) {
    const color = r.rangeRatio >= 50 ? 'var(--green)' : r.rangeRatio >= 30 ? 'var(--yellow)' : 'var(--red)';
    rangeDiag = `
      <div style="margin-bottom:10px;padding:10px 12px;background:var(--s2);border-radius:8px">
        <div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">📊 Régimen de mercado detectado</div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden">
            <div style="height:100%;width:${r.rangeRatio}%;background:${color};border-radius:4px;transition:width .5s"></div>
          </div>
          <span style="font-size:12px;font-weight:700;color:${color};min-width:36px">${r.rangeRatio}%</span>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:5px">
          ${r.rangeRatio >= 50
        ? '✅ Mercado mayormente lateral — estrategia de rango apropiada'
        : r.rangeRatio >= 30
          ? '⚠️ Mercado mixto — resultados variables'
          : '❌ Mercado en tendencia — considera usar estrategia Momentum'}
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px">${r.rangeCandles} velas en rango · ${r.trendCandles} en tendencia</div>
      </div>`;
  }

  // Señales rechazadas
  const rej = r.rejected || {};
  const rejItems = [];
  if (rej.slope) rejItems.push(`📈 Tendencia filtró ${rej.slope} velas`);
  if (rej.ny) rejItems.push(`🕐 NY filtró ${rej.ny} señales`);
  if (rej.vol) rejItems.push(`📊 Volumen filtró ${rej.vol} señales`);
  if (rej.cb) rejItems.push(`🛑 CB bloqueó ${rej.cb} señales`);
  if (rej.rsi) rejItems.push(`📉 RSI no en zona: ${rej.rsi} señales`);
  if (rej.rr) rejItems.push(`📐 R:R insuficiente: ${rej.rr} señales`);
  const rejHtml = rejItems.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px">${rejItems.map(s =>
      `<span style="font-size:10px;padding:2px 8px;border-radius:12px;background:var(--s2);color:var(--muted)">${s}</span>`
    ).join('')}</div>` : '';

  // Sin señales — mensaje contextual
  let noSignalMsg = '';
  if (r.totalTrades === 0) {
    noSignalMsg = isRange
      ? `<div style="font-size:11px;color:var(--yellow);margin-bottom:8px">
          ⚠️ Sin señales de rango. El mercado puede estar en tendencia fuerte.
          Prueba: timeframe menor (1H) · periodo más largo · o cambia a estrategia Momentum.
         </div>`
      : `<div style="font-size:11px;color:var(--yellow);margin-bottom:8px">
          ⚠️ Sin señales momentum. El mercado está en rango lateral.
          Prueba: cambiar a estrategia Rango · o esperar a que el mercado tome tendencia.
         </div>`;
  }

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      ${stratBadge}
      <span style="font-size:11px;color:var(--muted)">${r.coin}/USDT ${r.interval.toUpperCase()}</span>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px">
      ${_btKpi('Trades', r.totalTrades, 'var(--text)', '')}
      ${_btKpi('Win Rate', r.winRate + '%', wrc, `${r.wins}W / ${r.losses}L / ${r.breakevens || 0}BE`)}
      ${_btKpi('P&L Total', (r.totalPnl >= 0 ? '+' : '') + '$' + r.totalPnl.toFixed(2), pc(r.totalPnl), 'neto con fees')}
      ${_btKpi('Profit Factor', r.profitFactor >= 99 ? '∞' : r.profitFactor, pfc, '≥1.5 = rentable')}
      ${_btKpi('Max Drawdown', '-$' + r.maxDrawdown.toFixed(2), 'var(--red)', 'pérdida máx acumulada')}
      ${_btKpi('Avg Win', '+$' + r.avgWin.toFixed(2), 'var(--green)', 'por trade ganador')}
      ${_btKpi('Avg Loss', '-$' + r.avgLoss.toFixed(2), 'var(--red)', 'por trade perdedor')}
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="stl" style="margin-bottom:4px">📈 Curva de Equity</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:2px">
        ${r.totalTrades} operaciones · $${(trades[0]?.riskUSD || 0).toFixed(2)}/op
      </div>
      ${svgHtml || '<div style="font-size:11px;color:var(--muted);padding:12px 0">Sin suficientes trades.</div>'}
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="stl" style="margin-bottom:8px">🔍 Diagnóstico</div>
      ${rangeDiag}
      ${noSignalMsg}
      ${r.totalTrades > 0 && r.totalTrades < 8
      ? `<div style="font-size:11px;color:var(--yellow);margin-bottom:6px">⚠️ Solo ${r.totalTrades} trades — estadísticas poco fiables.</div>` : ''}
      ${r.profitFactor >= 1.5 && r.winRate >= 40 && r.totalTrades >= 5
      ? `<div style="font-size:11px;color:var(--green);margin-bottom:6px">✅ Estrategia rentable en este periodo. PF ${r.profitFactor} · WR ${r.winRate}%</div>` : ''}
      ${rejHtml}
      <div style="font-size:10px;color:var(--muted);line-height:1.7;margin-top:8px">
        ${isRange
      ? `BB(${BT_RANGE.BB_PERIOD}, ${BT_RANGE.BB_MULT}σ) · LONG: precio≤BB inferior + RSI≤${BT_RANGE.RSI_LONG_MAX} · SHORT: precio≥BB superior + RSI≥${BT_RANGE.RSI_SHORT_MIN}<br>SL=${BT_RANGE.ATR_SL_MULT}×ATR · TP=banda media · R:R mín ${BT_RANGE.MIN_RR} · Rango detectado: EMA200 slope &lt;${BT_RANGE.RANGE_SLOPE_PCT}%`
      : `LONG: RSI≤${BT.RSI_OVERSOLD} + precio&gt;EMA200 · SHORT: RSI≥${BT.RSI_OVERBOUGHT} + precio&lt;EMA200<br>SL=${BT.ATR_SL_MULT}×ATR · TP1=${BT.TP1_RATIO}:1 (50% cierre+BE) · TP2=${BT.TP2_RATIO}:1 · R:R mín ${BT.MIN_RR}`}
        <br>Fees: ${(BT.FEE_TAKER * 100).toFixed(2)}% taker apertura + ${(BT.FEE_MAKER * 100).toFixed(2)}% maker cierre
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
            <th style="padding:4px 8px">TP</th>
            <th style="padding:4px 8px">R:R</th>
            <th style="padding:4px 8px">RSI</th>
            ${isRange ? `<th style="padding:4px 8px">BB%</th>` : `<th style="padding:4px 8px">Vol×</th>`}
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
                <td style="padding:5px 8px;color:var(--green);font-family:var(--font-mono)">${fmtP(t.tp1, r.coin)}</td>
                <td style="padding:5px 8px">${t.rr}</td>
                <td style="padding:5px 8px;color:${t.rsi <= 40 ? 'var(--green)' : t.rsi >= 60 ? 'var(--red)' : 'var(--muted)'}">${t.rsi}</td>
                ${isRange
          ? `<td style="padding:5px 8px;color:var(--muted)">${t.bbWidth ? t.bbWidth + '%' : '—'}</td>`
          : `<td style="padding:5px 8px;color:${(t.volRatio || 0) >= 1.5 ? 'var(--green)' : 'var(--muted)'}">${t.volRatio ? t.volRatio + '×' : '—'}</td>`}
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