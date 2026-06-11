'use strict';

/* ══════════════════════════════════════════════════════════════════
   CryptoPlan IA — server.js v2.0
   Punto de entrada limpio. Toda la lógica está en src/
   ══════════════════════════════════════════════════════════════════ */

const express = require('express');
const path = require('path');

// 1. Validar entorno antes de cualquier otra cosa
const { validateEnv, config } = require('./src/config');
validateEnv();

// 2. Módulos de la app
const { securityMiddleware } = require('./src/middleware/security');
const { requireAuth, restoreSessions, scheduleSessionCleanup } = require('./src/middleware/auth');

const db = require('./src/db/supabase');
const { serverState, scannerState } = require('./src/state');
const ws = require('./src/websocket');

const binance = require('./src/services/binance');
const { startXAUPolling } = require('./src/services/binance');
const tpsl = require('./src/services/tpsl');
const scanner = require('./src/services/scanner');
const priceAlertsSvc = require('./src/services/pricealerts');
const watchdog = require('./src/services/watchdog');
const tvModule = require('./src/routes/tradingview');

// 3. Rutas
const authRoutes = require('./src/routes/auth');
const tradesRoutes = require('./src/routes/trades');
const scannerRoutes = require('./src/routes/scanner');
const claudeRoutes = require('./src/routes/claude');
const telegramRoutes = require('./src/routes/telegram');
const { router: bitunixRoutes } = require('./src/routes/bitunix');
const diaryRoutes = require('./src/routes/diary');
const priceAlertRoutes = require('./src/routes/pricealerts');

/* ══════════════════════════════════════════════════════════════════
   APP EXPRESS
   ══════════════════════════════════════════════════════════════════ */
const app = express();

// Detrás del proxy de Railway: req.secure y req.ip correctos
app.set('trust proxy', 1);

// Seguridad (helmet + CSP)
app.use(securityMiddleware);
app.use(express.json({ limit: '1mb' }));

/* ── Rutas públicas ────────────────────────────────────────────── */
app.get('/login', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ── Auth ──────────────────────────────────────────────────────── */
app.use('/auth', authRoutes);

/* ── API (requieren auth por defecto — cada router aplica requireAuth) ── */
app.use('/api/trades', tradesRoutes);
app.use('/api/scanner', scannerRoutes);
app.use('/api/claude', claudeRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/bitunix', bitunixRoutes);
app.use('/api/tradingview', tvModule.router);
app.use('/api/diary', diaryRoutes);
app.use('/api/profile', require('./src/routes/profile'));
app.use('/api/price-alerts', priceAlertRoutes);

/* ── Precios (alias rápido) ────────────────────────────────────── */
app.get('/api/prices', requireAuth, (req, res) =>
  res.json(serverState.prices));

/* ── Proxy klines para XAU/USDT (Binance Futures — CORS blocked en browser) ── */
// El backtester llama a /api/klines?symbol=XAUUSDT&interval=4h&limit=750
// El servidor hace la petición a fapi.binance.com y devuelve el JSON al cliente.
// No requiere auth para no bloquear el backtester, pero sí rate limit.
app.get('/api/klines', requireAuth, async (req, res) => {
  const { symbol, interval, limit } = req.query;
  const sym = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const iv = (interval || '4h').replace(/[^a-zA-Z0-9]/g, '');
  const lim = Math.min(parseInt(limit) || 500, 1000);
  if (!sym) return res.status(400).json({ error: 'symbol requerido' });
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${iv}&limit=${lim}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return res.status(resp.status).json({ error: err.msg || 'Binance Futures error' });
    }
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── SPA fallback ──────────────────────────────────────────────── */
app.get('*', (req, res) => {
  const auth = require('./src/middleware/auth');
  if (!auth.isAuthenticated(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ══════════════════════════════════════════════════════════════════
   ARRANQUE ASÍNCRONO
   ══════════════════════════════════════════════════════════════════ */
async function bootstrap() {
  // Restaurar estado desde Supabase
  console.log('\n🔄  Restaurando estado desde Supabase…');
  try {
    const [activeTrades, closedTrades, recentAlerts] = await Promise.all([
      db.loadActiveTrades(),
      db.loadClosedTrades(),
      db.loadRecentAlerts(50),
    ]);
    serverState.activeTrades = activeTrades;
    serverState.closedTrades = closedTrades;
    scannerState.pendingAlerts = recentAlerts;
    console.log(`✓ Trades activos: ${serverState.activeTrades.length} | Cerrados: ${serverState.closedTrades.length} | Alertas: ${recentAlerts.length}`);
  } catch (dbErr) {
    console.error('⚠️  Supabase no disponible al arrancar — continuando sin datos persistidos:', dbErr.message);
    console.error('   La app funcionará en modo degradado (datos en memoria solamente).');
  }

  // Restaurar sesiones
  await restoreSessions();
  scheduleSessionCleanup();

  // Inyectar broadcast en servicios que lo necesitan
  tpsl.setBroadcast(ws.broadcast);
  scanner.setBroadcast(ws.broadcast);
  tvModule.setBroadcast(ws.broadcast);
  priceAlertsSvc.setBroadcast(ws.broadcast);

  // Registrar callback de precio → TP/SL + broadcast
  binance.onPrice((coin, price) => {
    serverState.lastPriceAt = Date.now(); // para el watchdog
    tpsl.checkTPSL(coin, price);
    ws.broadcastPrice(coin, price);
  });

  // Arrancar servidor HTTP
  const httpServer = app.listen(config.port, () => {
    console.log(`\n🚀  CryptoPlan IA v2.0 en puerto ${config.port}\n`);
  });

  // WebSocket upgrade
  httpServer.on('upgrade', ws.handleUpgrade);

  // Conectar Binance WS
  binance.connectBinanceWS();

  // XAU: precio via Bitunix REST (Binance spot no tiene XAUUSDT)
  startXAUPolling(binance.onPriceCallbacks);

  // Alertas de precio unificadas (Supabase) — un solo checker server-side
  await priceAlertsSvc.loadAlerts().catch(e =>
    console.warn('No se pudieron cargar las alertas de precio:', e.message));
  priceAlertsSvc.startChecker();

  // Watchdog: precios congelados + reconciliación con Bitunix
  watchdog.startWatchdog();

  // Reanudar el escáner si estaba activo antes del reinicio/redeploy
  try {
    const savedScanner = await db.loadScannerState();
    if (savedScanner?.enabled) {
      const prof = savedScanner.profile || {};
      if (savedScanner.intervalMin) prof.scan_interval = savedScanner.intervalMin;
      console.log('🔄  Reanudando escáner tras reinicio…');
      scanner.startServerScanner(Object.keys(prof).length ? prof : undefined);
    }
  } catch (e) {
    console.warn('No se pudo reanudar el escáner:', e.message);
  }
}

bootstrap().catch(err => {
  console.error('❌  Error fatal en bootstrap:', err);
  process.exit(1);
});