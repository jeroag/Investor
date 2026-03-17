/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — ui-market.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── TradingView chart modal ─────────────────────────────────────────────── */
function openChart(coin) {
  const existing = qs('#tv-modal');
  if (existing) existing.remove();

  const modal = el('div', '');
  modal.id = 'tv-modal';
  modal.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(44,40,37,.35);backdrop-filter:blur(4px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .2s ease">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;width:100%;max-width:860px;overflow:hidden;box-shadow:var(--shadow-lg)">
        <div style="padding:13px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div>
            <span style="font-family:var(--serif);font-size:15px;font-weight:600">${COIN_NAMES[coin] || coin}</span>
            <span style="color:var(--muted);font-size:11px;margin-left:8px">${coin}/USDT</span>
          </div>
          <button onclick="qs('#tv-modal').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:20px;line-height:1;padding:4px">×</button>
        </div>
        <div style="height:480px">
        <iframe
            src="https://www.tradingview.com/widgetembed/?symbol=BINANCE:${coin}USDT&interval=4H&theme=dark&style=1&locale=es&toolbar_bg=%230B0D11&hide_top_toolbar=0&hide_side_toolbar=0&allow_symbol_change=0&save_image=0&calendar=0&studies=RSI%4014"
            style="width:100%;height:100%;border:none"
            allowtransparency="true"
            frameborder="0">
          </iframe>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Cerrar con Escape
  const onKey = (e) => { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  // Cerrar al click en backdrop
  modal.querySelector('div').addEventListener('click', (e) => { if (e.target === e.currentTarget) modal.remove(); });
}

/* ── Gráfico inline por trade (Lightweight Charts + Binance OHLCV) ────────── */
const _tradeChartInstances = {};
const _tradeChartTimeframes = {};  // id → '1h'|'4h'|'1d'

function toggleTradeChart(tradeId) {
  const panel = qs(`#chart-panel-${tradeId}`);
  const btn   = qs(`#chart-btn-${tradeId}`);
  if (!panel) return;

  const isOpen = panel.style.display !== 'none';
  if (isOpen) {
    panel.style.display = 'none';
    if (btn) { btn.style.background = ''; btn.style.color = ''; }
    if (_tradeChartInstances[tradeId]) {
      try { _tradeChartInstances[tradeId].remove(); } catch {}
      delete _tradeChartInstances[tradeId];
    }
    delete _tradeChartTimeframes[tradeId];
  } else {
    panel.style.display = 'block';
    if (btn) { btn.style.background = 'var(--accent)'; btn.style.color = '#fff'; }
    _tradeChartTimeframes[tradeId] = _tradeChartTimeframes[tradeId] || '4h';
    loadTradeChart(tradeId, _tradeChartTimeframes[tradeId]);
  }
}

function reloadTradeChart(tradeId, interval) {
  _tradeChartTimeframes[tradeId] = interval;
  if (_tradeChartInstances[tradeId]) {
    try { _tradeChartInstances[tradeId].remove(); } catch {}
    delete _tradeChartInstances[tradeId];
  }
  // Actualizar estilo de botones de timeframe
  ['1h','4h','1d'].forEach(tf => {
    const tfBtn = qs(`#chart-tf-${tradeId}-${tf}`);
    if (!tfBtn) return;
    const active = tf === interval;
    tfBtn.style.background   = active ? 'var(--accent)' : 'var(--s2)';
    tfBtn.style.color        = active ? '#fff' : 'var(--muted)';
    tfBtn.style.borderColor  = active ? 'var(--accent)' : 'var(--border)';
  });
  loadTradeChart(tradeId, interval);
}

async function loadTradeChart(tradeId, interval) {
  const trade = state.activeTrades.find(t => t.id === tradeId);
  if (!trade) return;

  const container = qs(`#chart-canvas-${tradeId}`);
  if (!container) return;

  const coin   = coinOf(trade.par);
  const symbol = coin + 'USDT';

  // Loading state
  container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;gap:8px;color:var(--muted);font-size:12px"><span class="spinner"></span>Cargando velas...</div>`;

  try {
    // Fetch OHLCV desde Binance REST
    const limit = interval === '1d' ? 90 : 120;
    const resp  = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();

    const candles = raw.map(k => ({
      time:  Math.floor(k[0] / 1000),
      open:  parseFloat(k[1]),
      high:  parseFloat(k[2]),
      low:   parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));

    container.innerHTML = '';

    const isDark = state.darkMode;
    const bg     = isDark ? '#0B0D11' : '#FAFAF8';
    const grid   = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)';
    const txt    = isDark ? '#9CA3AF' : '#6B7280';

    const chart = LightweightCharts.createChart(container, {
      width:  container.clientWidth || 600,
      height: 280,
      layout: {
        background:  { color: bg },
        textColor:   txt,
        fontSize:    11,
      },
      grid: {
        vertLines: { color: grid },
        horzLines: { color: grid },
      },
      crosshair:       { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale:       { borderVisible: false, timeVisible: true, secondsVisible: false },
      handleScroll:    true,
      handleScale:     true,
    });

    const series = chart.addCandlestickSeries({
      upColor:        '#22c55e',
      downColor:      '#ef4444',
      borderUpColor:  '#22c55e',
      borderDownColor:'#ef4444',
      wickUpColor:    '#4ade80',
      wickDownColor:  '#f87171',
    });

    series.setData(candles);

    // ── Líneas de nivel ──────────────────────────────────────────────────
    series.createPriceLine({
      price:     trade.entrada,
      color:     '#00C8FF',
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      title:     `▶ Entrada`,
    });

    series.createPriceLine({
      price:     trade.stopLoss,
      color:     '#FF3B58',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      title:     `✕ SL`,
    });

    series.createPriceLine({
      price:     trade.tp1,
      color:     '#00D17A',
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      title:     `★ TP1`,
    });

    if (trade.tp2) {
      series.createPriceLine({
        price:     trade.tp2,
        color:     '#00D17A',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        title:     `★ TP2`,
      });
    }

    // Ajustar al contenido y luego al precio actual
    chart.timeScale().fitContent();

    // Responsive resize
    const ro = new ResizeObserver(() => {
      if (container.clientWidth > 0) chart.applyOptions({ width: container.clientWidth });
    });
    ro.observe(container);

    // Guardar instancia con cleanup
    const origRemove = chart.remove.bind(chart);
    chart.remove = () => { try { ro.disconnect(); origRemove(); } catch {} };
    _tradeChartInstances[tradeId] = chart;

  } catch (err) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--red);font-size:12px">⚠ Error al cargar gráfico: ${err.message}</div>`;
  }
}

/* ── Render: Market ──────────────────────────────────────────────────────── */
function renderMkt() {
  const root = qs('#sec-mkt');
  if (!root) return;

  let cards = '';
  state.watchedCoins.forEach(coin => {
    const meta = MARKET_META[coin] || { tag:'—', cls:'tm', rsi:'...', sup:'...', res:'...' };
    const p    = state.prices[coin];
    const prev = state.prevPrices[coin];
    const up   = p && prev && p > prev;
    const dn   = p && prev && p < prev;
    const bc   = up ? '#BCD9C5' : dn ? '#D9BCBC' : 'var(--border)';
    const conf = meta.confluence;
    const confColor = conf ? (conf.score>=65?'var(--green)':conf.score<=35?'var(--red)':'var(--yellow)') : 'var(--muted)';

    // EMA pill
    const emaPill = meta.ema?.ema200 ? `
      <span style="font-size:9px;padding:2px 5px;border-radius:3px;background:${p>meta.ema.ema200?'rgba(130,173,143,.2)':'rgba(201,126,126,.15)'};color:${p>meta.ema.ema200?'var(--green)':'var(--red)'}">
        ${p>meta.ema.ema200?'▲':'▼'} EMA200
      </span>` : '';

    // MACD pill
    const macdPill = meta.macd?.hist != null ? `
      <span style="font-size:9px;padding:2px 5px;border-radius:3px;background:${meta.macd.hist>0?'rgba(130,173,143,.2)':'rgba(201,126,126,.15)'};color:${meta.macd.hist>0?'var(--green)':'var(--red)'}">
        MACD ${meta.macd.hist>0?'▲':'▼'}
      </span>` : '';

    // BB pill
    const bbPill = meta.bb ? (() => {
      const pos = p < meta.bb.lower ? 'BAJO BB' : p > meta.bb.upper ? 'SOBRE BB' : null;
      return pos ? `<span style="font-size:9px;padding:2px 5px;border-radius:3px;background:${p<meta.bb.lower?'rgba(130,173,143,.2)':'rgba(201,126,126,.15)'};color:${p<meta.bb.lower?'var(--green)':'var(--red)'}">${pos}</span>` : '';
    })() : '';

    // Patrones
    const patternPill = meta.patterns?.length > 0
      ? `<span style="font-size:9px;padding:2px 5px;border-radius:3px;background:rgba(123,167,188,.15);color:var(--accent)">${meta.patterns[0].name}</span>`
      : '';

    cards += `
      <div class="card" id="mkt-${coin}" style="border-color:${bc};transition:border-color .5s">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div>
            <div style="font-family:var(--serif);font-size:15px;font-weight:600;color:var(--text);line-height:1.2">${COIN_NAMES[coin]||coin}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:1px">${coin} · USDT · 1D: <b style="color:${meta.macroTrend==='ALCISTA'?'var(--green)':meta.macroTrend==='BAJISTA'?'var(--red)':'var(--muted)'}">${meta.macroTrend||'—'}</b></div>
          </div>
          <span class="tag ${meta.cls}">${meta.tag}</span>
        </div>
        <div style="font-size:20px;font-weight:600;font-family:var(--serif);margin-bottom:2px;transition:color .3s;color:${up?'var(--green)':dn?'var(--red)':'var(--text)'}" id="mkt-price-${coin}">
          ${p ? fmtP(p, coin) : '<span style="color:var(--muted);font-size:13px">...</span>'}
        </div>
        <div style="font-size:11px;font-weight:600;margin-bottom:8px" id="mkt-chg-${coin}">
          ${meta.change24h != null
            ? `<span style="color:${meta.change24h>=0?'var(--green)':'var(--red)'}">${meta.change24h>=0?'▲ +':'▼ '}${Math.abs(meta.change24h).toFixed(2)}% 24h</span>`
            : '<span style="color:var(--muted)">— 24h</span>'}
        </div>

        <!-- Indicadores pills -->
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">
          ${emaPill}${macdPill}${bbPill}${patternPill}
        </div>

        <!-- KPIs -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px">
          <div class="cs"><div class="csl">RSI 4H</div><div class="csv" style="color:${typeof meta.rsi==='number'&&meta.rsi<35?'var(--green)':typeof meta.rsi==='number'&&meta.rsi>65?'var(--red)':'var(--text)'}">${meta.rsi}</div></div>
          <div class="cs"><div class="csl">RSI 1D</div><div class="csv" style="color:${typeof meta.rsi1d==='number'&&meta.rsi1d<40?'var(--green)':typeof meta.rsi1d==='number'&&meta.rsi1d>60?'var(--red)':'var(--text)'}">${meta.rsi1d||'—'}</div></div>
          <div class="cs"><div class="csl">Soporte 4H</div><div class="csv" style="color:var(--green);font-size:11px">${meta.sup}</div></div>
          <div class="cs"><div class="csl">Resist. 4H</div><div class="csv" style="color:var(--red);font-size:11px">${meta.res}</div></div>
          ${meta.atr ? `<div class="cs"><div class="csl">ATR</div><div class="csv" style="font-size:11px">${fmtP(meta.atr,coin)}</div></div>` : ''}
          ${meta.vol ? `<div class="cs"><div class="csl">Volumen</div><div class="csv" style="font-size:10px;color:${meta.vol.ratio>1.5?'var(--green)':meta.vol.ratio<0.7?'var(--red)':'var(--text)'}">${meta.vol.ratio}× avg</div></div>` : ''}
        </div>

        <!-- Confluencia -->
        ${conf ? `
        <div style="margin-bottom:10px;padding:7px 10px;background:var(--s2);border-radius:8px;border-left:3px solid ${confColor}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:10px;font-weight:600;color:var(--text)">Confluencia ${conf.bias}</span>
            <span style="font-family:var(--serif);font-size:13px;font-weight:700;color:${confColor}">${conf.score}%</span>
          </div>
          <div style="height:4px;background:var(--border);border-radius:2px">
            <div style="height:100%;width:${conf.score}%;background:${confColor};border-radius:2px;transition:width .5s"></div>
          </div>
          <div style="font-size:9px;color:var(--muted);margin-top:3px">${conf.bull}↑ alcistas · ${conf.bear}↓ bajistas</div>
        </div>` : ''}

        <button class="btn" style="width:100%;justify-content:center;font-size:10px;padding:5px" onclick="openChart('${coin}')">
          📈 Ver gráfico
        </button>
      </div>`;
  });

  root.innerHTML = `
    <div class="stl">Mercado — Binance Live</div>
    <div style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-bottom:16px">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:blink 2.5s infinite"></span>
      Precios en tiempo real · WebSocket Binance · Indicadores: RSI, EMA, MACD, BB, ATR, Volumen, Patrones
    </div>
    <div class="grid-market">${cards}</div>`;
}

function updateMarketPrice(coin, price) {
  const prev  = state.prevPrices[coin];
  const priceEl = qs(`#mkt-price-${coin}`);
  const chgEl   = qs(`#mkt-chg-${coin}`);
  const card    = qs(`#mkt-${coin}`);
  if (!priceEl) return;

  const up = prev && price > prev;
  const dn = prev && price < prev;
  const chg = prev ? ((price - prev) / prev * 100) : 0;

  priceEl.textContent = fmtP(price, coin);
  priceEl.style.color = up ? 'var(--green)' : dn ? 'var(--red)' : 'var(--accent)';
  // 24h change is managed by renderMkt, not overwritten by tick updates
  if (card) card.style.borderColor = up ? '#BCD9C5' : dn ? '#D9BCBC' : 'var(--border)';
}
