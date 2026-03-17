'use strict';

/**
 * CryptoPlan IA — services/bitunix.js v1.1 (AUDITADO)
 *
 * CORRECCIÓN [MEDIO] — Sin timeout en llamadas a Bitunix API:
 *   Las llamadas `fetch()` originales no tenían timeout. Si la API de Bitunix
 *   colgaba (red lenta, mantenimiento, etc.), la promesa quedaba pendiente
 *   indefinidamente, bloqueando el bucle de TP/SL y potencialmente agotando
 *   el pool de handles de Node.js en Railway.
 *
 *   SOLUCIÓN: Se añade `AbortSignal.timeout(10_000)` (10 segundos) a cada
 *   llamada. Si Bitunix no responde en 10s, la llamada falla con un error
 *   claro que el caller puede capturar y registrar.
 */

const crypto = require('crypto');
const { config } = require('../config');

const BITUNIX_BASE_URL = 'https://fapi.bitunix.com';
const REQUEST_TIMEOUT_MS = 10_000; // 10 segundos

/* ── Firma Bitunix ─────────────────────────────────────────────── */
function sha256(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }
function generateNonce() { return crypto.randomBytes(16).toString('hex'); }

function bitunixSign(apiKey, secretKey, nonce, timestamp, queryParamsObj, bodyStr) {
  const qp = Object.keys(queryParamsObj || {}).sort()
    .map(k => `${k}${queryParamsObj[k]}`).join('');
  const digest = sha256(`${nonce}${timestamp}${apiKey}${qp}${bodyStr || ''}`);
  return sha256(`${digest}${secretKey}`);
}

/**
 * Realiza una petición autenticada a la API de Bitunix.
 * Incluye timeout de 10 segundos para evitar bloqueos indefinidos.
 *
 * @throws {Error} si la API no responde en 10s, devuelve HTTP error, o code !== 0
 */
async function bitunixRequest(method, endpoint, queryParams = {}, bodyObj = null) {
  const apiKey = (config.bitunixApiKey || '').trim();
  const secretKey = (config.bitunixSecret || '').trim();
  if (!apiKey || !secretKey)
    throw new Error('BITUNIX_API_KEY o BITUNIX_SECRET no configurados.');

  const nonce = generateNonce();
  const timestamp = Date.now().toString();
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const bodyForSign = bodyStr.replace(/\s+/g, '');
  const sign = bitunixSign(apiKey, secretKey, nonce, timestamp, queryParams, bodyForSign);

  const qs = Object.keys(queryParams).length
    ? '?' + Object.keys(queryParams).sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`).join('&')
    : '';

  const headers = {
    'Content-Type': 'application/json',
    'api-key': apiKey,
    'nonce': nonce,
    'timestamp': timestamp,
    'sign': sign,
    'language': 'en-US',
  };
  const options = {
    method,
    headers,
    // CORRECCIÓN: timeout de 10 segundos para evitar peticiones colgadas
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (bodyObj) options.body = bodyForSign;

  let res, text;
  try {
    res = await fetch(BITUNIX_BASE_URL + endpoint + qs, options);
    text = await res.text();
  } catch (fetchErr) {
    // AbortError = timeout; TypeError = red caída
    const isTimeout = fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError';
    throw new Error(
      isTimeout
        ? `Bitunix timeout (>${REQUEST_TIMEOUT_MS / 1000}s) en ${method} ${endpoint}`
        : `Bitunix red error: ${fetchErr.message}`
    );
  }

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Respuesta no-JSON [HTTP ${res.status}]: ${text.slice(0, 300)}`); }

  if (data.code !== 0)
    throw new Error(`Bitunix error [${data.code}]: ${data.msg || JSON.stringify(data)}`);

  return data;
}

/**
 * Devuelve true si Bitunix está configurado.
 */
function isBitunixConfigured() {
  return !!(config.bitunixApiKey && config.bitunixSecret);
}

module.exports = { bitunixRequest, isBitunixConfigured, bitunixSign, generateNonce };