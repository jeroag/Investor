const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate Limiting simple (sin dependencias extra) ─────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT   = 20;   // máx peticiones
const RATE_WINDOW  = 60_000; // por minuto (ms)

function rateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };

  if (now - entry.start > RATE_WINDOW) {
    // Ventana expirada → reiniciar
    rateLimitMap.set(ip, { count: 1, start: now });
    return next();
  }

  if (entry.count >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Demasiadas peticiones. Espera un minuto.' });
  }

  entry.count++;
  rateLimitMap.set(ip, entry);
  next();
}

// Limpiar IPs antiguas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.start > RATE_WINDOW) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

// ── Proxy seguro para Claude API ──────────────────────────────────────────
app.post('/api/claude', rateLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en el servidor.' });
  }

  const { model, max_tokens, system, messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Parámetro messages inválido.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      model      || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 1000,
        system,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Error de la API de Anthropic.'
      });
    }

    res.json(data);
  } catch (err) {
    console.error('Error proxy Claude:', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ── Fallback → index.html ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CryptoPlan IA corriendo en puerto ${PORT}`);
});
