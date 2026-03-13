'use strict';

/**
 * Tests para cálculos críticos de CryptoPlan IA
 * Ejecutar con: npm test  (o: node --test tests/calculations.test.js)
 *
 * Importa SOLO de calculations.js — sin dependencias externas.
 * Cubre: calcPnL, TP/SL logic, calcRSI, calcMaxDrawdown, calcEMA,
 *        calcSupportResistance
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  calcPnL,
  coinOf,
  calcRSI,
  calcEMA,
  calcSupportResistance,
  calcMaxDrawdown,
} = require('../src/services/calculations');

/* ════════════════════════════════════════════════════════════════
   SUITE 1 — calcPnL
   ════════════════════════════════════════════════════════════════ */
describe('calcPnL — cálculo de PnL', () => {

  it('LONG sin leverage: precio sube → ganancia', () => {
    const trade = { tipo: 'LONG', entrada: 100, size: 1, leverage: 1 };
    assert.equal(calcPnL(trade, 110), 10);
  });

  it('LONG sin leverage: precio baja → pérdida', () => {
    const trade = { tipo: 'LONG', entrada: 100, size: 1, leverage: 1 };
    assert.equal(calcPnL(trade, 90), -10);
  });

  it('LONG con leverage 5x: ganancia amplificada', () => {
    const trade = { tipo: 'LONG', entrada: 100, size: 1, leverage: 5 };
    assert.equal(calcPnL(trade, 110), 50);
  });

  it('SHORT sin leverage: precio baja → ganancia', () => {
    const trade = { tipo: 'SHORT', entrada: 100, size: 1, leverage: 1 };
    assert.equal(calcPnL(trade, 90), 10);
  });

  it('SHORT sin leverage: precio sube → pérdida', () => {
    const trade = { tipo: 'SHORT', entrada: 100, size: 1, leverage: 1 };
    assert.equal(calcPnL(trade, 110), -10);
  });

  it('SHORT con leverage 10x: pérdida amplificada', () => {
    const trade = { tipo: 'SHORT', entrada: 100, size: 1, leverage: 10 };
    assert.equal(calcPnL(trade, 105), -50);
  });

  it('PnL con size fraccionario (BTC)', () => {
    const trade = { tipo: 'LONG', entrada: 80000, size: 0.001, leverage: 1 };
    assert.equal(calcPnL(trade, 90000), 10);
  });

  it('PnL BREAKEVEN = 0', () => {
    const trade = { tipo: 'LONG', entrada: 100, size: 1, leverage: 1 };
    assert.equal(calcPnL(trade, 100), 0);
  });

  it('leverage undefined → trata como 1x', () => {
    const trade = { tipo: 'LONG', entrada: 100, size: 2 };
    assert.equal(calcPnL(trade, 110), 20);
  });

});

/* ════════════════════════════════════════════════════════════════
   SUITE 2 — TP/SL detection logic
   ════════════════════════════════════════════════════════════════ */
describe('TP/SL — lógica de detección', () => {

  function hitsSL(trade, price) {
    return trade.tipo === 'LONG'
      ? price <= trade.stopLoss
      : price >= trade.stopLoss;
  }

  function hitsTP(trade, price) {
    const target = trade.tp2 || trade.tp1;
    return trade.tipo === 'LONG'
      ? price >= target
      : price <= target;
  }

  it('LONG: precio en SL → hit', () => {
    const t = { tipo: 'LONG', stopLoss: 90, tp1: 120 };
    assert.equal(hitsSL(t, 90),  true);
    assert.equal(hitsSL(t, 89),  true);
    assert.equal(hitsSL(t, 91), false);
  });

  it('LONG: precio en TP1 → hit', () => {
    const t = { tipo: 'LONG', stopLoss: 90, tp1: 120 };
    assert.equal(hitsTP(t, 120), true);
    assert.equal(hitsTP(t, 121), true);
    assert.equal(hitsTP(t, 119), false);
  });

  it('LONG: usa TP2 si existe (TP1 no dispara)', () => {
    const t = { tipo: 'LONG', stopLoss: 90, tp1: 110, tp2: 130 };
    assert.equal(hitsTP(t, 115), false);
    assert.equal(hitsTP(t, 130), true);
  });

  it('SHORT: precio en SL → hit', () => {
    const t = { tipo: 'SHORT', stopLoss: 110, tp1: 80 };
    assert.equal(hitsSL(t, 110), true);
    assert.equal(hitsSL(t, 115), true);
    assert.equal(hitsSL(t, 109), false);
  });

  it('SHORT: precio en TP → hit', () => {
    const t = { tipo: 'SHORT', stopLoss: 110, tp1: 80 };
    assert.equal(hitsTP(t, 80),  true);
    assert.equal(hitsTP(t, 75),  true);
    assert.equal(hitsTP(t, 81), false);
  });

  it('coinOf extrae coin del par', () => {
    assert.equal(coinOf('BTC/USDT'), 'BTC');
    assert.equal(coinOf('ETH/USDT'), 'ETH');
    assert.equal(coinOf('XRP/USDT'), 'XRP');
  });

  it('coinOf con string vacío → cadena vacía', () => {
    assert.equal(coinOf(''), '');
    assert.equal(coinOf(null), '');
  });

});

/* ════════════════════════════════════════════════════════════════
   SUITE 3 — calcRSI
   ════════════════════════════════════════════════════════════════ */
describe('calcRSI — cálculo de RSI', () => {

  it('tendencia alcista fuerte → RSI > 70', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    assert.ok(calcRSI(closes, 14) > 70);
  });

  it('tendencia bajista fuerte → RSI < 30', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i * 2);
    assert.ok(calcRSI(closes, 14) < 30);
  });

  it('datos insuficientes → devuelve 50', () => {
    assert.equal(calcRSI([100, 101, 102], 14), 50);
  });

  it('RSI siempre en rango [0, 100]', () => {
    const up   = Array.from({ length: 50 }, (_, i) => i * 10);
    const down = Array.from({ length: 50 }, (_, i) => 500 - i * 10);
    [up, down].forEach(c => {
      const r = calcRSI(c, 14);
      assert.ok(r >= 0 && r <= 100, `RSI fuera de rango: ${r}`);
    });
  });

  it('todos los cierres iguales → RSI en [0,100]', () => {
    const flat = Array(20).fill(100);
    const r = calcRSI(flat, 14);
    assert.ok(r >= 0 && r <= 100);
  });

});

/* ════════════════════════════════════════════════════════════════
   SUITE 4 — calcMaxDrawdown
   ════════════════════════════════════════════════════════════════ */
describe('calcMaxDrawdown — equity curve', () => {

  it('sin caída → 0', () => {
    assert.equal(calcMaxDrawdown([10, 20, 30, 40]), 0);
  });

  it('caída simple', () => {
    assert.equal(calcMaxDrawdown([10, 30, 10, 20]), 20);
  });

  it('múltiples caídas → devuelve la mayor', () => {
    assert.equal(calcMaxDrawdown([0, 40, 25, 50, 20]), 30);
  });

  it('todos negativos', () => {
    assert.equal(calcMaxDrawdown([-5, -10, -30]), 25);
  });

  it('array vacío → 0', () => {
    assert.equal(calcMaxDrawdown([]), 0);
  });

  it('array de 1 elemento → 0', () => {
    assert.equal(calcMaxDrawdown([100]), 0);
  });

});

/* ════════════════════════════════════════════════════════════════
   SUITE 5 — calcEMA
   ════════════════════════════════════════════════════════════════ */
describe('calcEMA — media móvil exponencial', () => {

  it('serie constante → EMA ≈ la constante', () => {
    const ema = calcEMA(Array(25).fill(100), 20);
    assert.ok(Math.abs(ema - 100) < 0.01, `Esperado ≈100, obtenido ${ema}`);
  });

  it('tendencia alcista → EMA < precio actual', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + i * 2);
    const ema = calcEMA(closes, 20);
    assert.ok(ema < closes[closes.length - 1]);
  });

  it('tendencia bajista → EMA > precio actual', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 200 - i * 2);
    const ema = calcEMA(closes, 20);
    assert.ok(ema > closes[closes.length - 1]);
  });

  it('datos insuficientes → devuelve último precio', () => {
    assert.equal(calcEMA([100, 105, 110], 20), 110);
  });

});

/* ════════════════════════════════════════════════════════════════
   SUITE 6 — calcSupportResistance
   ════════════════════════════════════════════════════════════════ */
describe('calcSupportResistance — soporte y resistencia', () => {

  function makeBars(highs, lows) {
    return highs.map((h, i) => ({ h, l: lows[i], c: (h + lows[i]) / 2, o: 0, v: 1000 }));
  }

  it('soporte = mínimo de lows', () => {
    const bars = makeBars([110, 120, 115], [95, 100, 90]);
    assert.equal(calcSupportResistance(bars, 3).support, 90);
  });

  it('resistencia = máximo de highs', () => {
    const bars = makeBars([110, 120, 115], [95, 100, 90]);
    assert.equal(calcSupportResistance(bars, 3).resistance, 120);
  });

  it('soporte < resistencia siempre', () => {
    const bars = makeBars([200, 250, 180, 220], [150, 160, 140, 170]);
    const { support, resistance } = calcSupportResistance(bars, 4);
    assert.ok(support < resistance);
  });

  it('período mayor que barras disponibles → usa todas las barras', () => {
    const bars = makeBars([110, 115], [90, 95]);
    const { support, resistance } = calcSupportResistance(bars, 50);
    assert.equal(support, 90);
    assert.equal(resistance, 115);
  });

});
