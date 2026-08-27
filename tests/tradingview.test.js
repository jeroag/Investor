'use strict';

/**
 * Tests del WEBHOOK de TradingView (src/routes/tradingview.js).
 *
 * Valida la seguridad (secret) y la validación de entrada del endpoint que
 * puede inyectar señales de trading. Monta el router en un Express real sobre
 * un puerto efímero y hace peticiones HTTP con fetch. Telegram se mockea.
 */

process.env.TRADINGVIEW_SECRET = 'test-secret-123';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* ── Mock de Telegram (no tocar la API real) ─────────────────────────── */
const tgResolved = require.resolve(path.join(__dirname, '..', 'src', 'services', 'telegram.js'));
require.cache[tgResolved] = {
  id: tgResolved, filename: tgResolved, loaded: true,
  exports: { notifyScannerAlert: () => {}, notifyTradeOpened: () => {}, notifyTradeClosed: () => {} },
};

const express = require('express');
const { router } = require('../src/routes/tradingview');
const { scannerState } = require('../src/state');

let server, base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tradingview', router);
  await new Promise(res => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

function post(body) {
  return fetch(base + '/api/tradingview/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Webhook TradingView — seguridad y validación', () => {

  it('rechaza secret inválido → 401', async () => {
    const r = await post({ secret: 'malo', action: 'LONG', symbol: 'BTCUSDT', price: 50000 });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.ok, false);
  });

  it('acepta LONG con secret correcto y precio → 200 y crea alerta', async () => {
    const antes = scannerState.pendingAlerts.length;
    const r = await post({ secret: 'test-secret-123', action: 'LONG', symbol: 'BTCUSDT', price: 50000, interval: '4h' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.received.tipo, 'LONG');
    assert.equal(j.received.par, 'BTC/USDT');
    assert.equal(scannerState.pendingAlerts.length, antes + 1);
  });

  it('rechaza si faltan action/symbol → 400', async () => {
    const r = await post({ secret: 'test-secret-123', action: 'LONG' });
    assert.equal(r.status, 400);
  });

  it('rechaza LONG sin precio válido → 400 (evita SL/TP = NaN)', async () => {
    const r = await post({ secret: 'test-secret-123', action: 'LONG', symbol: 'DOGEUSDT' });
    assert.equal(r.status, 400);
  });

  it('acepta CLOSE con secret correcto → 200', async () => {
    const r = await post({ secret: 'test-secret-123', action: 'CLOSE', symbol: 'BTCUSDT', price: 50000 });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
  });
});
