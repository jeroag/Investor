'use strict';

const { config }      = require('../config');
const { serverState, scannerState } = require('../state');
const { fetchOHLCV, buildTechSummary } = require('./binance');
const { bitunixRequest, isBitunixConfigured } = require('./bitunix');

/* helpers */
const fmtPnl = n => n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;

function fmtDate(val) {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function timeSince(val) {
  if (!val) return '';
  const ms = Date.now() - new Date(val).getTime();
  const h  = Math.floor(ms / 3_600_000);
  const m  = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d`;
  if (h > 0)   return `${h}h ${m}m`;
  return `${m}m`;
}

/* ═══ ENVÍO ═══════════════════════════════════════════════════════════ */
async function sendTelegram(text, targetChatId) {
  const { telegramToken: token, telegramChatId: chatId } = config;
  const dest = targetChatId || chatId;
  if (!token || !dest) return { ok: false, error: 'Variables no configuradas' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: dest, text, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) console.warn(`[Telegram] Error: ${data.error_code} — ${data.description}`);
    return data;
  } catch (e) {
    console.warn('[Telegram] Error de red:', e.message);
    return { ok: false, error: e.message };
  }
}

/* ═══ NOTIFICACIONES ══════════════════════════════════════════════════ */
function notifyTradeOpened(trade) {
  const dir  = trade.tipo === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const lev  = trade.leverage > 1 ? ` · <b>${trade.leverage}x</b>` : '';
  const risk = trade.riskUSD != null ? `\n💸 Riesgo: <code>$${(trade.riskUSD || 0).toFixed(2)}</code>` : '';
  const rr   = trade.rr ? ` · R:R 1:${trade.rr}` : '';
  return sendTelegram(
    `⚡ <b>TRADE ABIERTO</b>\n${dir}${lev} <b>${trade.par}</b>\n\n` +
    `📌 Entrada: <code>${trade.entrada}</code>\n` +
    `🛡 SL: <code>${trade.stopLoss}</code>\n` +
    `🎯 TP1: <code>${trade.tp1}</code>` +
    (trade.tp2 ? ` · TP2: <code>${trade.tp2}</code>` : '') +
    `${rr}${risk}`
  );
}

function notifyTradeClosed(trade, result, pnl) {
  const emoji  = result === 'WIN' ? '✅' : result === 'BREAKEVEN' ? '↔️' : '❌';
  const label  = result === 'WIN' ? 'GANADA' : result === 'BREAKEVEN' ? 'BREAKEVEN' : 'PÉRDIDA';
  const fees   = trade.fees != null ? `\n💸 Fees: -$${trade.fees.toFixed(2)} · Bruto: ${fmtPnl(trade.pnlGross || pnl)}` : '';
  const dur    = trade.createdAt ? `\n⏱ Duración: ${timeSince(trade.createdAt)}` : '';
  let rrReal   = '';
  if (trade.tp1 && trade.stopLoss && trade.entrada && trade.exitPrice) {
    const riskD = Math.abs(trade.entrada - trade.stopLoss);
    const gainD = Math.abs(trade.exitPrice - trade.entrada);
    if (riskD > 0) rrReal = `\n📐 R:R conseguido: 1:${(gainD / riskD).toFixed(2)}`;
  }
  return sendTelegram(
    `${emoji} <b>TRADE ${label}</b>\n<b>${trade.par}</b> ${trade.tipo}\n\n` +
    `💰 P&L neto: <b>${fmtPnl(pnl)}</b>${fees}${rrReal}${dur}`
  );
}

function notifyScannerAlert(alert) {
  const dir     = alert.tipo === 'LONG' ? '🟢' : '🔴';
  const urgent  = alert.urgencia === 'ALTA' ? '🔥' : '⚡';
  const conf    = alert.confianza ? ` — <b>${alert.confianza}%</b>` : '';
  const rr      = alert.rr ? ` · R:R 1:${alert.rr}` : '';
  const signals = Array.isArray(alert.signals_aligned) && alert.signals_aligned.length
    ? `\n📡 ${alert.signals_aligned.slice(0, 4).join(' · ')}` : '';
  return sendTelegram(
    `${urgent} <b>OPORTUNIDAD DETECTADA</b>\n` +
    `${dir} <b>${alert.par} ${alert.tipo}</b>${conf}\n\n` +
    `📌 Entrada: <code>${alert.entrada}</code>\n` +
    `🛡 SL: <code>${alert.stopLoss}</code>\n` +
    `🎯 TP1: <code>${alert.tp1}</code>` +
    (alert.tp2 ? ` · TP2: <code>${alert.tp2}</code>` : '') +
    `${rr}${signals}\n\n<i>${alert.razon}</i>\n\n` +
    `🔗 <a href="${config.appUrl || ''}">Abrir app</a>`
  );
}

function notifyBreakeven(trade) {
  return sendTelegram(
    `🔒 <b>BREAKEVEN ACTIVADO</b>\n<b>${trade.par}</b> ${trade.tipo}\n\n` +
    `SL movido a entrada: <code>${trade.entrada}</code>\n` +
    `<i>El trade ya no puede perder dinero ✓</i>`
  );
}

/* ═══ ALERTAS DE PRECIO ════════════════════════════════════════════════ */
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
        `🔔 <b>ALERTA DE PRECIO</b>\n${dir} <b>${a.coin}</b> ha ` +
        `${a.direction === 'up' ? 'superado' : 'bajado de'} <code>$${a.targetPrice}</code>\n` +
        `Precio actual: <code>$${current.toFixed(4)}</code>`,
        a.chatId
      );
      priceAlerts.splice(i, 1);
    }
  }
}
setInterval(checkPriceAlerts, 30_000);

/* ═══ WEBHOOK HANDLER ════════════════════════════════════════════════════ */
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
    reply = `❌ Error interno: ${e.message}`;
  }

  if (!reply) return null;
  return { reply, chatId: originChatId };
}

async function routeCommand(args, chatId) {
  const cmd = args[0];

  if (cmd === '/estado'  || cmd === '/status')  return buildEstadoMsg();
  if (cmd === '/precios' || cmd === '/prices')  return buildPreciosMsg();
  if (cmd === '/trades')                         return buildTradesMsg();
  if (cmd === '/historial'|| cmd === '/history') return buildHistorialMsg();
  if (cmd === '/ayuda'   || cmd === '/help')     return buildAyudaMsg();
  if (cmd === '/resumen')                        return buildResumenMsg();

  if (cmd === '/rendimiento') {
    const days = parseInt(args[1]) || 7;
    if (days < 1 || days > 365) return '❌ Uso: /rendimiento <días> (1–365)';
    return buildRendimientoMsg(days);
  }

  if (cmd === '/capital') return await buildCapitalMsg();

  if (cmd === '/analizar' || cmd === '/escanear') {
    sendTelegram('🔍 <i>Analizando el mercado, espera un momento...</i>', chatId);
    return await cmdAnalizar();
  }

  if (cmd === '/coin') {
    const coin = (args[1] || '').toUpperCase();
    if (!coin) return '❌ Uso: /coin BTC';
    sendTelegram(`📊 <i>Obteniendo datos de ${coin}...</i>`, chatId);
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
    const estado = scannerState.enabled ? `✅ <b>ACTIVO</b>` : `⏸ <b>INACTIVO</b>`;
    return `📡 <b>Escáner</b>\nEstado: ${estado}\nIntervalo: ${scannerState.intervalMin} min\n\n/scanner on · /scanner off`;
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

  return `❓ Comando no reconocido.\nEnvía /ayuda para ver todos los comandos.`;
}

/* ═══ BUILDERS ════════════════════════════════════════════════════════ */
function buildEstadoMsg() {
  const activos  = serverState.activeTrades.length;
  const cerrados = serverState.closedTrades.length;
  const wins     = serverState.closedTrades.filter(t => t.result === 'WIN').length;
  const wr       = cerrados > 0 ? `${((wins / cerrados) * 100).toFixed(0)}%` : '—';
  const totalPnl = serverState.closedTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const scanner  = scannerState.enabled ? `✅ Activo (${scannerState.intervalMin} min)` : '⏸ Inactivo';
  const latente  = serverState.activeTrades.reduce((sum, t) => {
    const price = serverState.prices[t.par?.split('/')[0]];
    if (!price) return sum;
    return sum + (t.tipo === 'LONG' ? price - t.entrada : t.entrada - price) * (t.size || 0) * (t.leverage || 1);
  }, 0);
  return (
    `📊 <b>ESTADO DE CUENTA</b>\n\n` +
    `Abiertos: ${activos} · Cerrados: ${cerrados}\n` +
    `Win rate: <b>${wr}</b> (${wins}W / ${cerrados - wins}L)\n\n` +
    `Realizado: <b>${fmtPnl(totalPnl)}</b>\n` +
    `Latente: <b>${fmtPnl(latente)}</b>\n\n` +
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
  return `💹 <b>PRECIOS</b>\n\n` + lines.join('\n') + `\n\n<i>${new Date().toLocaleTimeString('es-ES')}</i>`;
}

function buildTradesMsg() {
  const trades = serverState.activeTrades;
  if (!trades.length) return '📭 <b>Sin trades activos</b> en este momento.';
  const lines = trades.map((t, i) => {
    const coin   = t.par?.split('/')[0];
    const price  = serverState.prices[coin];
    const dir    = t.tipo === 'LONG' ? '🟢' : '🔴';
    const lev    = t.leverage > 1 ? ` ${t.leverage}x` : '';
    const pnl    = price != null
      ? (t.tipo === 'LONG' ? price - t.entrada : t.entrada - price) * (t.size || 0) * (t.leverage || 1)
      : null;
    const pnlStr = pnl != null ? ` → <b>${fmtPnl(pnl)}</b>` : '';
    const slDist = t.stopLoss && price ? `${((Math.abs(price - t.stopLoss) / price) * 100).toFixed(1)}%` : '?';
    const dur    = timeSince(t.createdAt);
    return (
      `${i + 1}. ${dir} <b>${t.par}</b>${lev}${pnlStr}\n` +
      `   E:${t.entrada} · SL:${t.stopLoss} (${slDist}) · TP:${t.tp1}\n` +
      `   <i>${dur ? `Abierto hace ${dur} · ` : ''}${fmtDate(t.createdAt)}</i>`
    );
  });
  return `📈 <b>TRADES ACTIVOS (${trades.length})</b>\n\n` + lines.join('\n\n');
}

function buildHistorialMsg() {
  const trades = serverState.closedTrades.slice(0, 10);
  if (!trades.length) return '📭 Sin historial de trades.';
  const lines = trades.map(t => {
    const emoji  = t.result === 'WIN' ? '✅' : '❌';
    const exit   = t.exitPrice ? ` · salida ${t.exitPrice}` : '';
    return `${emoji} <b>${t.par}</b> ${t.tipo} → <b>${fmtPnl(t.pnl || 0)}</b>${exit}\n   <i>${fmtDate(t.closedAt)}</i>`;
  });
  const total = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  return `📋 <b>ÚLTIMOS 10 TRADES</b>\n\n` + lines.join('\n\n') + `\n\n<b>P&L (últimos 10): ${fmtPnl(total)}</b>`;
}

function buildResumenMsg() {
  const now  = Date.now();
  const day  = 86_400_000;
  const week = 7 * day;
  const todayTrades = serverState.closedTrades.filter(t => (now - new Date(t.closedAt || 0).getTime()) < day);
  const weekTrades  = serverState.closedTrades.filter(t => (now - new Date(t.closedAt || 0).getTime()) < week);
  const todayPnl  = todayTrades.reduce((a, t) => a + (t.pnl || 0), 0);
  const weekPnl   = weekTrades.reduce((a, t)  => a + (t.pnl || 0), 0);
  const todayWins = todayTrades.filter(t => t.result === 'WIN').length;
  const weekWins  = weekTrades.filter(t => t.result === 'WIN').length;
  const weekWR    = weekTrades.length > 0 ? `${((weekWins / weekTrades.length) * 100).toFixed(0)}%` : '—';
  const latente   = serverState.activeTrades.reduce((sum, t) => {
    const price = serverState.prices[t.par?.split('/')[0]];
    if (!price) return sum;
    return sum + (t.tipo === 'LONG' ? price - t.entrada : t.entrada - price) * (t.size || 0) * (t.leverage || 1);
  }, 0);
  return (
    `📅 <b>RESUMEN</b>\n\n` +
    `<b>Hoy</b>\nOps: ${todayTrades.length} · Wins: ${todayWins} · P&L: <b>${fmtPnl(todayPnl)}</b>\n\n` +
    `<b>Esta semana</b>\nOps: ${weekTrades.length} · WR: ${weekWR} · P&L: <b>${fmtPnl(weekPnl)}</b>\n\n` +
    `<b>Ahora mismo</b>\nAbiertos: ${serverState.activeTrades.length} · Latente: <b>${fmtPnl(latente)}</b>`
  );
}

function buildRendimientoMsg(days) {
  const cutoff = Date.now() - days * 86_400_000;
  const trades = serverState.closedTrades.filter(t => new Date(t.closedAt || 0).getTime() >= cutoff);
  if (!trades.length) return `📭 Sin operaciones cerradas en los últimos <b>${days} días</b>.`;

  const wins      = trades.filter(t => t.result === 'WIN').length;
  const losses    = trades.length - wins;
  const wr        = `${((wins / trades.length) * 100).toFixed(0)}%`;
  const totalPnl  = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const winT      = trades.filter(t => t.result === 'WIN');
  const lossT     = trades.filter(t => t.result !== 'WIN');
  const avgWin    = winT.length  > 0 ? winT.reduce((a, t)  => a + (t.pnl || 0), 0) / winT.length  : 0;
  const avgLoss   = lossT.length > 0 ? lossT.reduce((a, t) => a + (t.pnl || 0), 0) / lossT.length : 0;
  const best      = trades.reduce((b, t) => (t.pnl || 0) > (b.pnl || 0) ? t : b, trades[0]);
  const worst     = trades.reduce((w, t) => (t.pnl || 0) < (w.pnl || 0) ? t : w, trades[0]);
  const pf        = Math.abs(avgLoss) > 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : '∞';

  // Racha actual
  let streak = 0, streakType = '';
  for (const t of trades) {
    if (!streakType) { streakType = t.result; streak = 1; }
    else if (t.result === streakType) streak++;
    else break;
  }
  const streakStr = streak > 1 ? `Racha: <b>${streak} ${streakType === 'WIN' ? 'wins' : 'losses'} seguidos</b>\n` : '';

  return (
    `📈 <b>RENDIMIENTO — Últimos ${days} días</b>\n\n` +
    `Operaciones: <b>${trades.length}</b> (${wins}W / ${losses}L)\n` +
    `Win rate: <b>${wr}</b>\nP&L total: <b>${fmtPnl(totalPnl)}</b>\n\n` +
    `Ganancia media: <code>${fmtPnl(avgWin)}</code>\n` +
    `Pérdida media: <code>${fmtPnl(avgLoss)}</code>\n` +
    `Profit factor: <b>${pf}</b>\n\n` +
    `${streakStr}🏆 Mejor: <b>${best.par}</b> ${fmtPnl(best.pnl || 0)}\n` +
    `💀 Peor: <b>${worst.par}</b> ${fmtPnl(worst.pnl || 0)}`
  );
}

async function buildCapitalMsg() {
  if (!isBitunixConfigured()) return '⚠️ Bitunix no configurado. Añade BITUNIX_API_KEY y BITUNIX_SECRET en Railway.';
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
      `Disponible: <b>$${(balance - margin).toFixed(2)}</b>\n` +
      `Margen en uso: $${margin.toFixed(2)}\n` +
      `P&L no realizado: <b>${fmtPnl(unrealized)}</b>`
    );
  } catch (e) {
    return `❌ Error Bitunix: ${e.message}`;
  }
}

async function buildCoinMsg(coin) {
  try {
    const bars     = await fetchOHLCV([coin], '1h', 52);
    const coinBars = bars[coin];
    const price    = serverState.prices[coin];
    if (!coinBars?.length) {
      return price
        ? `💰 <b>${coin}/USDT</b>\nPrecio: <code>$${price.toFixed(4)}</code>\n<i>(Sin datos OHLCV)</i>`
        : `⚠️ No hay datos para <b>${coin}</b>.`;
    }
    const summary = buildTechSummary(coin, coinBars);
    const lines   = summary.split('\n').slice(0, 14).join('\n');
    let chg24h    = '';
    if (coinBars.length >= 24) {
      const c0  = coinBars[coinBars.length - 24].close;
      const c1  = coinBars[coinBars.length - 1].close;
      const pct = ((c1 - c0) / c0 * 100).toFixed(2);
      chg24h    = `\n24h: ${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%`;
    }
    const pFmt = price ? `$${price >= 1 ? price.toFixed(2) : price.toFixed(6)}` : '';
    return (
      `📊 <b>${coin}/USDT — Análisis (1H)</b>\n` +
      (pFmt ? `Precio: <code>${pFmt}</code>${chg24h}\n\n` : '\n') +
      `<code>${lines}</code>`
    );
  } catch (e) {
    return `❌ Error obteniendo datos de ${coin}: ${e.message}`;
  }
}

/* ═══ COMANDOS DE ACCIÓN ═══════════════════════════════════════════════ */
async function cmdAnalizar() {
  if (!config.anthropicKey) return '⚠️ ANTHROPIC_API_KEY no configurada en Railway.';
  try {
    const { runServerScan } = require('./scanner');
    const result = await runServerScan();
    if (!result) return '❌ Error al ejecutar el análisis. Revisa los logs.';
    if (!result.hay_oportunidad) {
      return `🔍 <b>ANÁLISIS COMPLETADO</b>\n\n📭 Sin oportunidades claras.\n\n<i>${result.razon || 'Mercado sin señales.'}</i>`;
    }
    const dir    = result.tipo === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const urgent = result.urgencia === 'ALTA' ? '🔥' : '⚡';
    const conf   = result.confianza ? ` · <b>${result.confianza}%</b>` : '';
    const signals = Array.isArray(result.signals_aligned) && result.signals_aligned.length
      ? `\n📡 ${result.signals_aligned.slice(0, 4).join(' · ')}` : '';
    return (
      `${urgent} <b>OPORTUNIDAD</b>\n${dir} <b>${result.par}</b>${conf}\n\n` +
      `📌 Entrada: <code>${result.entrada}</code>\n` +
      `🛡 SL: <code>${result.stopLoss}</code>\n` +
      `🎯 TP1: <code>${result.tp1}</code>` +
      (result.tp2 ? ` · TP2: <code>${result.tp2}</code>` : '') +
      `\n📐 R:R 1:${result.rr}${signals}\n\n<i>${result.razon}</i>\n\n` +
      `🔗 <a href="${config.appUrl || ''}">Abrir app</a>`
    );
  } catch (e) {
    return `❌ Error en el análisis: ${e.message}`;
  }
}

async function cmdCerrar(symbol) {
  if (!isBitunixConfigured()) return '⚠️ Bitunix no configurado.';
  try {
    const posData   = await bitunixRequest('GET', '/api/v1/futures/position/get_pending_positions', {});
    const positions = Array.isArray(posData.data) ? posData.data : [];
    const sym       = symbol.includes('USDT') ? symbol : symbol + 'USDT';
    const pos       = positions.find(p => p.symbol === sym || p.symbol === symbol);
    if (!pos) {
      const avail = positions.map(p => p.symbol).join(', ') || 'ninguna';
      return `📭 No hay posición abierta para <b>${symbol}</b>.\nActuales: ${avail}`;
    }
    await bitunixRequest('POST', '/api/v1/futures/trade/flash_close_position', {}, { positionId: pos.positionId });
    const idx = serverState.activeTrades.findIndex(t => t.par?.split('/')[0] + 'USDT' === sym);
    if (idx > -1) serverState.activeTrades.splice(idx, 1);
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
    const sym       = symbol.includes('USDT') ? symbol : symbol + 'USDT';
    const pos       = positions.find(p => p.symbol === sym || p.symbol === symbol);
    if (!pos) return `📭 No hay posición abierta para <b>${symbol}</b>.`;
    await bitunixRequest('POST', '/api/v1/futures/trade/set_risk_limit', {}, {
      positionId: pos.positionId, stopLoss: String(slPrice),
    });
    const trade = serverState.activeTrades.find(t => (t.par?.split('/')[0] + 'USDT') === sym);
    if (trade) {
      const oldSL  = trade.stopLoss;
      trade.stopLoss = slPrice;
      return `✅ SL de <b>${symbol}</b> movido a <code>${slPrice}</code>${oldSL ? ` (antes: ${oldSL})` : ''}`;
    }
    return `✅ SL de <b>${symbol}</b> movido a <code>${slPrice}</code>`;
  } catch (e) {
    return `❌ Error moviendo SL de ${symbol}: ${e.message}`;
  }
}

async function cmdBreakeven(symbol) {
  if (!isBitunixConfigured()) return '⚠️ Bitunix no configurado.';
  const sym   = symbol.includes('USDT') ? symbol : symbol + 'USDT';
  const coin  = sym.replace('USDT', '');
  const trade = serverState.activeTrades.find(t => t.par?.startsWith(coin));
  if (!trade) return `📭 No encuentro <b>${symbol}</b> en los trades activos.`;
  return await cmdMoveSL(sym, trade.entrada);
}

function cmdScannerOn() {
  const { startServerScanner } = require('./scanner');
  if (scannerState.enabled) return `📡 El escáner ya estaba activo (cada ${scannerState.intervalMin} min).`;
  startServerScanner();
  return `✅ <b>Escáner activado</b> — cada <b>${scannerState.intervalMin} min</b>.`;
}

function cmdScannerOff() {
  const { stopServerScanner } = require('./scanner');
  if (!scannerState.enabled) return '📡 El escáner ya estaba inactivo.';
  stopServerScanner();
  return '⏸ <b>Escáner detenido.</b> Envía /scanner on para reactivarlo.';
}

function cmdIntervalo(min) {
  scannerState.intervalMin = min;
  if (scannerState.enabled) {
    const { stopServerScanner, startServerScanner } = require('./scanner');
    stopServerScanner();
    startServerScanner();
    return `✅ Intervalo cambiado a <b>${min} min</b> y escáner reiniciado.`;
  }
  return `✅ Intervalo actualizado a <b>${min} min</b>. Se aplica al activar el escáner.`;
}

function cmdAlerta(coin, targetPrice, chatId) {
  const currentPrice = serverState.prices[coin];
  if (!currentPrice) {
    const avail = Object.keys(serverState.prices).join(', ') || 'ninguna';
    return `⚠️ No tengo precio de <b>${coin}</b>.\nDisponibles: ${avail}`;
  }
  const direction = targetPrice > currentPrice ? 'up' : 'down';
  const label     = direction === 'up' ? 'supere' : 'baje de';
  const emoji     = direction === 'up' ? '⬆️' : '⬇️';
  const dist      = Math.abs(((targetPrice - currentPrice) / currentPrice) * 100).toFixed(2);
  const idx       = priceAlerts.findIndex(a => a.coin === coin && a.chatId === chatId);
  if (idx > -1) priceAlerts.splice(idx, 1);
  priceAlerts.push({ coin, targetPrice, direction, chatId, createdAt: Date.now() });
  return (
    `🔔 <b>Alerta configurada</b>\n\n${emoji} Aviso cuando <b>${coin}</b> ${label} <code>$${targetPrice}</code>\n` +
    `Precio actual: <code>$${currentPrice.toFixed(4)}</code> · Distancia: <b>${dist}%</b>`
  );
}

function buildAyudaMsg() {
  return (
    `🤖 <b>COMANDOS DISPONIBLES</b>\n\n` +
    `<b>📊 Información</b>\n` +
    `/estado — cuenta, P&L y win rate\n` +
    `/precios — precios en tiempo real\n` +
    `/trades — trades abiertos con P&L en vivo\n` +
    `/historial — últimos 10 trades cerrados\n` +
    `/resumen — resumen del día y semana\n` +
    `/rendimiento 7 — estadísticas (N días)\n` +
    `/capital — equity real de Bitunix\n` +
    `/coin BTC — análisis técnico completo\n\n` +
    `<b>⚡ Análisis IA</b>\n` +
    `/analizar — lanza análisis IA ahora\n` +
    `/escanear — alias de /analizar\n\n` +
    `<b>🎯 Gestión de trades</b>\n` +
    `/cerrar LTCUSDT — cierra posición en Bitunix\n` +
    `/sl LTCUSDT 54.00 — mueve el stop loss\n` +
    `/breakeven LTCUSDT — SL a precio de entrada\n\n` +
    `<b>📡 Escáner automático</b>\n` +
    `/scanner on|off — activar/detener\n` +
    `/scanner — ver estado\n` +
    `/intervalo 15 — cambiar intervalo (5–240 min)\n\n` +
    `<b>🔔 Alertas de precio</b>\n` +
    `/alerta BTC 70000 — aviso al llegar al precio`
  );
}

/* ── Webhook setup ─────────────────────────────────────────────── */
async function setTelegramWebhook(appUrl) {
  const token = config.telegramToken;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN no configurado');
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${appUrl}/api/telegram/webhook`, allowed_updates: ['message'] }),
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