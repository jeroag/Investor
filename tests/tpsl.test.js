'use strict';

/**
 * Tests del MOTOR TP/SL (src/services/tpsl.js) — el camino que ejecuta dinero real.
 *
 * Estrategia: se inyectan mocks de Supabase, Telegram y Bitunix en require.cache
 * ANTES de requerir tpsl.js, para que checkTPSL() no toque red ni dependa de
 * variables de entorno. calculations.js y state.js se usan REALES (son puros).
 *
 * Cubre:
 *   - Disparo de TP (WIN) y SL (LOSS) en LONG y SHORT
 *   - No dispara cuando el precio está entre SL y TP
 *   - Filtro por moneda (no toca trades de otra coin)
 *   - TP1 parcial → breakeven → TP2 total
 *   - GUARD anti doble-cierre (mutex processingTrades) con ticks concurrentes
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* ── Inyección de mocks en require.cache ─────────────────────────────── */
function mock(relFromSrc, exportsObj) {
  const resolved = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

mock('db/supabase.js', {
  saveActiveTrade:   async () => {},
  saveClosedTrade:   async () => {},
  deleteActiveTrade: async () => {},
});
mock('services/telegram.js', {
  notifyTradeClosed: () => {},
  notifyScannerAlert: () => {},
  notifyTradeOpened: () => {},
  // notifyPartialClose se omite a propósito: tpsl comprueba if(telegram.notifyPartialClose)
});
mock('services/bitunix.js', {
  isBitunixConfigured: () => false,   // fuerza modo "paper" → sin llamadas a Bitunix
  bitunixRequest:      async () => ({ data: {} }),
  setPositionSL:       async () => {},
});

const { serverState } = require('../src/state');
const tpsl = require('../src/services/tpsl');

function makeTrade(over = {}) {
  return {
    id: 't1', par: 'BTC/USDT', tipo: 'LONG',
    entrada: 100, size: 1, leverage: 1,
    tp1: 110, tp2: null, stopLoss: 95,
    ...over,
  };
}

beforeEach(() => {
  serverState.activeTrades = [];
  serverState.closedTrades = [];
});

/* ════════════════════════════════════════════════════════════════ */
describe('checkTPSL — disparo de TP y SL', () => {

  it('LONG toca TP1 (sin TP2) → cierra WIN y sale de activos', async () => {
    serverState.activeTrades = [makeTrade()];
    await tpsl.checkTPSL('BTC', 110);
    assert.equal(serverState.activeTrades.length, 0);
    assert.equal(serverState.closedTrades.length, 1);
    assert.equal(serverState.closedTrades[0].result, 'WIN');
    assert.equal(serverState.closedTrades[0].exitPrice, 110);
  });

  it('LONG toca SL → cierra LOSS', async () => {
    serverState.activeTrades = [makeTrade({ stopLoss: 95 })];
    await tpsl.checkTPSL('BTC', 95);
    assert.equal(serverState.activeTrades.length, 0);
    assert.equal(serverState.closedTrades.length, 1);
    assert.equal(serverState.closedTrades[0].result, 'LOSS');
    assert.equal(serverState.closedTrades[0].exitPrice, 95);
  });

  it('LONG con precio entre SL y TP → NO dispara nada', async () => {
    serverState.activeTrades = [makeTrade()];
    await tpsl.checkTPSL('BTC', 102);
    assert.equal(serverState.activeTrades.length, 1);
    assert.equal(serverState.closedTrades.length, 0);
  });

  it('SHORT toca SL (precio sube) → cierra LOSS', async () => {
    serverState.activeTrades = [makeTrade({ tipo: 'SHORT', tp1: 90, stopLoss: 105 })];
    await tpsl.checkTPSL('BTC', 105);
    assert.equal(serverState.closedTrades.length, 1);
    assert.equal(serverState.closedTrades[0].result, 'LOSS');
  });

  it('SHORT toca TP (precio baja) → cierra WIN', async () => {
    serverState.activeTrades = [makeTrade({ tipo: 'SHORT', tp1: 90, stopLoss: 105 })];
    await tpsl.checkTPSL('BTC', 90);
    assert.equal(serverState.closedTrades.length, 1);
    assert.equal(serverState.closedTrades[0].result, 'WIN');
  });

  it('no toca trades de otra moneda', async () => {
    serverState.activeTrades = [makeTrade()];
    await tpsl.checkTPSL('ETH', 999);   // precio absurdo, pero coin distinta
    assert.equal(serverState.activeTrades.length, 1);
    assert.equal(serverState.closedTrades.length, 0);
  });
});

/* ════════════════════════════════════════════════════════════════ */
describe('checkTPSL — flujo TP1 parcial + breakeven + TP2', () => {

  it('TP1 hace cierre parcial y mueve SL a breakeven; TP2 cierra el resto', async () => {
    const trade = makeTrade({ tp1: 110, tp2: 120, stopLoss: 95 });
    serverState.activeTrades = [trade];

    // 1) Toca TP1 → parcial. La mutación de estado en _handleTP1 es SÍNCRONA
    //    (antes del primer await), así que ya está aplicada al volver.
    await tpsl.checkTPSL('BTC', 110);
    assert.equal(serverState.activeTrades.length, 1, 'sigue activo tras TP1');
    assert.equal(serverState.closedTrades.length, 0, 'aún no cerrado');
    assert.equal(trade.tp1Hit, true);
    assert.equal(trade.breakevenSet, true);
    assert.equal(trade.size, 0.5, 'tamaño reducido al 50%');
    assert.ok(trade.stopLoss > 95, 'SL movido a breakeven (por encima del SL original)');

    // El cierre parcial de TP1 es fire-and-forget: mantiene el trade en el
    // mutex processingTrades hasta terminar. Esperamos a que asiente antes
    // del siguiente tick (en producción los ticks van con segundos de margen).
    await new Promise(r => setTimeout(r, 30));

    // 2) Toca TP2 → cierre total del restante
    await tpsl.checkTPSL('BTC', 120);
    assert.equal(serverState.activeTrades.length, 0);
    assert.equal(serverState.closedTrades.length, 1);
    assert.equal(serverState.closedTrades[0].result, 'WIN');
    assert.equal(serverState.closedTrades[0].exitPrice, 120);
  });
});

/* ════════════════════════════════════════════════════════════════ */
describe('checkTPSL — GUARD anti doble-cierre (dinero real)', () => {

  it('dos ticks concurrentes en el SL cierran el trade UNA sola vez', async () => {
    serverState.activeTrades = [makeTrade({ stopLoss: 95 })];
    // Dos llamadas concurrentes con el mismo precio de SL.
    await Promise.all([
      tpsl.checkTPSL('BTC', 95),
      tpsl.checkTPSL('BTC', 95),
    ]);
    assert.equal(serverState.closedTrades.length, 1, 'NO debe cerrarse dos veces');
    assert.equal(serverState.activeTrades.length, 0);
  });
});
