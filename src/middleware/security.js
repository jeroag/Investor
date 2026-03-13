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
        'wss://stream.binance.com:9443',  // WebSocket precios
        'https://api.binance.com',         // REST OHLCV (RSI, soporte, resistencia)
        'https://api.anthropic.com',
        'https://api.telegram.org',
        'https://fapi.bitunix.com',
        'ws:',
        'wss:',
      ],
      imgSrc:        ["'self'", 'data:', 'https://s3-symbol-logo.tradingview.com'],
      fontSrc:       ["'self'"],
      objectSrc:     ["'none'"],
      frameSrc:      ["'self'", 'https://s.tradingview.com'],  // widget TradingView
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge:            31536000,
    includeSubDomains: true,
    preload:           true,
  },
  hidePoweredBy:             true,
  frameguard:                false,   // desactivado para permitir iframe de TradingView
  noSniff:                   true,
  xssFilter:                 true,
  referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
});

module.exports = { securityMiddleware };