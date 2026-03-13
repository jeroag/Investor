'use strict';

const helmet = require('helmet');

const securityMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     [
        "'self'",
        "'unsafe-inline'",
        'https://cdnjs.cloudflare.com',
        'https://unpkg.com',              // lightweight-charts y otras librerías
        'https://s.tradingview.com',      // widget TradingView
        'https://www.tradingview.com',
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      [
        "'self'",
        "'unsafe-inline'",
        'https://fonts.googleapis.com',   // fuentes Google
      ],
      fontSrc:       [
        "'self'",
        'https://fonts.gstatic.com',      // archivos de fuentes Google
      ],
      connectSrc:    [
        "'self'",
        'wss://stream.binance.com:9443',
        'https://api.binance.com',
        'https://api.anthropic.com',
        'https://api.telegram.org',
        'https://fapi.bitunix.com',
        'https://nfs.faireconomy.media',  // calendario económico
        'https://unpkg.com',
        'ws:',
        'wss:',
      ],
      frameSrc:      [
        "'self'",
        'https://s.tradingview.com',
        'https://www.tradingview.com',
        'https://charts.bitunix.com',
      ],
      imgSrc:        [
        "'self'",
        'data:',
        'https://s3-symbol-logo.tradingview.com',
        'https://www.tradingview.com',
      ],
      objectSrc:     ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge:            31536000,
    includeSubDomains: true,
    preload:           true,
  },
  frameguard:                false,
  hidePoweredBy:             true,
  noSniff:                   true,
  xssFilter:                 true,
  referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
});

module.exports = { securityMiddleware };