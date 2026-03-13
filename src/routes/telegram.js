'use strict';

const express        = require('express');
const { requireAuth } = require('../middleware/auth');
const { config }     = require('../config');
const {
  sendTelegram,
  handleTelegramUpdate,
  setTelegramWebhook,
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
  // Responder 200 inmediatamente (Telegram requiere respuesta rápida)
  res.sendStatus(200);

  try {
    const reply = await handleTelegramUpdate(req.body);
    if (reply) await sendTelegram(reply);
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