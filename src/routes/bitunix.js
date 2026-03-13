'use strict';

const express        = require('express');
const { requireAuth } = require('../middleware/auth');
const { isAuthenticated } = require('../middleware/auth');
const { config }     = require('../config');
const { notifyTradeOpened } = require('../services/telegram');
const { rateLimitGeneral }  = require('../middleware/rateLimit');
const { bitunixRequest }    = require('../services/bitunix');

const router = express.Router();

/* ── Debug (sin sesión si viene DEBUG_TOKEN) ─────────────────────── */
router.get('/debug', async (req, res) => {
  const debugToken = config.debugToken;
  const tokenMatch = debugToken && req.query.token === debugToken;
  if (!isAuthenticated(req) && !tokenMatch) {
    const hint = debugToken
      ? 'Autentícate o añade ?token=<DEBUG_TOKEN> configurado en Railway.'
      : 'Inicia sesión para acceder. Opcionalmente configura DEBUG_TOKEN en Railway.';
    return res.status(401).json({ error: hint });
  }

  const apiKey    = (config.bitunixApiKey || '').trim();
  const secretKey = (config.bitunixSecret || '').trim();
  if (!apiKey || !secretKey)
    return res.json({ ok: false, error: 'BITUNIX_API_KEY y BITUNIX_SECRET no configuradas.' });

  const results = {
    _keys_info: {
      apiKey_length:  apiKey.length,
      secret_length:  secretKey.length,
      apiKey_prefix:  apiKey.slice(0, 6) + '...',
      apiKey_suffix:  '...' + apiKey.slice(-4),
      timestamp_ms:   Date.now(),
      nodeVersion:    process.version,
    },
  };

  async function tryEp(label, method, epPath, params, body) {
    const nonce = generateNonce(), ts = Date.now().toString();
    const bStr  = body ? JSON.stringify(body).replace(/\s+/g, '') : '';
    const sign  = bitunixSign(apiKey, secretKey, nonce, ts, params, bStr);
    const qsStr = Object.keys(params).length
      ? '?' + Object.keys(params).sort()
          .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')
      : '';
    try {
      const r    = await fetch('https://fapi.bitunix.com' + epPath + qsStr, {
        method,
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey, 'nonce': nonce, 'timestamp': ts, 'sign': sign, 'language': 'en-US' },
        ...(body ? { body: bStr } : {}),
      });
      const txt  = await r.text();
      let d; try { d = JSON.parse(txt); } catch { d = { raw: txt.slice(0, 300) }; }
      results[label] = { httpStatus: r.status, code: d.code, msg: d.msg, ok: d.code === 0, dataPreview: JSON.stringify(d.data).slice(0, 200) };
    } catch (e) { results[label] = { error: e.message }; }
  }

  await tryEp('account',        'GET', '/api/v1/futures/account',                              { marginCoin: 'USDT' });
  await tryEp('positions',      'GET', '/api/v1/futures/position/get_pending_positions',       {});
  await tryEp('history_orders', 'GET', '/api/v1/futures/trade/get_history_orders', { pageSize: '5', page: '1' });

  res.json({ ok: true, results });
});

/* ── Cuenta ──────────────────────────────────────────────────────── */
router.get('/account', requireAuth, rateLimitGeneral, async (req, res) => {
  try {
    const data   = await bitunixRequest('GET', '/api/v1/futures/account', { marginCoin: 'USDT' });
    const rawArr = data.data;
    const raw    = Array.isArray(rawArr) ? rawArr[0] : rawArr;
    if (!raw) return res.status(500).json({ ok: false, error: 'Respuesta vacía de Bitunix' });
    res.json({
      ok: true,
      account: {
        available:              raw.available              ?? null,
        frozen:                 raw.frozen                 ?? null,
        margin:                 raw.margin                 ?? null,
        transfer:               raw.transfer               ?? null,
        crossUnrealizedPNL:     raw.crossUnrealizedPNL     ?? null,
        isolationUnrealizedPNL: raw.isolationUnrealizedPNL ?? null,
        unrealizedPnl:          raw.crossUnrealizedPNL ?? raw.isolationUnrealizedPNL ?? null,
        bonus:                  raw.bonus                  ?? null,
        positionMode:           raw.positionMode           ?? null,
        marginCoin:             raw.marginCoin             ?? 'USDT',
        equity:                 raw.available              ?? null,
        balance:                raw.available              ?? null,
      },
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ── Posiciones abiertas ─────────────────────────────────────────── */
router.get('/positions', requireAuth, rateLimitGeneral, async (req, res) => {
  try {
    const data      = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
    const positions = Array.isArray(data.data) ? data.data : [];
    res.json({ ok: true, positions });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ── Colocar orden ───────────────────────────────────────────────── */
router.post('/place-order', requireAuth, async (req, res) => {
  try {
    const { symbol, qty, side, leverage, orderType, price, tpPrice, slPrice, clientOrderId } = req.body;
    if (!symbol || !qty || !side)
      return res.status(400).json({ ok: false, error: 'symbol, qty y side son obligatorios' });

    try {
      await bitunixRequest('POST', '/api/v1/futures/account/change_leverage', {}, {
        symbol, leverage: Number(leverage || 1), marginCoin: 'USDT',
      });
    } catch (e) { console.warn('change_leverage (no fatal):', e.message); }

    const orderBody = {
      symbol,
      qty:      String(qty),
      side,
      tradeSide: 'OPEN',
      orderType: orderType || 'MARKET',
      reduceOnly: false,
      clientId:  clientOrderId || `cp_${Date.now()}`,
    };
    if (orderType === 'LIMIT' && price) orderBody.price = String(price);
    if (tpPrice) { orderBody.tpPrice = String(tpPrice); orderBody.tpStopType = 'LAST_PRICE'; orderBody.tpOrderType = 'MARKET'; }
    if (slPrice) { orderBody.slPrice = String(slPrice); orderBody.slStopType = 'LAST_PRICE'; orderBody.slOrderType = 'MARKET'; }

    const orderData = await bitunixRequest('POST', '/api/v1/futures/trade/place_order', {}, orderBody);
    const orderId   = orderData.data?.orderId;
    console.log(`[Bitunix order OK] ${symbol} ${side} qty=${qty} orderId=${orderId}`);
    notifyTradeOpened({
      par:      symbol.replace('USDT', '/USDT'),
      tipo:     side === 'BUY' ? 'LONG' : 'SHORT',
      leverage: leverage || 1,
      entrada:  price || 'mercado',
      stopLoss: slPrice || '—',
      tp1:      tpPrice || '—',
      tp2:      null,
      riskUSD:  0,
      rr:       '—',
    });
    res.json({ ok: true, orderId });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ── Cerrar posición ─────────────────────────────────────────────── */
router.post('/close-position', requireAuth, async (req, res) => {
  try {
    const { positionId, symbol } = req.body;
    if (!positionId) {
      if (!symbol) return res.status(400).json({ ok: false, error: 'Necesito positionId o symbol' });
      const posData   = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
      const positions = Array.isArray(posData.data) ? posData.data : [];
      const pos       = positions.find(p => p.symbol === symbol);
      if (!pos) return res.status(404).json({ ok: false, error: `No hay posición abierta para ${symbol}` });
      const data = await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, { positionId: pos.positionId });
      return res.json({ ok: true, data: data.data });
    }
    const data = await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, { positionId });
    res.json({ ok: true, data: data.data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ── Actualizar SL (para breakeven) ─────────────────────────────── */
router.post('/update-sl', requireAuth, async (req, res) => {
  try {
    const { symbol, side, slPrice } = req.body;
    if (!symbol || !slPrice)
      return res.status(400).json({ ok: false, error: 'symbol y slPrice requeridos' });

    const posData   = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
    const positions = Array.isArray(posData.data) ? posData.data : [];
    const pos       = positions.find(
      p => p.symbol === symbol && (!side || p.side === side || p.positionSide === side),
    );
    if (!pos) return res.status(404).json({ ok: false, error: `Sin posición abierta para ${symbol}` });

    const data = await bitunixRequest('POST', '/api/v1/futures/trade/set_risk_limit', {}, {
      positionId: pos.positionId,
      stopLoss:   String(slPrice),
    });
    res.json({ ok: true, data: data.data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ── Historial de órdenes ────────────────────────────────────────── */
router.get('/history', requireAuth, rateLimitGeneral, async (req, res) => {
  try {
    const data   = await bitunixRequest('GET', '/api/v1/futures/trade/get_history_orders', { pageSize: '20', page: '1' });
    const orders = Array.isArray(data.data?.resultList) ? data.data.resultList
                 : Array.isArray(data.data?.list)       ? data.data.list
                 : Array.isArray(data.data)             ? data.data : [];
    res.json({ ok: true, orders });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ── Estado de configuración ─────────────────────────────────────── */
router.get('/status', requireAuth, (req, res) => {
  const configured = !!(config.bitunixApiKey && config.bitunixSecret);
  res.json({ configured, hasTradeKey: configured, canRead: configured });
});

module.exports = { router, bitunixRequest };