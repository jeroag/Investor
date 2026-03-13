'use strict';

/**
 * Webhook de TradingView
 * ══════════════════════════════════════════════════════════════════
 * TradingView → POST /api/tradingview/webhook
 *
 * Configuración en TradingView:
 *   URL:     https://TU-APP.railway.app/api/tradingview/webhook
 *   Message: JSON (ver formato abajo)
 *
 * Formato JSON de la alerta en TradingView:
 * {
 *   "secret":   "TU_TRADINGVIEW_SECRET",    ← variable de entorno
 *   "action":   "LONG" | "SHORT" | "CLOSE",
 *   "symbol":   "BTCUSDT",
 *   "price":    {{close}},                  ← precio de cierre de la vela
 *   "interval": "{{interval}}",
 *   "message":  "{{strategy.order.comment}}"  ← opcional
 * }
 *
 * Seguridad:
 *   - Valida campo `secret` contra TRADINGVIEW_SECRET (env var)
 *   - Rate limit separado (30 req/min)
 *   - Sin requerir sesión de usuario (viene de TradingView)
 * ══════════════════════════════════════════════════════════════════
 */

const express        = require('express');
const { config }     = require('../config');
const { serverState, scannerState } = require('../state');
const { notifyScannerAlert, notifyTradeOpened } = require('../services/telegram');
const { rateLimitTradingView } = require('../middleware/rateLimit');

const router = express.Router();

// Broadcast fn (inyectado por server.js)
let broadcastFn = null;
function setBroadcast(fn) { broadcastFn = fn; }

/* ── Handler principal ───────────────────────────────────────────── */
router.post('/webhook', rateLimitTradingView, (req, res) => {
  // 1. Autenticación por secret
  const { secret, action, symbol, price, interval, message } = req.body || {};

  if (config.tradingviewSecret && secret !== config.tradingviewSecret) {
    console.warn(`[TradingView] Secret inválido — IP: ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // 2. Validación básica
  if (!action || !symbol) {
    return res.status(400).json({ ok: false, error: 'action y symbol son requeridos' });
  }

  const normalizedAction = action.toUpperCase();
  const coin             = symbol.replace(/USDT$/i, '').toUpperCase();
  const parsedPrice      = price ? parseFloat(price) : (serverState.prices[coin] || null);

  console.log(`[TradingView] ${normalizedAction} ${symbol} @ ${parsedPrice} (${interval || '?'})`);

  // 3. Procesar según acción
  if (normalizedAction === 'LONG' || normalizedAction === 'SHORT') {
    const alert = buildAlertFromWebhook({ action: normalizedAction, coin, symbol, price: parsedPrice, interval, message });

    // Añadir a alertas pendientes del escáner
    scannerState.pendingAlerts.unshift(alert);
    if (scannerState.pendingAlerts.length > 50) scannerState.pendingAlerts.pop();
    scannerState.lastAlert = alert;

    // Broadcast a clientes WebSocket
    if (broadcastFn) broadcastFn({ type: 'SCANNER_ALERT', alert });

    // Notificar por Telegram
    notifyScannerAlert(alert);

    return res.json({ ok: true, received: alert });
  }

  if (normalizedAction === 'CLOSE') {
    // Señal de cierre — broadcast para que el cliente tome acción
    const event = {
      type:    'TRADINGVIEW_CLOSE',
      symbol,
      coin,
      price:   parsedPrice,
      message: message || `TradingView: cerrar ${symbol}`,
      at:      new Date().toISOString(),
    };
    if (broadcastFn) broadcastFn(event);
    return res.json({ ok: true, received: event });
  }

  return res.status(400).json({ ok: false, error: `Acción no reconocida: ${action}` });
});

/* ── Estado del webhook ───────────────────────────────────────────── */
router.get('/status', (req, res) => {
  res.json({
    ok:              true,
    webhookUrl:      `${config.appUrl}/api/tradingview/webhook`,
    secretConfigured: !!config.tradingviewSecret,
  });
});

/* ── Helpers ──────────────────────────────────────────────────────── */
function buildAlertFromWebhook({ action, coin, symbol, price, interval, message }) {
  // Calcular TP y SL aproximados (3% / 1.5%) — el usuario ajusta en la app
  const slPct = 0.015;
  const tpPct = 0.03;
  const sl    = action === 'LONG'
    ? parseFloat((price * (1 - slPct)).toFixed(6))
    : parseFloat((price * (1 + slPct)).toFixed(6));
  const tp1   = action === 'LONG'
    ? parseFloat((price * (1 + tpPct)).toFixed(6))
    : parseFloat((price * (1 - tpPct)).toFixed(6));
  const rr    = (tpPct / slPct).toFixed(1);

  return {
    id:            `tv_${Date.now()}`,
    source:        'tradingview',
    status:        'pending',
    hay_oportunidad: true,
    par:           `${coin}/USDT`,
    tipo:          action,
    setup:         message || `Señal TradingView ${interval || ''}`.trim(),
    entrada:       price,
    stopLoss:      sl,
    tp1,
    tp2:           null,
    rr,
    confianza:     80,
    urgencia:      'ALTA',
    signals_aligned: [`Señal automática TradingView`, interval ? `Timeframe: ${interval}` : null].filter(Boolean),
    razon:         message || `Señal ${action} de TradingView para ${symbol}`,
    contexto_mercado: `Alerta automática recibida vía webhook`,
    timestamp:     new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
  };
}

module.exports = { router, setBroadcast };
