/* ═══════════════════════════════════════════════════════════════════
   CRYPTOPLAN IA — backtester.js v1.0
   Backtester de la estrategia usando datos históricos de Binance.

   Aplica los mismos filtros que el escáner real:
     - EMA200 (filtro de tendencia macro)
     - RSI < 35 sobrevendido / > 65 sobrecomprado
     - ATR para SL mínimo (1.5×ATR)
     - R:R mínimo 2.0
     - Ratios TP1 (1.2:1) y TP2 (2.5:1) con cierre parcial 50%

   No usa la IA — simula las señales puramente con indicadores técnicos
   para que puedas ver el rendimiento histórico de la estrategia mecánica.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Constantes del backtester ─────────────────────────────────────────── */
const BT = {
  TP1_RATIO:        1.2,
  TP2_RATIO:        2.5,
  PARTIAL_PCT:      0.5,   // cierre del 50% en TP1
  ATR_SL_MULT:      1.5,   // SL = 1.5 × ATR desde entrada
  MIN_RR:           2.0,
  FEE_TAKER:        0.0006,
  FEE_MAKER:        0.0002,
  RSI_OVERSOLD:     35,
  RSI_OVERBOUGHT:   65,
  EMA_FAST:         20,
  EMA_SLOW:         50,
  EMA_TREND:        200,
  RSI_PERIOD:       14,
  ATR_PERIOD:       14,
  MIN_CANDLES:      220,   // mínimo para calcular EMA200
};

/* ── Indicadores inline (no dependen de indicators.js) ─────────────────── */
function _btCalcRSI(closes, period = BT.RSI_PERIOD) {
  if (closes.length < period + 1) return 50;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function _btCalcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function _btCalcATR(highs, lows, closes, period = BT.ATR_PERIOD) {
  if (closes.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/* ── Descarga de datos Binance ─────────────────────────────────────────── */
async function btFetchKlines(symbol, interval, limit = 500) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Binance ${symbol}: HTTP ${res.status}`);
  const raw = await res.json();
  return raw.map(k => ({
    t: k[0],
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  }));
}

/* ── Motor del backtester ──────────────────────────────────────────────── */
/**
 * Ejecuta el backtest para un par y timeframe.
 * @param {string} coin      - ej. 'BTC'
 * @param {string} interval  - ej. '4h'
 * @param {number} riskUSD   - riesgo en USD por operación
 * @param {number} limit     - número de velas a analizar (máx 1000)
 * @returns {object} resultado del backtest
 */
async function runBacktest(coin, interval, riskUSD, limit = 500) {
  const symbol = coin.toUpperCase();
  const candles = await btFetchKlines(symbol, interval, Math.min(limit + BT.MIN_CANDLES, 1000));

  if (candles.length < BT.MIN_CANDLES + 10) {
    throw new Error(`Datos insuficientes para ${symbol}: ${candles.length} velas`);
  }

  const trades   = [];
  let equity     = 0;  // P&L acumulado en USD
  let openTrade  = null;

  // Iterar desde MIN_CANDLES (para tener historial suficiente para EMA200)
  for (let i = BT.MIN_CANDLES; i < candles.length - 1; i++) {
    const slice   = candles.slice(0, i + 1);
    const closes  = slice.map(c => c.c);
    const highs   = slice.map(c => c.h);
    const lows    = slice.map(c => c.l);

    // Si hay trade abierto, comprobar si tocó TP1, TP2 o SL
    if (openTrade) {
      const bar = candles[i];
      const { tipo, entrada, stopLoss, tp1, tp2, tp1Hit, size } = openTrade;

      if (tipo === 'LONG') {
        // TP1
        if (!tp1Hit && bar.h >= tp1) {
          const pnl1 = (tp1 - entrada) * size * BT.PARTIAL_PCT;
          const fee1 = tp1 * size * BT.PARTIAL_PCT * BT.FEE_MAKER;
          openTrade.tp1Hit    = true;
          openTrade.size      = size * (1 - BT.PARTIAL_PCT);
          openTrade.stopLoss  = entrada; // breakeven
          openTrade.tp1PnL    = pnl1 - fee1;
          equity             += pnl1 - fee1;
          continue;
        }
        // TP2
        if (tp1Hit && bar.h >= tp2) {
          const pnl2 = (tp2 - entrada) * openTrade.size;
          const fee2 = tp2 * openTrade.size * BT.FEE_MAKER;
          const totalPnl = (openTrade.tp1PnL || 0) + pnl2 - fee2;
          trades.push({ ...openTrade, result: 'WIN', pnl: totalPnl, exit: tp2, exitBar: i });
          equity    += pnl2 - fee2;
          openTrade  = null;
          continue;
        }
        // SL
        if (bar.l <= stopLoss) {
          const pnl = (stopLoss - entrada) * openTrade.size;
          const fee = stopLoss * openTrade.size * BT.FEE_TAKER;
          const netPnl = (openTrade.tp1PnL || 0) + pnl - fee;
          const result = openTrade.tp1Hit ? 'BREAKEVEN' : 'LOSS';
          trades.push({ ...openTrade, result, pnl: netPnl, exit: stopLoss, exitBar: i });
          equity    += pnl - fee;
          openTrade  = null;
          continue;
        }

      } else { // SHORT
        if (!tp1Hit && bar.l <= tp1) {
          const pnl1 = (entrada - tp1) * size * BT.PARTIAL_PCT;
          const fee1 = tp1 * size * BT.PARTIAL_PCT * BT.FEE_MAKER;
          openTrade.tp1Hit    = true;
          openTrade.size      = size * (1 - BT.PARTIAL_PCT);
          openTrade.stopLoss  = entrada;
          openTrade.tp1PnL    = pnl1 - fee1;
          equity             += pnl1 - fee1;
          continue;
        }
        if (tp1Hit && bar.l <= tp2) {
          const pnl2 = (entrada - tp2) * openTrade.size;
          const fee2 = tp2 * openTrade.size * BT.FEE_MAKER;
          const totalPnl = (openTrade.tp1PnL || 0) + pnl2 - fee2;
          trades.push({ ...openTrade, result: 'WIN', pnl: totalPnl, exit: tp2, exitBar: i });
          equity    += pnl2 - fee2;
          openTrade  = null;
          continue;
        }
        if (bar.h >= stopLoss) {
          const pnl = (entrada - stopLoss) * openTrade.size;
          const fee = stopLoss * openTrade.size * BT.FEE_TAKER;
          const netPnl = (openTrade.tp1PnL || 0) + pnl - fee;
          const result = openTrade.tp1Hit ? 'BREAKEVEN' : 'LOSS';
          trades.push({ ...openTrade, result, pnl: netPnl, exit: stopLoss, exitBar: i });
          equity    += pnl - fee;
          openTrade  = null;
          continue;
        }
      }
      continue; // trade abierto, no abrir otro
    }

    // Sin trade abierto — buscar señal
    const rsi    = _btCalcRSI(closes);
    const ema200 = _btCalcEMA(closes, BT.EMA_TREND);
    const ema50  = _btCalcEMA(closes, BT.EMA_SLOW);
    const ema20  = _btCalcEMA(closes, BT.EMA_FAST);
    const atr    = _btCalcATR(highs, lows, closes, BT.ATR_PERIOD);
    const price  = closes[closes.length - 1];

    let tipo = null;
    if (rsi <= BT.RSI_OVERSOLD  && price > ema200 && ema20 > ema50) tipo = 'LONG';
    if (rsi >= BT.RSI_OVERBOUGHT && price < ema200 && ema20 < ema50) tipo = 'SHORT';
    if (!tipo) continue;

    // SL basado en ATR
    const slDist = atr * BT.ATR_SL_MULT;
    if (slDist <= 0) continue;

    const entrada  = price;
    const stopLoss = tipo === 'LONG' ? entrada - slDist : entrada + slDist;
    const tp1      = tipo === 'LONG' ? entrada + slDist * BT.TP1_RATIO : entrada - slDist * BT.TP1_RATIO;
    const tp2      = tipo === 'LONG' ? entrada + slDist * BT.TP2_RATIO : entrada - slDist * BT.TP2_RATIO;

    // Filtro R:R mínimo
    const rr = slDist > 0 ? (Math.abs(tp1 - entrada) / slDist) : 0;
    if (rr < BT.MIN_RR) continue;

    const size    = riskUSD / slDist;
    const feeOpen = entrada * size * BT.FEE_TAKER;
    equity       -= feeOpen;

    openTrade = {
      id:       `bt_${i}`,
      coin,
      tipo,
      entrada,
      stopLoss,
      tp1, tp2,
      size,
      riskUSD,
      rr:       rr.toFixed(2),
      tp1Hit:   false,
      tp1PnL:   0,
      rsi:      Math.round(rsi),
      atr:      parseFloat(atr.toFixed(4)),
      ema200:   parseFloat(ema200.toFixed(2)),
      entryBar: i,
      entryDate: new Date(candles[i].t).toLocaleDateString('es-ES'),
    };
  }

  // Calcular estadísticas
  const wins       = trades.filter(t => t.result === 'WIN').length;
  const losses     = trades.filter(t => t.result === 'LOSS').length;
  const breakevens = trades.filter(t => t.result === 'BREAKEVEN').length;
  const winRate    = trades.length > 0 ? (wins / trades.length * 100) : 0;
  const totalPnl   = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const avgWin     = wins > 0 ? trades.filter(t=>t.result==='WIN').reduce((a,t)=>a+t.pnl,0)/wins : 0;
  const avgLoss    = losses > 0 ? Math.abs(trades.filter(t=>t.result==='LOSS').reduce((a,t)=>a+t.pnl,0)/losses) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins) / (avgLoss * losses) : wins > 0 ? Infinity : 0;

  // Curva de equity
  let cumPnl = 0, peak = 0, maxDD = 0;
  const equityCurve = trades.map(t => {
    cumPnl += t.pnl || 0;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
    return { date: t.entryDate, cumPnl: parseFloat(cumPnl.toFixed(2)), result: t.result };
  });

  return {
    coin,
    interval,
    totalTrades:  trades.length,
    wins,
    losses,
    breakevens,
    winRate:      parseFloat(winRate.toFixed(1)),
    totalPnl:     parseFloat(totalPnl.toFixed(2)),
    avgWin:       parseFloat(avgWin.toFixed(2)),
    avgLoss:      parseFloat(avgLoss.toFixed(2)),
    profitFactor: isFinite(profitFactor) ? parseFloat(profitFactor.toFixed(2)) : 99,
    maxDrawdown:  parseFloat(maxDD.toFixed(2)),
    trades,
    equityCurve,
  };
}

/* ── UI del Backtester ─────────────────────────────────────────────────── */
function renderBacktester() {
  const root = qs('#sec-backtest');
  if (!root) return;

  const riskUSD = getDynamicRiskUSD();

  root.innerHTML = `
    <div style="padding:0 0 24px">
      <div class="sec-hdr">
        <div>
          <div class="stl" style="margin:0 0 6px">📊 Backtester de Estrategia</div>
          <div style="font-size:11px;color:var(--muted)">Simula la estrategia mecánica (EMA200 + RSI + ATR) sobre datos históricos de Binance.</div>
        </div>
      </div>

      <!-- Config -->
      <div class="card" style="margin-bottom:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px;align-items:end">
          <div>
            <div class="lbl">Par</div>
            <select class="inp" id="bt-coin">
              ${state.watchedCoins.map(c => `<option value="${c}">${c}/USDT</option>`).join('')}
            </select>
          </div>
          <div>
            <div class="lbl">Timeframe</div>
            <select class="inp" id="bt-interval">
              <option value="1h">1H</option>
              <option value="4h" selected>4H ★</option>
              <option value="1d">1D</option>
            </select>
          </div>
          <div>
            <div class="lbl">Velas (histórico)</div>
            <select class="inp" id="bt-limit">
              <option value="300">~50 días (4H)</option>
              <option value="500" selected>~83 días (4H)</option>
              <option value="800">~133 días (4H)</option>
            </select>
          </div>
          <button class="btn btng" style="padding:9px 18px;font-size:12px;font-weight:600" onclick="startBacktest()">
            ▶ Ejecutar
          </button>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:10px">
          💡 Riesgo por operación: <b style="color:var(--accent)">$${riskUSD.toFixed(2)}</b> (${state.profile.risk_pct || 1}% de $${getCurrentEquity().toFixed(0)})
          · El backtester usa los mismos parámetros de tu estrategia activa.
        </div>
      </div>

      <!-- Resultados -->
      <div id="bt-results"></div>
    </div>`;
}

async function startBacktest() {
  const coin     = qs('#bt-coin')?.value || 'BTC';
  const interval = qs('#bt-interval')?.value || '4h';
  const limit    = parseInt(qs('#bt-limit')?.value || '500');
  const riskUSD  = getDynamicRiskUSD();
  const resultsEl = qs('#bt-results');
  if (!resultsEl) return;

  resultsEl.innerHTML = `
    <div class="card" style="text-align:center;padding:30px">
      <div class="spinner-p" style="margin:0 auto 12px"></div>
      <div style="font-size:12px;color:var(--muted)">Descargando ${limit} velas de ${coin}/USDT ${interval.toUpperCase()} desde Binance…</div>
    </div>`;

  try {
    const result = await runBacktest(coin, interval, riskUSD, limit);
    renderBacktestResults(result, resultsEl);
  } catch (e) {
    resultsEl.innerHTML = `
      <div class="card" style="border-color:rgba(255,68,85,.3);padding:20px;text-align:center">
        <div style="color:var(--red);font-size:13px">❌ Error: ${e.message}</div>
        <div style="color:var(--muted);font-size:11px;margin-top:6px">Comprueba tu conexión a internet e inténtalo de nuevo.</div>
      </div>`;
  }
}

function renderBacktestResults(r, container) {
  const pnlColor  = v => v >= 0 ? 'var(--green)' : 'var(--red)';
  const pfColor   = r.profitFactor >= 1.5 ? 'var(--green)' : r.profitFactor >= 1 ? 'var(--yellow)' : 'var(--red)';
  const wrColor   = r.winRate >= 50 ? 'var(--green)' : r.winRate >= 40 ? 'var(--yellow)' : 'var(--red)';

  // Mini curva de equity SVG
  const curve = r.equityCurve;
  let svgPath = '';
  if (curve.length > 1) {
    const minP = Math.min(...curve.map(p => p.cumPnl));
    const maxP = Math.max(...curve.map(p => p.cumPnl));
    const range = maxP - minP || 1;
    const W = 400, H = 60;
    const pts = curve.map((p, i) => {
      const x = (i / (curve.length - 1)) * W;
      const y = H - ((p.cumPnl - minP) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    svgPath = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:60px;margin:8px 0">
      <polyline points="${pts.join(' ')}" fill="none" stroke="${r.totalPnl >= 0 ? '#00d17a' : '#ff4455'}" stroke-width="2"/>
      <line x1="0" y1="${(H - ((0 - minP)/range)*H).toFixed(1)}" x2="${W}" y2="${(H - ((0 - minP)/range)*H).toFixed(1)}" stroke="rgba(255,255,255,.15)" stroke-dasharray="4"/>
    </svg>`;
  }

  container.innerHTML = `
    <!-- KPIs -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px">
      ${kpiCard('Trades', r.totalTrades, 'var(--text)', '')}
      ${kpiCard('Win Rate', r.winRate + '%', wrColor, `${r.wins}W / ${r.losses}L / ${r.breakevens}BE`)}
      ${kpiCard('P&L Total', (r.totalPnl >= 0 ? '+' : '') + '$' + r.totalPnl.toFixed(2), pnlColor(r.totalPnl), 'neto con fees')}
      ${kpiCard('Profit Factor', r.profitFactor === 99 ? '∞' : r.profitFactor, pfColor, '≥ 1.5 = bueno')}
      ${kpiCard('Max Drawdown', '-$' + r.maxDrawdown.toFixed(2), 'var(--red)', 'pérdida máx acumulada')}
      ${kpiCard('Avg Win', '+$' + r.avgWin.toFixed(2), 'var(--green)', 'por operación ganadora')}
      ${kpiCard('Avg Loss', '-$' + r.avgLoss.toFixed(2), 'var(--red)', 'por operación perdedora')}
    </div>

    <!-- Curva de equity -->
    <div class="card" style="margin-bottom:14px">
      <div class="stl" style="margin-bottom:4px">📈 Curva de Equity</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px">${r.coin}/USDT ${r.interval.toUpperCase()} · ${r.totalTrades} operaciones · Riesgo $${r.trades[0]?.riskUSD?.toFixed(2)||'?'}/op</div>
      ${svgPath || '<div style="font-size:11px;color:var(--muted);padding:10px 0">Sin suficientes trades para mostrar curva.</div>'}
    </div>

    <!-- Diagnóstico -->
    <div class="card" style="margin-bottom:14px">
      <div class="stl" style="margin-bottom:10px">🔍 Diagnóstico</div>
      ${r.totalTrades < 10 ? '<div style="font-size:11px;color:var(--yellow);margin-bottom:8px">⚠️ Pocos trades para estadísticas fiables. Aumenta el rango de velas o elige un timeframe menor.</div>' : ''}
      ${r.profitFactor < 1 ? '<div style="font-size:11px;color:var(--red);margin-bottom:6px">❌ Profit Factor < 1: la estrategia pierde dinero en este par/timeframe con estos parámetros.</div>' : ''}
      ${r.winRate < 40 ? '<div style="font-size:11px;color:var(--yellow);margin-bottom:6px">⚠️ Win Rate < 40%: considera ajustar el RSI umbral o el ratio de TP.</div>' : ''}
      ${r.profitFactor >= 1.5 && r.winRate >= 45 ? '<div style="font-size:11px;color:var(--green);margin-bottom:6px">✅ Estrategia rentable en este periodo. PF ≥ 1.5 y WR aceptable.</div>' : ''}
      <div style="font-size:10px;color:var(--muted);line-height:1.6">
        · SL = 1.5×ATR | TP1 = 1.2:1 (cierre 50%) | TP2 = 2.5:1<br>
        · Señal LONG: RSI ≤ ${BT.RSI_OVERSOLD} + precio > EMA200 + EMA20 > EMA50<br>
        · Señal SHORT: RSI ≥ ${BT.RSI_OVERBOUGHT} + precio < EMA200 + EMA20 < EMA50<br>
        · Comisiones incluidas: ${(BT.FEE_TAKER*100).toFixed(2)}% taker apertura, ${(BT.FEE_MAKER*100).toFixed(2)}% maker cierre
      </div>
    </div>

    <!-- Historial de trades -->
    ${r.trades.length > 0 ? `
    <div class="card">
      <div class="stl" style="margin-bottom:10px">📋 Últimos 20 trades simulados</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead>
            <tr style="color:var(--muted);text-align:left">
              <th style="padding:4px 8px">#</th>
              <th style="padding:4px 8px">Fecha</th>
              <th style="padding:4px 8px">Tipo</th>
              <th style="padding:4px 8px">Entrada</th>
              <th style="padding:4px 8px">SL</th>
              <th style="padding:4px 8px">R:R</th>
              <th style="padding:4px 8px">RSI</th>
              <th style="padding:4px 8px">P&L</th>
              <th style="padding:4px 8px">Result</th>
            </tr>
          </thead>
          <tbody>
            ${r.trades.slice(-20).reverse().map((t, i) => `
              <tr style="border-top:1px solid var(--border)">
                <td style="padding:5px 8px;color:var(--muted)">${r.trades.length - i}</td>
                <td style="padding:5px 8px;font-family:var(--font-mono)">${t.entryDate}</td>
                <td style="padding:5px 8px;color:${t.tipo === 'LONG' ? 'var(--green)' : 'var(--red)'};font-weight:600">${t.tipo}</td>
                <td style="padding:5px 8px;font-family:var(--font-mono)">${fmtP(t.entrada, r.coin)}</td>
                <td style="padding:5px 8px;color:var(--red);font-family:var(--font-mono)">${fmtP(t.stopLoss, r.coin)}</td>
                <td style="padding:5px 8px">${t.rr}</td>
                <td style="padding:5px 8px;color:${t.rsi <= 35 ? 'var(--green)' : t.rsi >= 65 ? 'var(--red)' : 'var(--muted)'}">${t.rsi}</td>
                <td style="padding:5px 8px;font-weight:700;color:${(t.pnl||0) >= 0 ? 'var(--green)' : 'var(--red)'}">${(t.pnl >= 0 ? '+' : '') + '$' + (t.pnl || 0).toFixed(2)}</td>
                <td style="padding:5px 8px">${t.result === 'WIN' ? '✅' : t.result === 'BREAKEVEN' ? '↔️' : '❌'} ${t.result}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : '<div class="card" style="text-align:center;padding:20px;color:var(--muted)">Sin trades generados — ninguna señal RSI + EMA200 encontrada en el periodo seleccionado.</div>'}`;
}

function kpiCard(label, value, color, sub) {
  return `
    <div class="card" style="padding:12px 14px">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px">${label}</div>
      <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:${color}">${value}</div>
      ${sub ? `<div style="font-size:9px;color:var(--muted);margin-top:2px">${sub}</div>` : ''}
    </div>`;
}