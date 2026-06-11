'use strict';

/**
 * Alertas de precio unificadas — única fuente de verdad: Supabase.
 *
 * Antes había dos sistemas desconectados:
 *   - App → tabla price_alerts (nadie las vigilaba en el servidor)
 *   - Telegram /alerta → array en memoria (se perdía en cada redeploy)
 * Ahora ambas van a Supabase y este checker las vigila cada 30 s.
 * Compat de dirección: admite 'above'/'up' y 'below'/'down'.
 */

const db = require('../db/supabase');
const { serverState } = require('../state');

let broadcastFn = null;
function setBroadcast(fn) { broadcastFn = fn; }

let alerts = [];

async function loadAlerts() {
  alerts = await db.loadPriceAlerts();
  console.log(`✓ Alertas de precio cargadas: ${alerts.length}`);
  return alerts;
}

function getAlerts() { return alerts; }

async function addAlert(alert) {
  // Telegram: una alerta por moneda y chat — reemplazar si ya existe
  if (alert.chatId) {
    const dup = alerts.find(a => a.coin === alert.coin && a.chatId === alert.chatId);
    if (dup) await removeAlert(dup.id);
  }
  alerts.push(alert);
  await db.savePriceAlert(alert);
  return alert;
}

async function removeAlert(id) {
  alerts = alerts.filter(a => a.id !== id);
  await db.deletePriceAlert(id);
}

async function removeAlertByCoin(coin) {
  const found = alerts.filter(a => a.coin === coin);
  if (!found.length) return false;
  for (const a of found) await removeAlert(a.id);
  return true;
}

function isUp(direction) { return direction === 'up' || direction === 'above'; }

async function checkAlerts() {
  if (!alerts.length) return;
  const { sendTelegram } = require('./telegram'); // lazy: evita ciclo de require
  for (const a of [...alerts]) {
    const current = serverState.prices[a.coin];
    if (!current) continue;
    const up = isUp(a.direction);
    const triggered = up ? current >= a.targetPrice : current <= a.targetPrice;
    if (!triggered) continue;

    await removeAlert(a.id).catch(() => { });
    const dir = up ? '⬆️' : '⬇️';
    sendTelegram(
      `🔔 <b>ALERTA DE PRECIO</b>\n${dir} <b>${a.coin}</b> ha ` +
      `${up ? 'superado' : 'bajado de'} <code>$${a.targetPrice}</code>\n` +
      `Precio actual: <code>$${current.toFixed(4)}</code>`,
      a.chatId
    ).catch(() => { });
    if (broadcastFn) broadcastFn({ type: 'PRICE_ALERT_TRIGGERED', alert: a, price: current });
    console.log(`[PriceAlert] ${a.coin} ${up ? '≥' : '≤'} ${a.targetPrice} → disparada @ ${current}`);
  }
}

let timer = null;
function startChecker() {
  if (timer) clearInterval(timer);
  timer = setInterval(
    () => checkAlerts().catch(e => console.warn('[PriceAlert]', e.message)),
    30_000,
  );
  timer.unref();
}

module.exports = {
  setBroadcast, loadAlerts, getAlerts,
  addAlert, removeAlert, removeAlertByCoin,
  checkAlerts, startChecker,
};
