'use strict';

/**
 * Rate limiters por tipo de ruta.
 *
 * ┌─────────────────────┬────────────┬──────────────────────────────────────┐
 * │ Middleware          │ Límite     │ Usado en                             │
 * ├─────────────────────┼────────────┼──────────────────────────────────────┤
 * │ rateLimitGeneral    │ 60 req/min │ Rutas de API general                 │
 * │ rateLimitClaude     │  5 req/min │ POST /api/claude (cara en tokens)    │
 * │ rateLimitAuth       │ 10 req/min │ POST /auth/login (brute-force)       │
 * │ rateLimitTradingView│ 30 req/min │ POST /api/tradingview/webhook        │
 * └─────────────────────┴────────────┴──────────────────────────────────────┘
 */

function makeRateLimiter({ maxRequests, windowMs, message }) {
  const store = new Map();

  return function rateLimiter(req, res, next) {
    const ip  = req.headers['x-forwarded-for']?.split(',')[0].trim()
              || req.socket.remoteAddress
              || 'unknown';
    const now = Date.now();
    const rec = store.get(ip) || { count: 0, start: now };

    if (now - rec.start > windowMs) {
      store.set(ip, { count: 1, start: now });
      return next();
    }
    if (rec.count >= maxRequests) {
      const retryAfter = Math.ceil((rec.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: message || 'Demasiadas peticiones. Intenta más tarde.' });
    }
    rec.count++;
    store.set(ip, rec);
    next();
  };
}

// Limpieza periódica de entradas antiguas (cada 5 min)
// No es necesario limpiar el store de cada limiter individualmente —
// las entradas caducan naturalmente, pero conviene evitar memory leaks en servidores largos.
// Exportamos la factory por si se necesita más instancias.

const rateLimitGeneral = makeRateLimiter({
  maxRequests: 60,
  windowMs:    60_000,
  message:     'Límite general: 60 req/min. Espera un momento.',
});

const rateLimitClaude = makeRateLimiter({
  maxRequests: 5,
  windowMs:    60_000,
  message:     'Límite Claude API: 5 análisis/min. Espera antes de pedir otro análisis.',
});

const rateLimitAuth = makeRateLimiter({
  maxRequests: 10,
  windowMs:    60_000,
  message:     'Demasiados intentos de login. Espera 1 minuto.',
});

const rateLimitTradingView = makeRateLimiter({
  maxRequests: 30,
  windowMs:    60_000,
  message:     'Webhook TradingView: límite de 30 req/min.',
});

module.exports = {
  makeRateLimiter,
  rateLimitGeneral,
  rateLimitClaude,
  rateLimitAuth,
  rateLimitTradingView,
};
