'use strict';

const express        = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimitClaude } = require('../middleware/rateLimit');
const { config }     = require('../config');

const router = express.Router();

router.post('/', requireAuth, rateLimitClaude, async (req, res) => {
  const apiKey = config.anthropicKey;
  if (!apiKey)
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada.' });

  const { model, max_tokens, system, messages } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'messages inválido.' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      model      || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 4000,
        system,
        messages,
      }),
    });
    const data = await response.json();
    if (!response.ok)
      return res.status(response.status).json({ error: data?.error?.message || 'Error Anthropic.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error interno: ' + err.message });
  }
});

module.exports = router;
