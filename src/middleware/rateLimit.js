'use strict';

/**
 * Rate limiters por tipo de ruta — v1.1 (AUDITADO)
 *
 * CORRECCIÓN [CRÍTICO]: El Map `store` anterior nunca limpiaba entradas antiguas.
 * Cada IP única quedaba almacenada para siempre, causando un memory leak que
 * en Railway (contenedores de larga vida) podría provocar OOM y crash del proceso.
 *
 * SOLUCIÓN:
 *   - Añadida limpieza periódica automática cada `windowMs * 2` en cada instancia.
 *   - La limpieza elimina entradas cuya ventana de tiempo ya ha expirado.
 *   - El timer usa `unref()` para no bloquear el proceso en tests/shutdown.
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

  // ── CORRECCIÓN: limpieza periódica para evitar memory leak ──────────────
  // Se ejecuta cada 2 ventanas de tiempo. unref() evita que el timer impida
  // al proceso de Node terminar limpiamente (Ctrl+C, Railway stop, etc.)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of store) {
      if (now - rec.start > windowMs) store.delete(ip);
    }
  }, windowMs * 2).unref();

  return function rateLimiter(req, res, next) {
    // Con app.set('trust proxy', 1), req.ip ya es la IP real del cliente.
    // Leer el header X-Forwarded-For a mano era spoofable → permitía saltarse
    // el rate limit / brute-force enviando un XFF falso en cada petición.
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
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

const rateLimitGeneral = makeRateLimiter({
  maxRequests: 60,
  windowMs: 60_000,
  message: 'Límite general: 60 req/min. Espera un momento.',
});

const rateLimitClaude = makeRateLimiter({
  maxRequests: 5,
  windowMs: 60_000,
  message: 'Límite Claude API: 5 análisis/min. Espera antes de pedir otro análisis.',
});

const rateLimitAuth = makeRateLimiter({
  maxRequests: 10,
  windowMs: 60_000,
  message: 'Demasiados intentos de login. Espera 1 minuto.',
});

const rateLimitTradingView = makeRateLimiter({
  maxRequests: 30,
  windowMs: 60_000,
  message: 'Webhook TradingView: límite de 30 req/min.',
});

module.exports = {
  makeRateLimiter,
  rateLimitGeneral,
  rateLimitClaude,
  rateLimitAuth,
  rateLimitTradingView,
};