'use strict';

const crypto = require('crypto');
const { config } = require('../config');

/* ── Firma Bitunix ─────────────────────────────────────────────── */
function sha256(str) { return crypto.createHash('sha256').update(str, 'utf8').digest('hex'); }
function generateNonce() { return crypto.randomBytes(16).toString('hex'); }

function bitunixSign(apiKey, secretKey, nonce, timestamp, queryParamsObj, bodyStr) {
  const qp     = Object.keys(queryParamsObj || {}).sort()
    .map(k => `${k}${queryParamsObj[k]}`).join('');
  const digest = sha256(`${nonce}${timestamp}${apiKey}${qp}${bodyStr || ''}`);
  return sha256(`${digest}${secretKey}`);
}

/**
 * Realiza una petición autenticada a la API de Bitunix.
 */
async function bitunixRequest(method, endpoint, queryParams = {}, bodyObj = null) {
  const apiKey    = (config.bitunixApiKey || '').trim();
  const secretKey = (config.bitunixSecret  || '').trim();
  if (!apiKey || !secretKey)
    throw new Error('BITUNIX_API_KEY o BITUNIX_SECRET no configurados.');

  const nonce       = generateNonce();
  const timestamp   = Date.now().toString();
  const bodyStr     = bodyObj ? JSON.stringify(bodyObj) : '';
  const bodyForSign = bodyStr.replace(/\s+/g, '');
  const sign        = bitunixSign(apiKey, secretKey, nonce, timestamp, queryParams, bodyForSign);

  const qs = Object.keys(queryParams).length
    ? '?' + Object.keys(queryParams).sort()
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`).join('&')
    : '';

  const headers = {
    'Content-Type': 'application/json',
    'api-key':      apiKey,
    'nonce':        nonce,
    'timestamp':    timestamp,
    'sign':         sign,
    'language':     'en-US',
  };
  const options = { method, headers };
  if (bodyObj) options.body = bodyForSign;

  const res  = await fetch('https://fapi.bitunix.com' + endpoint + qs, options);
  const text = await res.text();
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

module.exports = { bitunixRequest, isBitunixConfigured };