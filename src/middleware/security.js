'use strict';

const helmet = require('helmet');

const securityMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],  // permite onclick="..." generados por app.js
      styleSrc:      ["'self'", "'unsafe-inline'"],
      connectSrc:    [
        "'self'",
        'wss://stream.binance.com:9443',
        'https://api.anthropic.com',
        'https://api.telegram.org',
        'https://fapi.bitunix.com',
        'ws:',
        'wss:',
      ],
      imgSrc:        ["'self'", 'data:'],
      fontSrc:       ["'self'"],
      objectSrc:     ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge:            31536000,
    includeSubDomains: true,
    preload:           true,
  },
  hidePoweredBy:             true,
  frameguard:                { action: 'deny' },
  noSniff:                   true,
  xssFilter:                 true,
  referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
});

module.exports = { securityMiddleware };