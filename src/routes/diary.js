'use strict';

const express          = require('express');
const { requireAuth }  = require('../middleware/auth');
const { rateLimitGeneral } = require('../middleware/rateLimit');
const db               = require('../db/supabase');
const { serverState }  = require('../state');

const router = express.Router();

/* ── GET /api/diary — cargar todas las entradas ──────────────────── */
router.get('/', requireAuth, async (req, res) => {
  try {
    const entries = await db.loadDiaryEntries(365);
    res.json({ ok: true, entries });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── POST /api/diary — guardar o actualizar entrada ─────────────── */
router.post('/', requireAuth, rateLimitGeneral, async (req, res) => {
  const { entry } = req.body;
  if (!entry || !entry.id || !entry.date)
    return res.status(400).json({ ok: false, error: 'entry inválida' });
  try {
    await db.saveDiaryEntry(entry);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── DELETE /api/diary/:id ───────────────────────────────────────── */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await db.deleteDiaryEntry(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── GET /api/diary/weekly-summary — resumen semanal con IA ─────── */
router.get('/weekly-summary', requireAuth, async (req, res) => {
  const { config } = require('../config');
  if (!config.anthropicKey)
    return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY no configurada' });

  try {
    const entries = await db.loadDiaryEntries(7);
    const trades  = serverState.closedTrades;
    const now     = Date.now();
    const week    = 7 * 86_400_000;

    const weekTrades = trades.filter(t => (now - new Date(t.closedAt || 0).getTime()) < week);
    const wins       = weekTrades.filter(t => t.result === 'WIN').length;
    const totalPnl   = weekTrades.reduce((a, t) => a + (t.pnl || 0), 0);

    const diaryContext = entries.map(e =>
      `${e.date} | Ánimo: ${e.mood} | P&L: ${e.pnl != null ? '$' + e.pnl.toFixed(2) : '—'}\nNotas: ${e.notes || '—'}\nLección: ${e.lessons || '—'}`
    ).join('\n---\n');

    const prompt = `Eres un coach de trading. Analiza esta semana de trading y genera un resumen conciso en español.

DATOS DE LA SEMANA:
- Operaciones cerradas: ${weekTrades.length} (${wins}W / ${weekTrades.length - wins}L)
- P&L total: $${totalPnl.toFixed(2)}
- Win rate: ${weekTrades.length > 0 ? ((wins / weekTrades.length) * 100).toFixed(0) : 0}%

DIARIO DE LA SEMANA:
${diaryContext || 'Sin entradas de diario esta semana.'}

Genera un JSON con este formato exacto (sin markdown):
{
  "titulo": "string corto con emoji",
  "balance": "1-2 frases sobre el balance general",
  "fortaleza": "la cosa más positiva de la semana",
  "mejora": "la cosa más importante a mejorar",
  "leccion": "lección clave destilada de las entradas del diario",
  "objetivo_proxima": "un objetivo concreto y medible para la semana siguiente"
}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    const text   = aiData.content?.[0]?.text || '';

    let summary;
    try {
      summary = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      summary = { titulo: '📅 Resumen semanal', balance: text, fortaleza: '—', mejora: '—', leccion: '—', objetivo_proxima: '—' };
    }

    res.json({ ok: true, summary, stats: { trades: weekTrades.length, wins, pnl: totalPnl } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;