'use strict';

const { config }      = require('../config');
const { serverState, scannerState } = require('../state');
const { fetchOHLCV, buildTechSummary } = require('./binance');
const { bitunixRequest, isBitunixConfigured } = require('./bitunix');

/* ═══════════════════════════════════════════════════════════════════
   ENVÍO DE MENSAJES
   ═══════════════════════════════════════════════════════════════════ */

async function sendTelegram(text, targetChatId) {
  const { telegramToken: token, telegramChatId: chatId } = config;
  const dest = targetChatId || chatId;
  if (!token || !dest) return { ok: false, error: 'Variables no configuradas' };
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: dest, text, parse_mode: 'HTML' }),
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
   ALERTAS DE PRECIO EN MEMORIA
   ═══════════════════════════════════════════════════════════════════ */
const priceAlerts = [];

function checkPriceAlerts() {
  if (!priceAlerts.length) return;
  for (let i = priceAlerts.length - 1; i >= 0; i--) {
    const a = priceAlerts[i];
    const current = serverState.prices[a.coin];
    if (!current) continue;
    const triggered = a.direction === 'up' ? current >= a.targetPrice : current <= a.targetPrice;
    if (triggered) {
      const dir = a.direction === 'up' ? '⬆️' : '⬇️';
      sendTelegram(
        `🔔 <b>ALERTA DE PRECIO</b>\n${dir} <b>${a.coin}</b> ha ${a.direction === 'up' ? 'superado' : 'bajado de'} <code>$${a.targetPrice}</code>\nPrecio actual: <code>$${current.toFixed(4)}</code>`,
        a.chatId,
      );
      priceAlerts.splice(i, 1);
    }
  }
}

setInterval(checkPriceAlerts, 30_000);

/* ═══════════════════════════════════════════════════════════════════
   TELEGRAM BIDIRECCIONAL — Webhook handler
   ═══════════════════════════════════════════════════════════════════ */

async function handleTelegramUpdate(update) {
  const msg = update?.message;
  if (!msg?.text) return null;

  const allowedIds = [
    String(config.telegramChatId),
    process.env.TELEGRAM_CHAT_ID_2 || '',
    process.env.TELEGRAM_GROUP_ID  || '',
  ].filter(Boolean);

  const originChatId = String(msg.chat?.id);
  if (!allowedIds.includes(originChatId)) {
    console.warn(`[Telegram] Mensaje rechazado de chatId=${originChatId}`);
    return null;
  }

  const text = msg.text.trim().toLowerCase().replace(/@\S+/, '').trim();
  const args = text.split(/\s+/);

  let reply;
  try {
    reply = await routeCommand(args, originChatId);
  } catch (e) {
    reply = `❌ Error: ${e.message}`;
  }

  if (!reply) return null;
  return { reply, chatId: originChatId };
}

async function routeCommand(args, chatId) {
  const cmd = args[0];

  if (cmd === '/estado'    || cmd === '/status')   return buildEstadoMsg();
  if (cmd === '/precios'   || cmd === '/prices')   return buildPreciosMsg();
  if (cmd === '/trades')                            return buildTradesMsg();
  if (cmd === '/historial' || cmd === '/history')  return buildHistorialMsg();
  if (cmd === '/ayuda'     || cmd === '/help')      return buildAyudaMsg();
  if (cmd === '/resumen')                           return buildResumenMsg();

  if (cmd === '/rendimiento') {
    const days = parseInt(args[1]) || 7;
    return buildRendimientoMsg(days);
  }

  if (cmd === '/capital') return await buildCapitalMsg();

  if (cmd === '/analizar' || cmd === '/escanear') return await cmdAnalizar();

  if (cmd === '/coin') {
    const coin = (args[1] || '').toUpperCase();
    if (!coin) return '❌ Uso: /coin BTC';
    return await buildCoinMsg(coin);
  }

  if (cmd === '/cerrar') {
    const symbol = (args[1] || '').toUpperCase();
    if (!symbol) return '❌ Uso: /cerrar LTCUSDT';
    return await cmdCerrar(symbol);
  }

  if (cmd === '/sl') {
    const symbol  = (args[1] || '').toUpperCase();
    const slPrice = parseFloat(args[2]);
    if (!symbol || !slPrice) return '❌ Uso: /sl LTCUSDT 54.00';
    return await cmdMoveSL(symbol, slPrice);
  }

  if (cmd === '/breakeven') {
    const symbol = (args[1] || '').toUpperCase();
    if (!symbol) return '❌ Uso: /breakeven LTCUSDT';
    return await cmdBreakeven(symbol);
  }

  if (cmd === '/scanner') {
    const sub = args[1];
    if (sub === 'on')  return cmdScannerOn();
    if (sub === 'off') return cmdScannerOff();
    return `📡 Escáner: <b>${scannerState.enabled ? 'ACTIVO' : 'INACTIVO'}</b>\nIntervalo: ${scannerState.intervalMin} min\nUso: /scanner on | /scanner off`;
  }

  if (cmd === '/intervalo') {
    const min = parseInt(args[1]);
    if (!min || min < 5 || min > 240) return '❌ Uso: /intervalo <minutos> (5–240)';
    return cmdIntervalo(min);
  }

  if (cmd === '/alerta') {
    const coin  = (args[1] || '').toUpperCase();
    const price = parseFloat(args[2]);
    if (!coin || !price) return '❌ Uso: /alerta BTC 70000';
    return cmdAlerta(coin, price, chatId);
  }

  return '❓ Comando no reconocido. Envía /ayuda para ver todos los comandos.';
}

/* ═══════════════════════════════════════════════════════════════════
   BUILDERS
   ═══════════════════════════════════════════════════════════════════ */

function buildEstadoMsg() {
  const activos  = serverState.activeTrades.length;
  const cerrados = serverState.closedTrades.length;
  const wins     = serverState.closedTrades.filter(t => t.result === 'WIN').length;
  const totalPnl = serverState.closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const wr       = cerrados > 0 ? ((wins / cerrados) * 100).toFixed(0) : '—';
  const scanner  = scannerState.enabled ? `✅ ACTIVO (${scannerState.intervalMin} min)` : '⏸ INACTIVO';
  return (
    `📊 <b>ESTADO CRYPTOPLAN IA</b>\n\n` +
    `Trades activos: <b>${activos}</b>\n` +
    `Trades cerrados: ${cerrados}\n` +
    `Win rate: ${wr}% (${wins}W / ${cerrados - wins}L)\n` +
    `P&L total: <b>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>\n` +
    `Escáner: ${scanner}`
  );
}

function buildPreciosMsg() {
  const prices = serverState.prices;
  const coins  = Object.keys(prices);
  if (!coins.length) return '⚠️ Sin precios disponibles aún.';
  const lines = coins.map(c => {
    const p   = prices[c];
    const fmt = p >= 1000 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(6);
    return `<b>${c}</b>: <code>$${fmt}</code>`;
  });
  return `💰 <b>PRECIOS ACTUALES</b>\n\n` + lines.join('\n');
}

function buildTradesMsg() {
  const trades = serverState.activeTrades;
  if (!trades.length) return '📭 No hay trades activos en este momento.';
  const lines = trades.map(t => {
    const coin   = t.par?.split('/')[0];
    const price  = serverState.prices[coin];
    const dir    = t.tipo === 'LONG' ? '🟢' : '🔴';
    const pnl    = price
      ? (t.tipo === 'LONG' ? price - t.entrada : t.entrada - price) * (t.size || 0) * (t.leverage || 1)
      : null;
    const pnlStr = pnl != null ? ` | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '';
    return `${dir} <b>${t.par}</b> E:${t.entrada} SL:${t.stopLoss} TP:${t.tp2 || t.tp1}${pnlStr}`;
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

function buildResumenMsg() {
  const now  = Date.now();
  const day  = 86_400_000;
  const week = 7 * day;

  const todayTrades = serverState.closedTrades.filter(t => (now - new Date(t.closedAt || 0).getTime()) < day);
  const weekTrades  = serverState.closedTrades.filter(t => (now - new Date(t.closedAt || 0).getTime()) < week);

  const todayPnl  = todayTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const todayWins = todayTrades.filter(t => t.result === 'WIN').length;
  const weekWins  = weekTrades.filter(t => t.result === 'WIN').length;
  const weekWR    = weekTrades.length > 0 ? ((weekWins / weekTrades.length) * 100).toFixed(0) : '—';

  const activosPnl = serverState.activeTrades.reduce((sum, t) => {
    const price = serverState.prices[t.par?.split('/')[0]];
    if (!price) return sum;
    return sum + (t.tipo === 'LONG' ? price - t.entrada : t.entrada - price) * (t.size || 0) * (t.leverage || 1);
  }, 0);

  return (
    `📅 <b>RESUMEN</b>\n\n` +
    `<b>Hoy</b>\n` +
    `Ops: ${todayTrades.length} | Wins: ${todayWins} | P&L: ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)}\n\n` +
    `<b>Esta semana</b>\n` +
    `Ops: ${weekTrades.length} | Win rate: ${weekWR}%\n\n` +
    `<b>Ahora mismo</b>\n` +
    `Trades abiertos: ${serverState.activeTrades.length} | P&L latente: ${activosPnl >= 0 ? '+' : ''}$${activosPnl.toFixed(2)}`
  );
}

function buildRendimientoMsg(days) {
  const cutoff = Date.now() - days * 86_400_000;
  const trades = serverState.closedTrades.filter(t => new Date(t.closedAt || 0).getTime() >= cutoff);

  if (!trades.length) return `📭 Sin operaciones en los últimos ${days} días.`;

  const wins     = trades.filter(t => t.result === 'WIN').length;
  const losses   = trades.length - wins;
  const wr       = ((wins / trades.length) * 100).toFixed(0);
  const totalPnl = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const avgWin   = wins > 0 ? trades.filter(t => t.result === 'WIN').reduce((a, t) => a + (t.pnl || 0), 0) / wins : 0;
  const avgLoss  = losses > 0 ? trades.filter(t => t.result !== 'WIN').reduce((a, t) => a + (t.pnl || 0), 0) / losses : 0;
  const best     = trades.reduce((b, t) => (t.pnl || 0) > (b.pnl || 0) ? t : b, trades[0]);
  const worst    = trades.reduce((w, t) => (t.pnl || 0) < (w.pnl || 0) ? t : w, trades[0]);

  return (
    `📈 <b>RENDIMIENTO — Últimos ${days} días</b>\n\n` +
    `Operaciones: <b>${trades.length}</b> (${wins}W / ${losses}L)\n` +
    `Win rate: <b>${wr}%</b>\n` +
    `P&L total: <b>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>\n` +
    `Ganancia media: <code>+$${avgWin.toFixed(2)}</code>\n` +
    `Pérdida media: <code>-$${Math.abs(avgLoss).toFixed(2)}</code>\n\n` +
    `🏆 Mejor: ${best.par} → +$${(best.pnl || 0).toFixed(2)}\n` +
    `💀 Peor: ${worst.par} → $${(worst.pnl || 0).toFixed(2)}`
  );
}

async function buildCapitalMsg() {
  if (!isBitunixConfigured()) return '⚠️ Bitunix no configurado.';
  try {
    const data = await bitunixRequest('GET', '/api/v1/futures/account', {});
    const acc  = data?.data;
    if (!acc) return '⚠️ No se pudo obtener la cuenta de Bitunix.';
    const equity     = parseFloat(acc.equity       || acc.totalEquity   || 0);
    const balance    = parseFloat(acc.balance       || acc.walletBalance || 0);
    const unrealized = parseFloat(acc.unrealizedPnl || 0);
    const margin     = parseFloat(acc.usedMargin    || acc.positionMargin || 0);
    return (
      `💰 <b>CAPITAL BITUNIX</b>\n\n` +
      `Equity: <b>$${equity.toFixed(2)}</b>\n` +
      `Balance: $${balance.toFixed(2)}\n` +
      `PnL no realizado: ${unrealized >= 0 ? '+' : ''}$${unrealized.toFixed(2)}\n` +
      `Margen en uso: $${margin.toFixed(2)}`
    );
  } catch (e) {
    return `❌ Error Bitunix: ${e.message}`;
  }
}

async function buildCoinMsg(coin) {
  try {
    const bars     = await fetchOHLCV([coin], '1h', 52);
    const coinBars = bars[coin];
    if (!coinBars?.length) {
      const price = serverState.prices[coin];
      return price
        ? `💰 <b>${coin}/USDT</b>\nPrecio: <code>$${price.toFixed(4)}</code>\n<i>(Sin datos OHLCV)</i>`
        : `⚠️ No hay datos para ${coin}`;
    }
    const summary = buildTechSummary(coin, coinBars);
    const lines   = summary.split('\n').slice(0, 12).join('\n');
    return `📊 <b>${coin}/USDT — Análisis técnico</b>\n\n<code>${lines}</code>`;
  } catch (e) {
    return `❌ Error obteniendo datos de ${coin}: ${e.message}`;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   COMANDOS DE ACCIÓN
   ═══════════════════════════════════════════════════════════════════ */

async function cmdAnalizar() {
  if (!config.anthropicKey) return '⚠️ ANTHROPIC_API_KEY no configurada.';
  const { runServerScan } = require('./scanner');
  const result = await runServerScan();
  if (!result) return '❌ Error al ejecutar el análisis.';
  if (!result.hay_oportunidad) {
    return `🔍 <b>ANÁLISIS COMPLETADO</b>\n\n📭 Sin oportunidades claras ahora mismo.\n\n<i>${result.razon}</i>`;
  }
  const dir = result.tipo === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  return (
    `🔍 <b>OPORTUNIDAD DETECTADA</b>\n\n` +
    `${dir} <b>${result.par}</b> — ${result.confianza}% confianza\n\n` +
    `Entrada: <code>${result.entrada}</code>\n` +
    `SL: <code>${result.stopLoss}</code>\n` +
    `TP1: <code>${result.tp1}</code>${result.tp2 ? `\nTP2: <code>${result.tp2}</code>` : ''}\n` +
    `R:R 1:${result.rr}\n\n` +
    `<i>${result.razon}</i>\n\n` +
    `<i>→ ${config.appUrl || 'Abre la app'} para ejecutarla</i>`
  );
}

async function cmdCerrar(symbol) {
  if (!isBitunixConfigured()) return '⚠️ Bitunix no configurado.';
  try {
    const posData   = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
    const positions = Array.isArray(posData.data) ? posData.data : [];
    const pos       = positions.find(p => p.symbol === symbol || p.symbol === symbol.replace('USDT', '') + 'USDT');
    if (!pos) return `📭 No hay posición abierta para <b>${symbol}</b>`;
    await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, { positionId: pos.positionId });
    return `✅ Posición <b>${symbol}</b> cerrada en Bitunix.`;
  } catch (e) {
    return `❌ Error cerrando ${symbol}: ${e.message}`;
  }
}

async function cmdMoveSL(symbol, slPrice) {
  if (!isBitunixConfigured()) return '⚠️ Bitunix no configurado.';
  try {
    const posData   = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
    const positions = Array.isArray(posData.data) ? posData.data : [];
    const pos       = positions.find(p => p.symbol === symbol || p.symbol === symbol.replace('USDT', '') + 'USDT');
    if (!pos) return `📭 No hay posición abierta para <b>${symbol}</b>`;
    await bitunixRequest('POST', '/api/v1/futures/trade/set_risk_limit', {}, {
      positionId: pos.positionId,
      stopLoss:   String(slPrice),
    });
    const trade = serverState.activeTrades.find(t => (t.par?.split('/')[0] + 'USDT') === symbol);
    if (trade) trade.stopLoss = slPrice;
    return `✅ SL de <b>${symbol}</b> movido a <code>${slPrice}</code>`;
  } catch (e) {
    return `❌ Error moviendo SL de ${symbol}: ${e.message}`;
  }
}

async function cmdBreakeven(symbol) {
  if (!isBitunixConfigured()) return '⚠️ Bitunix no configurado.';
  const coin  = symbol.replace('USDT', '');
  const trade = serverState.activeTrades.find(t => t.par?.startsWith(coin));
  if (!trade) return `📭 No encuentro ${symbol} en los trades activos de la app.`;
  return await cmdMoveSL(symbol, trade.entrada);
}

function cmdScannerOn() {
  const { startServerScanner } = require('./scanner');
  if (scannerState.enabled) return `📡 El escáner ya estaba activo (cada ${scannerState.intervalMin} min).`;
  startServerScanner();
  return `✅ <b>Escáner activado</b> — revisando cada ${scannerState.intervalMin} min.`;
}

function cmdScannerOff() {
  const { stopServerScanner } = require('./scanner');
  if (!scannerState.enabled) return '📡 El escáner ya estaba inactivo.';
  stopServerScanner();
  return '⏸ <b>Escáner detenido.</b>';
}

function cmdIntervalo(min) {
  scannerState.intervalMin = min;
  if (scannerState.enabled) {
    const { stopServerScanner, startServerScanner } = require('./scanner');
    stopServerScanner();
    startServerScanner();
    return `✅ Intervalo del escáner cambiado a <b>${min} min</b> y reiniciado.`;
  }
  return `✅ Intervalo actualizado a <b>${min} min</b>. Se aplicará al activar el escáner.`;
}

function cmdAlerta(coin, targetPrice, chatId) {
  const currentPrice = serverState.prices[coin];
  if (!currentPrice) return `⚠️ No tengo precio de ${coin}. Disponibles: ${Object.keys(serverState.prices).join(', ')}`;

  const direction = targetPrice > currentPrice ? 'up' : 'down';
  const label     = direction === 'up' ? 'supere' : 'baje de';

  const idx = priceAlerts.findIndex(a => a.coin === coin && a.chatId === chatId);
  if (idx > -1) priceAlerts.splice(idx, 1);
  priceAlerts.push({ coin, targetPrice, direction, chatId, createdAt: Date.now() });

  return (
    `🔔 <b>Alerta configurada</b>\n\n` +
    `Te avisaré cuando <b>${coin}</b> ${label} <code>$${targetPrice}</code>\n` +
    `Precio actual: <code>$${currentPrice.toFixed(4)}</code>`
  );
}

function buildAyudaMsg() {
  return (
    `🤖 <b>COMANDOS DISPONIBLES</b>\n\n` +
    `<b>📊 Info</b>\n` +
    `/estado — resumen de cuenta y P&L total\n` +
    `/precios — precios actuales\n` +
    `/trades — trades activos con P&L en vivo\n` +
    `/historial — últimos 10 trades cerrados\n` +
    `/resumen — resumen del día y la semana\n` +
    `/rendimiento 7 — estadísticas de los últimos N días\n` +
    `/capital — equity real de Bitunix\n` +
    `/coin BTC — análisis técnico de una moneda\n\n` +
    `<b>⚡ Análisis IA</b>\n` +
    `/analizar — lanza análisis IA ahora\n` +
    `/escanear — fuerza un ciclo del escáner\n\n` +
    `<b>🎯 Gestión de trades</b>\n` +
    `/cerrar LTCUSDT — cierra posición en Bitunix\n` +
    `/sl LTCUSDT 54.00 — mueve el stop loss\n` +
    `/breakeven LTCUSDT — SL a precio de entrada\n\n` +
    `<b>📡 Escáner</b>\n` +
    `/scanner on | off — activar/desactivar\n` +
    `/intervalo 15 — cambiar intervalo (min)\n\n` +
    `<b>🔔 Alertas</b>\n` +
    `/alerta BTC 70000 — aviso cuando llegue al precio`
  );
}

/* ── Webhook setup ─────────────────────────────────────────────── */
async function setTelegramWebhook(appUrl) {
  const token = config.telegramToken;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN no configurado');
  const url = `${appUrl}/api/telegram/webhook`;
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
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