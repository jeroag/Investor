'use strict';

const express        = require('express');
const { requireAuth } = require('../middleware/auth');
const { config }     = require('../config');
const crypto = require('crypto');
const {
  sendTelegram,
  handleTelegramUpdate,
  setTelegramWebhook,
  getWebhookSecret,
} = require('../services/telegram');

const router = express.Router();

/* ── Test de configuración ────────────────────────────────────────── */
router.post('/test', requireAuth, async (req, res) => {
  const { telegramToken: token, telegramChatId: chatId } = config;
  if (!token)  return res.json({ ok: false, error: 'Falta TELEGRAM_BOT_TOKEN en Railway' });
  if (!chatId) return res.json({ ok: false, error: 'Falta TELEGRAM_CHAT_ID en Railway' });

  try {
    const meRes  = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meData = await meRes.json();
    if (!meData.ok)
      return res.json({ ok: false, error: `Token inválido: ${meData.description}` });

    const result = await sendTelegram(
      '✅ <b>CryptoPlan IA</b> — Notificaciones Telegram funcionando correctamente.',
    );
    if (!result.ok) {
      const hint = result.description?.includes('chat not found')
        ? 'Chat ID incorrecto o no has iniciado el bot con /start'
        : (result.description || 'Error desconocido de Telegram');
      return res.json({ ok: false, error: hint });
    }
    res.json({ ok: true, botName: meData.result?.username });
  } catch (e) {
    res.json({ ok: false, error: 'Error de red: ' + e.message });
  }
});

/* ── Estado de configuración ──────────────────────────────────────── */
router.get('/status', requireAuth, (req, res) => {
  res.json({
    ok:         true,
    configured: !!(config.telegramToken && config.telegramChatId),
  });
});

/* ── Webhook bidireccional ────────────────────────────────────────────
   Telegram envía updates POST a esta URL.
   Para activar: POST /api/telegram/setup (desde la app, una sola vez)
   ──────────────────────────────────────────────────────────────────── */
router.post('/webhook', async (req, res) => {
  // SEGURIDAD: validar que la petición viene realmente de Telegram.
  // Telegram reenvía el secret_token (registrado en setWebhook) en esta
  // cabecera. Sin esta validación, cualquiera podría falsificar updates
  // con tu chat_id y ejecutar comandos como /cerrar (posiciones reales).
  const received = req.headers['x-telegram-bot-api-secret-token'] || '';
  const expected = getWebhookSecret();
  const valid = expected
    && received.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) {
    console.warn(`[Telegram webhook] Petición rechazada (secret inválido) — IP: ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
    return res.sendStatus(401);
  }

  // Responder 200 inmediatamente (Telegram requiere respuesta rápida)
  res.sendStatus(200);

  try {
    const result = await handleTelegramUpdate(req.body);
    if (result) await sendTelegram(result.reply, result.chatId);
  } catch (e) {
    console.error('[Telegram webhook]', e.message);
  }
});

/* ── Configurar webhook en Telegram ──────────────────────────────── */
router.post('/setup', requireAuth, async (req, res) => {
  const appUrl = req.body?.appUrl || config.appUrl;
  if (!appUrl)
    return res.status(400).json({ ok: false, error: 'Proporciona appUrl o configura APP_URL en Railway.' });

  try {
    const data = await setTelegramWebhook(appUrl);
    res.json({ ok: data.ok, result: data.description || data.result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;