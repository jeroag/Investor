'use strict';

const { config }          = require('../config');
const { serverState, scannerState } = require('../state');
const { fetchOHLCV, buildTechSummary, ALL_COINS } = require('./binance');
const { notifyScannerAlert } = require('./telegram');
const db                  = require('../db/supabase');

let broadcastFn = null;
function setBroadcast(fn) { broadcastFn = fn; }

/* ── Monedas para el escáner (subset más líquido) ──────────────── */
const SCANNER_COINS = ['BTC','ETH','SOL','XRP','BNB','DOGE','AVAX','LINK','LTC'];

/* ══════════════════════════════════════════════════════════════════
   CONSTRUCCIÓN DEL CONTEXTO — OHLCV + precios spot
   ══════════════════════════════════════════════════════════════════ */

/**
 * Descarga velas OHLCV 1h para todas las monedas del escáner y
 * genera un bloque de contexto técnico rico para el prompt de Claude.
 *
 * Antes: solo precios spot → Claude "imaginaba" RSI y soportes.
 * Ahora: RSI real, EMA real, soporte/resistencia real, volumen.
 */
async function buildOHLCVContext(coins = SCANNER_COINS) {
  const bars = await fetchOHLCV(coins, '1h', 52);
  const lines = coins.map(coin => {
    const coinBars = bars[coin];
    return buildTechSummary(coin, coinBars);
  });
  return lines.join('\n');
}

/**
 * Contexto de spot prices para monedas sin barras (fallback).
 */
function buildSpotContext() {
  const prices = serverState.prices;
  const coins  = Object.keys(prices);
  if (!coins.length) return 'Sin datos de precio disponibles.';
  return coins
    .map(coin => `${coin}/USDT: $${(prices[coin]?.toFixed ? prices[coin].toFixed(4) : prices[coin])}`)
    .join(' | ');
}

/* ══════════════════════════════════════════════════════════════════
   LLAMADA A CLAUDE — escáner server-side
   ══════════════════════════════════════════════════════════════════ */
async function runServerScan(profile) {
  const apiKey = config.anthropicKey;
  if (!apiKey) return null;

  console.log('[Scanner] Descargando OHLCV…');
  const ohlcvCtx = await buildOHLCVContext(SCANNER_COINS);
  const spotCtx  = buildSpotContext();

  const recent  = scannerState.pendingAlerts.slice(-3)
    .map(a => `${a.par} ${a.tipo} @${a.entrada}`).join(' | ') || 'ninguna';

  const capital  = profile?.capital   || 100;
  const leverage = profile?.leverage  || 1;
  const riskPct  = profile?.risk_pct  || 2;
  const style    = profile?.style     || 'swing';
  const riskUSD  = (capital * riskPct / 100).toFixed(2);

  const prompt = `Eres un escáner de mercado automático 24/7. Analiza datos técnicos reales y detecta oportunidades de trading con alta probabilidad.

━━━ ANÁLISIS TÉCNICO REAL (OHLCV 1h, 52 velas) ━━━
${ohlcvCtx}

━━━ PRECIOS SPOT ADICIONALES ━━━
${spotCtx}

━━━ PERFIL DEL TRADER ━━━
Capital: $${capital} | Riesgo/op: ${riskPct}% = $${riskUSD} | Leverage: ${leverage}x | Estilo: ${style}

━━━ ALERTAS RECIENTES (no duplicar) ━━━
${recent}

━━━ CRITERIOS DE ENTRADA (TODOS deben cumplirse) ━━━
1. RSI en zona de sobreventa (<35) o sobrecompra (>65) según dirección
2. Precio cerca de soporte (LONG) o resistencia (SHORT) real calculado
3. R:R estimado ≥ 2.0 usando los niveles técnicos reales del contexto
4. Volumen ratio > 1.0x (confirma el movimiento)
5. Tendencia EMA alineada con la dirección propuesta
6. No duplicar par+dirección de alertas recientes

━━━ FORMATO DE RESPUESTA ━━━
Responde SOLO con JSON válido (sin markdown, sin texto extra):
{"hay_oportunidad":true,"urgencia":"ALTA","par":"XRP/USDT","tipo":"LONG","setup":"descripcion breve del setup","entrada":2.35,"stopLoss":2.18,"tp1":2.68,"tp2":2.90,"rr":"2.1","confianza":75,"signals_aligned":["RSI=28 sobreventa","precio en soporte $2.18","volumen 1.8x"],"razon":"explicacion concisa max 2 lineas","contexto_mercado":"resumen del mercado general"}
Si no hay oportunidad clara: {"hay_oportunidad":false,"razon":"motivo concreto"}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 800,
        system:     'Eres escáner técnico de criptomonedas. Responde SOLO JSON válido sin markdown ni texto adicional.',
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    const data  = await response.json();
    const text  = data?.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[Scanner] Error Claude:', e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════
   CONTROL DEL ESCÁNER
   ══════════════════════════════════════════════════════════════════ */
function startServerScanner(profile) {
  if (scannerState.timer) clearInterval(scannerState.timer);
  scannerState.enabled     = true;
  scannerState.intervalMin = profile?.scan_interval || 15;

  const doScan = async () => {
    if (!scannerState.enabled) return;
    console.log(`[Scanner] Escaneo — ${new Date().toLocaleTimeString('es-ES')}`);
    scannerState.lastScan = Date.now();

    const result = await runServerScan(profile);
    if (!result) return;

    if (result.hay_oportunidad) {
      const alert = {
        ...result,
        id:        `srv_${Date.now()}`,
        timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
        source:    'server',
        status:    'pending',
      };
      scannerState.lastAlert = alert;
      scannerState.pendingAlerts.unshift(alert);
      if (scannerState.pendingAlerts.length > 20) scannerState.pendingAlerts.pop();

      if (broadcastFn) broadcastFn({ type: 'SCANNER_ALERT', alert });
      notifyScannerAlert(alert);
      db.saveAlert(alert).catch(() => {});
      console.log(`[Scanner] 🚨 ${alert.par} ${alert.tipo} @ ${alert.entrada}`);
    } else {
      console.log(`[Scanner] Sin oportunidad: ${result.razon}`);
    }
  };

  doScan();
  scannerState.timer = setInterval(doScan, scannerState.intervalMin * 60_000);
  console.log(`[Scanner] ✓ Activo — cada ${scannerState.intervalMin} min`);
}

function stopServerScanner() {
  if (scannerState.timer) clearInterval(scannerState.timer);
  scannerState.timer   = null;
  scannerState.enabled = false;
  console.log('[Scanner] ✗ Detenido');
}

module.exports = { setBroadcast, startServerScanner, stopServerScanner, runServerScan };
