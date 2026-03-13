'use strict';

const helmet = require('helmet');

const securityMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      connectSrc:    [
        "'self'",
        'wss://stream.binance.com:9443',
        'https://api.binance.com',
        'https://api.anthropic.com',
        'https://api.telegram.org',
        'https://fapi.bitunix.com',
        'ws:',
        'wss:',
      ],
      frameSrc: [
        "'self'",
        'https://s.tradingview.com',
        'https://www.tradingview.com',
        'https://charts.bitunix.com',
      ],
      imgSrc:    ["'self'", 'data:', 'https://s3-symbol-logo.tradingview.com'],
      fontSrc:   ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge:            31536000,
    includeSubDomains: true,
    preload:           true,
  },
  // Desactivar X-Frame-Options para que el iframe de TradingView funcione
  frameguard:                false,
  hidePoweredBy:             true,
  noSniff:                   true,
  xssFilter:                 true,
  referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
});

module.exports = { securityMiddleware };