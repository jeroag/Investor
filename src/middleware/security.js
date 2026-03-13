'use strict';

const helmet = require('helmet');

/**
 * Configura helmet con cabeceras de seguridad ajustadas para una SPA
 * que usa WebSockets a Binance y llama a APIs externas.
 *
 * CSP permite:
 *  - Scripts propios y de cdnjs (Chart.js para equity curve)
 *  - Conexiones WS a Binance, propias y Telegram/Anthropic APIs
 */
const securityMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      connectSrc:    [
        "'self'",
        'wss://stream.binance.com:9443',
        'https://api.anthropic.com',
        'https://api.telegram.org',
        'https://fapi.bitunix.com',
        'ws:',   // WebSocket local (dev)
        'wss:',  // WebSocket local (prod)
      ],
      imgSrc:        ["'self'", 'data:'],
      fontSrc:       ["'self'"],
      objectSrc:     ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  // HSTS — solo en prod (Railway usa HTTPS)
  hsts: {
    maxAge:            31536000,  // 1 año
    includeSubDomains: true,
    preload:           true,
  },
  // Ocultar que usamos Express
  hidePoweredBy:        true,
  // Prevenir clickjacking
  frameguard:          { action: 'deny' },
  // Prevenir MIME sniffing
  noSniff:             true,
  // XSS filter (legacy browsers)
  xssFilter:           true,
  // Referrer policy
  referrerPolicy:      { policy: 'strict-origin-when-cross-origin' },
  // No enviar cabecera X-Powered-By
  crossOriginEmbedderPolicy: false, // desactivar para no romper las APIs externas
});

module.exports = { securityMiddleware };
