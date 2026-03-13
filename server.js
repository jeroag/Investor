'use strict';

/* ══════════════════════════════════════════════════════════════════
   CryptoPlan IA — server.js v2.0
   Punto de entrada limpio. Toda la lógica está en src/
   ══════════════════════════════════════════════════════════════════ */

const express  = require('express');
const path     = require('path');

// 1. Validar entorno antes de cualquier otra cosa
const { validateEnv, config } = require('./src/config');
validateEnv();

// 2. Módulos de la app
const { securityMiddleware }   = require('./src/middleware/security');
const { requireAuth, restoreSessions, scheduleSessionCleanup } = require('./src/middleware/auth');

const db           = require('./src/db/supabase');
const { serverState } = require('./src/state');
const ws           = require('./src/websocket');

const binance  = require('./src/services/binance');
const tpsl     = require('./src/services/tpsl');
const scanner  = require('./src/services/scanner');
const tvModule = require('./src/routes/tradingview');

// 3. Rutas
const authRoutes       = require('./src/routes/auth');
const tradesRoutes     = require('./src/routes/trades');
const scannerRoutes    = require('./src/routes/scanner');
const claudeRoutes     = require('./src/routes/claude');
const telegramRoutes   = require('./src/routes/telegram');
const { router: bitunixRoutes } = require('./src/routes/bitunix');

/* ══════════════════════════════════════════════════════════════════
   APP EXPRESS
   ══════════════════════════════════════════════════════════════════ */
const app = express();

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
app.use('/api/trades',      tradesRoutes);
app.use('/api/scanner',     scannerRoutes);
app.use('/api/claude',      claudeRoutes);
app.use('/api/telegram',    telegramRoutes);
app.use('/api/bitunix',     bitunixRoutes);
app.use('/api/tradingview', tvModule.router);

/* ── Precios (alias rápido) ────────────────────────────────────── */
app.get('/api/prices', requireAuth, (req, res) =>
  res.json(serverState.prices));

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
  [serverState.activeTrades, serverState.closedTrades] = await Promise.all([
    db.loadActiveTrades(),
    db.loadClosedTrades(),
  ]);
  console.log(`✓ Trades activos: ${serverState.activeTrades.length} | Cerrados: ${serverState.closedTrades.length}`);

  // Restaurar sesiones
  await restoreSessions();
  scheduleSessionCleanup();

  // Inyectar broadcast en servicios que lo necesitan
  tpsl.setBroadcast(ws.broadcast);
  scanner.setBroadcast(ws.broadcast);
  tvModule.setBroadcast(ws.broadcast);

  // Registrar callback de precio → TP/SL + broadcast
  binance.onPrice((coin, price) => {
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
}

bootstrap().catch(err => {
  console.error('❌  Error fatal en bootstrap:', err);
  process.exit(1);
});
