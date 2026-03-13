'use strict';

/**
 * Estado compartido en memoria.
 * Se restaura desde Supabase al arrancar (ver server.js).
 * Todos los módulos importan este objeto — es la única fuente de verdad en RAM.
 */
const serverState = {
  activeTrades: [],   // restaurado desde Supabase
  closedTrades: [],   // restaurado desde Supabase
  prices:       {},   // actualizado por binance.js en tiempo real
};

/**
 * Estado del escáner de mercado.
 */
const scannerState = {
  enabled:       false,
  intervalMin:   15,
  lastScan:      0,
  lastAlert:     null,
  pendingAlerts: [],
  timer:         null,
};

/**
 * Estado de Bitunix (para caché de configuración).
 */
const bitunixState = {
  configured: false,
};

module.exports = { serverState, scannerState, bitunixState };
