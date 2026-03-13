'use strict';

const { config }      = require('../config');
const { serverState } = require('../state');

/* ═══════════════════════════════════════════════════════════════════
   ENVÍO DE MENSAJES
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Envía un mensaje de texto a Telegram (HTML parse_mode).
 */
async function sendTelegram(text) {
  const { telegramToken: token, telegramChatId: chatId } = config;
  if (!token || !chatId) return { ok: false, error: 'Variables no configuradas' };
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) console.warn(`[Telegram] Error: ${data.error_code} — ${data.description}`);
    return data;
  } catch (e) {
    console.warn('[Telegram] Error de red:', e.message);
    return { ok: false, error: e.message };
  }
}

/* ── Notificaciones predefinidas ──────────────────────────────────── */
function notifyTradeOpened(trade) {
  const dir = trade.tipo === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const lev = trade.leverage > 1 ? ` ${trade.leverage}x` : '';
  return sendTelegram(
    `⚡ <b>TRADE ABIERTO</b>\n${dir}${lev} <b>${trade.par}</b>\n` +
    `Entrada: <code>${trade.entrada}</code>\nSL: <code>${trade.stopLoss}</code> | TP1: <code>${trade.tp1}</code>` +
    (trade.tp2 ? ` | TP2: <code>${trade.tp2}</code>` : '') +
    `\nRiesgo: $${(trade.riskUSD || 0).toFixed(2)} | R:R 1:${trade.rr}`,
  );
}

function notifyTradeClosed(trade, result, pnl) {
  const emoji  = result === 'WIN' ? '✅' : result === 'BREAKEVEN' ? '↔️' : '❌';
  const label  = result === 'WIN' ? 'GANADA' : result === 'BREAKEVEN' ? 'BREAKEVEN' : 'PÉRDIDA';
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  return sendTelegram(`${emoji} <b>TRADE ${label}</b>\n<b>${trade.par}</b> ${trade.tipo}\nP&L: <b>${pnlStr}</b>`);
}

function notifyScannerAlert(alert) {
  const dir    = alert.tipo === 'LONG' ? '🟢' : '🔴';
  const urgent = alert.urgencia === 'ALTA' ? '🔥' : '⚡';
  return sendTelegram(
    `${urgent} <b>OPORTUNIDAD DETECTADA</b>\n` +
    `${dir} <b>${alert.par} ${alert.tipo}</b> — ${alert.confianza}% confianza\n` +
    `Entrada: <code>${alert.entrada}</code> | SL: <code>${alert.stopLoss}</code> | TP1: <code>${alert.tp1}</code>\n` +
    `${alert.razon}\n<i>Abre la app → ${config.appUrl || 'Railway app'}</i>`,
  );
}

function notifyBreakeven(trade) {
  return sendTelegram(
    `🔒 <b>BREAKEVEN</b> — ${trade.par} ${trade.tipo}\n` +
    `SL movido a entrada: <code>${trade.entrada}</code>\n` +
    `<i>El trade ya no puede perder dinero.</i>`,
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TELEGRAM BIDIRECCIONAL — Webhook handler
   ═══════════════════════════════════════════════════════════════════
   Para activar, llama a:
     POST https://api.telegram.org/bot<TOKEN>/setWebhook
          ?url=https://TU-APP.railway.app/api/telegram/webhook

   Comandos soportados desde Telegram:
     /estado      — resumen de trades activos y PnL
     /precios     — precios actuales de todas las monedas
     /trades      — lista de trades activos
     /historial   — resumen del historial de trades
     /ayuda       — lista de comandos
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Procesa una actualización de Telegram (update object).
 * Devuelve el texto de respuesta o null si no hay comando.
 */
async function handleTelegramUpdate(update) {
  const msg  = update?.message;
  if (!msg?.text) return null;

  // Solo responder a los chats permitidos (seguridad)
  const allowedIds = [
    String(config.telegramChatId),
    process.env.TELEGRAM_CHAT_ID_2 || '',
  ].filter(Boolean);
  if (!allowedIds.includes(String(msg.chat?.id))) {
    console.warn(`[Telegram] Mensaje rechazado de chatId=${msg.chat?.id}`);
    return null;
  }

  const text = msg.text.trim().toLowerCase();

  if (text.startsWith('/estado') || text.startsWith('/status')) {
    return buildEstadoMsg();
  }
  if (text.startsWith('/precios') || text.startsWith('/prices')) {
    return buildPreciosMsg();
  }
  if (text.startsWith('/trades')) {
    return buildTradesMsg();
  }
  if (text.startsWith('/historial') || text.startsWith('/history')) {
    return buildHistorialMsg();
  }
  if (text.startsWith('/ayuda') || text.startsWith('/help')) {
    return buildAyudaMsg();
  }

  return '❓ Comando no reconocido. Envía /ayuda para ver los comandos disponibles.';
}

function buildEstadoMsg() {
  const activos  = serverState.activeTrades.length;
  const cerrados = serverState.closedTrades.length;
  const wins     = serverState.closedTrades.filter(t => t.result === 'WIN').length;
  const totalPnl = serverState.closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const wr       = cerrados > 0 ? ((wins / cerrados) * 100).toFixed(0) : '—';
  return (
    `📊 <b>ESTADO CRYPTOPLAN IA</b>\n\n` +
    `Trades activos: <b>${activos}</b>\n` +
    `Trades cerrados: ${cerrados}\n` +
    `Win rate: ${wr}% (${wins}W / ${cerrados - wins}L)\n` +
    `P&L total: <b>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>`
  );
}

function buildPreciosMsg() {
  const prices = serverState.prices;
  const coins  = Object.keys(prices);
  if (!coins.length) return '⚠️ Sin precios disponibles aún.';
  const lines = coins.map(c => `${c}: <code>$${prices[c].toFixed ? prices[c].toFixed(4) : prices[c]}</code>`);
  return `💰 <b>PRECIOS ACTUALES</b>\n\n` + lines.join('\n');
}

function buildTradesMsg() {
  const trades = serverState.activeTrades;
  if (!trades.length) return '📭 No hay trades activos en este momento.';
  const lines = trades.map(t => {
    const price   = serverState.prices[t.par?.split('/')[0]] || '?';
    const dir     = t.tipo === 'LONG' ? '🟢' : '🔴';
    return `${dir} <b>${t.par}</b> @ ${t.entrada} | precio=${price} | SL=${t.stopLoss} | TP=${t.tp2 || t.tp1}`;
  });
  return `📈 <b>TRADES ACTIVOS (${trades.length})</b>\n\n` + lines.join('\n');
}

function buildHistorialMsg() {
  const trades = serverState.closedTrades.slice(0, 10);
  if (!trades.length) return '📭 Sin historial de trades.';
  const lines = trades.map(t => {
    const emoji = t.result === 'WIN' ? '✅' : '❌';
    const pnl   = t.pnl != null ? (t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`) : '?';
    return `${emoji} ${t.par} ${t.tipo} → ${pnl}`;
  });
  return `📋 <b>ÚLTIMOS 10 TRADES</b>\n\n` + lines.join('\n');
}

function buildAyudaMsg() {
  return (
    `🤖 <b>COMANDOS DISPONIBLES</b>\n\n` +
    `/estado — resumen de cuenta y P&L total\n` +
    `/precios — precios actuales\n` +
    `/trades — trades activos\n` +
    `/historial — últimos 10 trades cerrados\n` +
    `/ayuda — esta ayuda`
  );
}

/**
 * Configura el webhook de Telegram para recibir mensajes.
 * Llama a este endpoint desde Railway una vez tras desplegar.
 */
async function setTelegramWebhook(appUrl) {
  const token   = config.telegramToken;
  if (!token)   throw new Error('TELEGRAM_BOT_TOKEN no configurado');
  const url     = `${appUrl}/api/telegram/webhook`;
  const res     = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ url, allowed_updates: ['message'] }),
  });
  return res.json();
}

module.exports = {
  sendTelegram,
  notifyTradeOpened,
  notifyTradeClosed,
  notifyScannerAlert,
  notifyBreakeven,
  handleTelegramUpdate,
  setTelegramWebhook,
};