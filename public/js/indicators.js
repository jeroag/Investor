/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — indicators.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════
   MOTOR DE INDICADORES TÉCNICOS
   ══════════════════════════════════════════════════════════ */

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
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
  if (al === 0) return 100;
  return Math.round(100 - 100 / (1 + ag / al));
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const macdSeries = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i), 12);
    const e26 = calcEMA(closes.slice(0, i), 26);
    if (e12 !== null && e26 !== null) macdSeries.push(e12 - e26);
  }
  const macdLine = macdSeries[macdSeries.length - 1];
  const signal = macdSeries.length >= 9 ? calcEMA(macdSeries, 9) : null;
  return { macd: macdLine, signal, hist: signal !== null ? macdLine - signal : null };
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period);
  return { upper: sma + mult * std, mid: sma, lower: sma - mult * std, width: (4 * std) / sma * 100 };
}

function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++)
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function analyzeVolume(volumes) {
  if (volumes.length < 21) return null;
  const recent = volumes.slice(-1)[0];
  const avg20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const ratio = recent / avg20;
  const t5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  return {
    ratio: parseFloat(ratio.toFixed(2)),
    signal: ratio > 1.5 ? 'ALTO — confirma movimiento' : ratio < 0.7 ? 'BAJO — movimiento débil' : 'normal',
    trending: t5 > avg20 * 1.1 ? 'creciente' : t5 < avg20 * 0.9 ? 'decreciente' : 'estable',
  };
}

function detectCandlePatterns(opens, highs, lows, closes) {
  const patterns = [];
  const n = closes.length - 1;
  if (n < 2) return patterns;
  const o = opens[n], h = highs[n], l = lows[n], c = closes[n];
  const po = opens[n - 1], ph = highs[n - 1], pl = lows[n - 1], pc = closes[n - 1];
  const body = Math.abs(c - o), range = h - l, prevBody = Math.abs(pc - po);
  if (body < range * 0.3 && (l < Math.min(o, c) - range * 0.4) && (h - Math.max(o, c)) < body && c > o)
    patterns.push({ name: 'Martillo', bias: 'ALCISTA', strength: 'MEDIA' });
  if (body < range * 0.3 && (h - Math.max(o, c)) > range * 0.4 && (Math.min(o, c) - l) < body && c < o)
    patterns.push({ name: 'Shooting Star', bias: 'BAJISTA', strength: 'MEDIA' });
  if (c > o && pc < po && c > po && o < pc && body > prevBody)
    patterns.push({ name: 'Engulfing Alcista', bias: 'ALCISTA', strength: 'FUERTE' });
  if (c < o && pc > po && c < po && o > pc && body > prevBody)
    patterns.push({ name: 'Engulfing Bajista', bias: 'BAJISTA', strength: 'FUERTE' });
  if (body < range * 0.1 && range > 0)
    patterns.push({ name: 'Doji', bias: 'NEUTRO — indecisión', strength: 'BAJA' });
  if (c < o && body > range * 0.7)
    patterns.push({ name: 'Vela Bajista Fuerte', bias: 'BAJISTA', strength: 'FUERTE' });
  if (c > o && body > range * 0.7)
    patterns.push({ name: 'Vela Alcista Fuerte', bias: 'ALCISTA', strength: 'FUERTE' });
  return patterns;
}

function calcKeyLevels(highs, lows, closes) {
  const swingH = [], swingL = [];
  const range = Math.min(closes.length - 2, 50);
  for (let i = 1; i < range; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) swingH.push(highs[i]);
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) swingL.push(lows[i]);
  }
  const price = closes[closes.length - 1];
  const sup = swingL.filter(l => l < price).sort((a, b) => b - a)[0] || Math.min(...lows.slice(-20));
  const res = swingH.filter(h => h > price).sort((a, b) => a - b)[0] || Math.max(...highs.slice(-20));
  return { sup, res };
}

function calcConfluence(meta) {
  let bull = 0, bear = 0;
  const r = meta.rsi;
  if (typeof r === 'number') {
    if (r < 35) bull += 2; else if (r < 45) bull += 1;
    else if (r > 65) bear += 2; else if (r > 55) bear += 1;
  }
  if (meta.ema) {
    const { price, ema20, ema50, ema200 } = meta.ema;
    if (price > ema20) bull++; else bear++;
    if (price > ema50) bull++; else bear++;
    if (ema20 > ema50) bull++; else bear++;
    if (ema200) { if (price > ema200) bull++; else bear++; }
  }
  if (meta.macd?.hist != null) {
    if (meta.macd.hist > 0) bull++; else bear++;
    if (meta.macd.macd > 0) bull++; else bear++;
  }
  if (meta.bb) {
    const { price, lower, upper, mid } = meta.bb;
    if (price < lower) bull += 2; else if (price > upper) bear += 2;
    else if (price < mid) bull++; else bear++;
  }
  (meta.patterns || []).forEach(p => {
    if (p.bias === 'ALCISTA') bull += p.strength === 'FUERTE' ? 2 : 1;
    if (p.bias === 'BAJISTA') bear += p.strength === 'FUERTE' ? 2 : 1;
  });
  const total = bull + bear, score = total > 0 ? Math.round(bull / total * 100) : 50;
  return { bull, bear, score, bias: score >= 65 ? 'ALCISTA' : score <= 35 ? 'BAJISTA' : 'NEUTRO' };
}

function rsiTag(rsi) {
  if (rsi === null || rsi === undefined) return { tag: '—', cls: 'tm' };
  if (rsi < 30) return { tag: 'SOBREVENDIDO', cls: 'tg' };
  if (rsi < 45) return { tag: 'ACUMULAR', cls: 'tg' };
  if (rsi < 55) return { tag: 'NEUTRO', cls: 'tm' };
  if (rsi < 70) return { tag: 'CAUTELA', cls: 'ty' };
  return { tag: 'SOBRECOMPRADO', cls: 'tr' };
}

function fmtSup(price, coin) {
  if (coin === 'XRP' || coin === 'DOGE') return '$' + price.toFixed(4);
  if (price > 1000) return '$' + (price / 1000).toFixed(1) + 'K';
  return '$' + price.toFixed(2);
}

async function fetchMarketMeta() {
  const coins = state.watchedCoins;
  initMarketMeta(coins);

  // Procesar monedas de una en una con micro-pausa entre ellas
  // para no saturar la red ni bloquear el hilo principal
  for (const coin of coins) {
    try {
      const symbol = coin + 'USDT';
      const [r4h, r1d] = await Promise.all([
        fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=4h&limit=200`),
        fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=60`),
      ]);
      if (!r4h.ok) continue;
      const k4h = await r4h.json();
      const k1d = r1d.ok ? await r1d.json() : [];

      const closes4h = k4h.map(k => parseFloat(k[4]));
      const opens4h = k4h.map(k => parseFloat(k[1]));
      const highs4h = k4h.map(k => parseFloat(k[2]));
      const lows4h = k4h.map(k => parseFloat(k[3]));
      const volumes4h = k4h.map(k => parseFloat(k[5]));
      const closes1d = k1d.map(k => parseFloat(k[4]));
      const highs1d = k1d.map(k => parseFloat(k[2]));
      const lows1d = k1d.map(k => parseFloat(k[3]));

      const rsi4h = calcRSI(closes4h);
      const rsi1d = calcRSI(closes1d);
      const ema20 = calcEMA(closes4h, 20);
      const ema50 = calcEMA(closes4h, 50);
      const ema200 = calcEMA(closes4h, 200);
      const macd = calcMACD(closes4h);
      const bb = calcBB(closes4h, 20);
      const atr = calcATR(highs4h, lows4h, closes4h, 14);
      const vol = analyzeVolume(volumes4h);
      const patterns = detectCandlePatterns(opens4h, highs4h, lows4h, closes4h);
      const { sup, res: resistance } = calcKeyLevels(highs4h, lows4h, closes4h);
      const { sup: supDay, res: resDay } = closes1d.length > 5
        ? calcKeyLevels(highs1d, lows1d, closes1d) : { sup, res: resistance };

      const price = closes4h[closes4h.length - 1];
      const ema50_1d = calcEMA(closes1d, 50);
      const ema200_1d = calcEMA(closes1d, 200);
      const macroTrend = ema50_1d && ema200_1d
        ? (ema50_1d > ema200_1d && price > ema50_1d ? 'ALCISTA'
          : ema50_1d < ema200_1d && price < ema50_1d ? 'BAJISTA' : 'LATERAL')
        : 'LATERAL';

      const { tag, cls } = rsiTag(rsi4h);

      const last1d = k1d.length >= 1 ? k1d[k1d.length - 1] : null;
      const open24h = last1d ? parseFloat(last1d[1]) : null;
      const change24h = (open24h && open24h > 0) ? ((price - open24h) / open24h * 100) : null;

      MARKET_META[coin] = {
        tag, cls,
        rsi: rsi4h ?? '—',
        rsi1d: rsi1d ?? '—',
        sup: fmtSup(sup, coin),
        res: fmtSup(resistance, coin),
        supRaw: sup, resRaw: resistance,
        supDay: fmtSup(supDay, coin),
        resDay: fmtSup(resDay, coin),
        ema: { price, ema20: ema20 ? +ema20.toFixed(2) : null, ema50: ema50 ? +ema50.toFixed(2) : null, ema200: ema200 ? +ema200.toFixed(2) : null },
        macd: macd ? { macd: +macd.macd.toFixed(4), signal: macd.signal ? +macd.signal.toFixed(4) : null, hist: macd.hist ? +macd.hist.toFixed(4) : null } : null,
        bb: bb ? { price, upper: +bb.upper.toFixed(2), mid: +bb.mid.toFixed(2), lower: +bb.lower.toFixed(2), width: +bb.width.toFixed(1) } : null,
        atr: atr ? +atr.toFixed(4) : null,
        change24h: change24h != null ? +change24h.toFixed(2) : null,
        vol, patterns, macroTrend,
      };
      MARKET_META[coin].confluence = calcConfluence(MARKET_META[coin]);

      // Actualizar la pestaña Mercado con cada moneda que llega (progresivo)
      if (state.currentTab === 'mkt') renderMkt();

      // Ceder el hilo al navegador entre monedas para evitar bloqueo
      await new Promise(r => setTimeout(r, 0));

    } catch (e) {
      console.warn(`fetchMarketMeta ${coin}:`, e.message);
    }
  }
}

// NOTA: El objeto 'storage' se ha movido a core.js (debe cargarse antes que state)