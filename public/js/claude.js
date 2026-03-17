/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — claude.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── Claude API (proxy seguro vía servidor) ──────────────────────────────── */
async function callClaude(prompt, system, useHistory = false) {
  // Construir mensajes con historial si se pide
  let messages;
  if (useHistory && state.aiHistory.length > 0) {
    // Últimos 6 intercambios (12 mensajes) para no exceder tokens
    messages = [...state.aiHistory.slice(-12), { role: 'user', content: prompt }];
  } else {
    messages = [{ role: 'user', content: prompt }];
  }

  const res = await authFetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system,
      messages,
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error del servidor');
  const reply = data.content[0]?.text || '';

  // Guardar en historial si se usa
  if (useHistory) {
    state.aiHistory.push({ role: 'user', content: prompt });
    state.aiHistory.push({ role: 'assistant', content: reply });
    if (state.aiHistory.length > 20) state.aiHistory = state.aiHistory.slice(-20);
    saveKey('aiHistory', state.aiHistory);
  }

  return reply;
}

function parseJSON(raw) {
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    // Si el JSON viene truncado, intenta repararlo buscando el último objeto completo
    const clean = raw.replace(/```json|```/g, '').trim();
    // Buscar el último } o ] válido
    for (let i = clean.length - 1; i >= 0; i--) {
      if (clean[i] === '}' || clean[i] === ']') {
        try {
          return JSON.parse(clean.slice(0, i + 1));
        } catch {}
      }
    }
    throw new Error('No se pudo parsear la respuesta IA: ' + e.message);
  }
}

/* ── Contexto técnico completo para prompts ──────────────────────────────── */
function buildTechContext() {
  const btcMeta = MARKET_META['BTC'];
  const btcTrend = btcMeta ? `BTC tendencia macro: ${btcMeta.macroTrend} (RSI 1D: ${btcMeta.rsi1d})` : '';

  const lines = state.watchedCoins.map(coin => {
    const meta  = MARKET_META[coin];
    const price = state.prices[coin];
    if (!meta || !price) return null;

    const p = (v, d=2) => v != null ? (+v).toFixed(d) : '?';
    const conf = meta.confluence;

    // EMAs
    const emaLine = meta.ema
      ? `EMA20=${p(meta.ema.ema20)} EMA50=${p(meta.ema.ema50)} EMA200=${p(meta.ema.ema200)} | precio ${price>meta.ema.ema50?'SOBRE':'BAJO'} EMA50 ${price>meta.ema.ema200?'SOBRE':'BAJO'} EMA200`
      : '';

    // MACD
    const macdLine = meta.macd
      ? `MACD=${p(meta.macd.macd,4)} Señal=${p(meta.macd.signal,4)} Hist=${p(meta.macd.hist,4)} (${meta.macd.hist>0?'ALCISTA':'BAJISTA'})`
      : '';

    // BB
    const bbLine = meta.bb
      ? `BB: lower=${p(meta.bb.lower)} mid=${p(meta.bb.mid)} upper=${p(meta.bb.upper)} ancho=${p(meta.bb.width,1)}% | precio ${price<meta.bb.lower?'BAJO BANDA — sobreventa extrema':price>meta.bb.upper?'SOBRE BANDA — sobrecompra extrema':price<meta.bb.mid?'bajo media BB':'sobre media BB'}`
      : '';

    // ATR → SL sugerido
    const atrLine = meta.atr
      ? `ATR(14)=${p(meta.atr,4)} → SL mínimo recomendado: ${p(meta.atr*1.5,4)} (1.5×ATR)`
      : '';

    // Volumen
    const volLine = meta.vol
      ? `Vol: ${meta.vol.ratio}× avg20 (${meta.vol.signal}), tendencia ${meta.vol.trending}`
      : '';

    // Patrones
    const pattLine = meta.patterns?.length > 0
      ? `Patrón última vela: ${meta.patterns.map(p=>p.name+' '+p.bias+' '+p.strength).join(', ')}`
      : 'Sin patrón destacado';

    // Confluencia
    const confLine = conf
      ? `CONFLUENCIA: ${conf.score}% alcista (${conf.bull} señales alcistas, ${conf.bear} bajistas) → SESGO ${conf.bias}`
      : '';

    return [
      `\n── ${coin}/USDT ──`,
      `Precio: $${price} | Tendencia macro 1D: ${meta.macroTrend} | RSI 1D: ${meta.rsi1d}`,
      `RSI 4H: ${meta.rsi} | Soporte 4H: ${meta.sup} | Resistencia 4H: ${meta.res}`,
      `Soporte diario: ${meta.supDay} | Resistencia diaria: ${meta.resDay}`,
      emaLine, macdLine, bbLine, atrLine, volLine, pattLine, confLine,
    ].filter(Boolean).join('\n');
  }).filter(Boolean);

  return [btcTrend, ...lines].join('\n');
}

function buildTradeHistory() {
  const { closedTrades } = state;
  if (closedTrades.length === 0) return 'Sin historial de operaciones.';
  const wins     = closedTrades.filter(t => t.result === 'WIN').length;
  const winRate  = (wins / closedTrades.length * 100).toFixed(0);
  const totalPnl = closedTrades.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2);
  const recent   = closedTrades.slice(0, 6).map(t =>
    `${t.par} ${t.tipo} ${t.result} PnL:$${(t.pnl||0).toFixed(0)}${t.notes ? ` [nota: ${t.notes}]` : ''}`
  ).join(' | ');
  return `WinRate: ${winRate}% (${wins}G/${closedTrades.length-wins}P) | P&L total: $${totalPnl}\nÚltimas ops: ${recent}`;
}

async function aiGenerateProposals() {
  const { profile, strategy } = state;
  const techCtx      = buildTechContext();
  const tradeHistory = buildTradeHistory();
  const feasibleCtx  = buildFeasibleCoinsContext();

  const raw = await callClaude(
    `Eres un analista técnico senior de criptomonedas. Genera 2-3 propuestas de trading de ALTA CALIDAD basadas en los datos técnicos REALES adjuntos.

━━━ PERFIL DEL TRADER ━━━
Estilo: ${profile.style} | Riesgo: ${profile.risk_tolerance}
Capital: $${profile.capital} | Riesgo/op: ${profile.risk_pct}% = $${(profile.capital*profile.risk_pct/100).toFixed(2)}
Apalancamiento: ${profile.leverage||1}x | Monedas preferidas: ${profile.preferred_coins.join(', ')||'BTC, ETH'}
Estrategia activa: ${strategy?.estrategiaAdaptada?.estiloRecomendado||'swing'} en ${strategy?.estrategiaAdaptada?.timeframe||'4H'}
Notas del trader: ${profile.notes||'ninguna'}

━━━ HISTORIAL ━━━
${tradeHistory}

━━━ CALENDARIO ECONÓMICO (próx. 48h) ━━━
${buildCalendarContext()}
${feasibleCtx}
━━━ DATOS TÉCNICOS REALES BINANCE ━━━
${techCtx}

━━━ REGLAS DE ANÁLISIS (SEGUIR ESTRICTAMENTE) ━━━
1. CAPITAL PRIMERO: Si existe la sección "RESTRICCIÓN DE CAPITAL", SOLO propón monedas de la lista EJECUTABLES. Es la regla más importante.
2. CONFLUENCIA MÍNIMA: Solo propón setups con ≥3 señales alineadas (RSI+EMA+MACD+BB+patrón+volumen)
3. TENDENCIA MACRO: Si la tendencia 1D es BAJISTA, solo SHORT o no operar. Si ALCISTA, preferir LONG.
4. EMA FILTER: No entrar LONG si precio < EMA200 en 4H. No entrar SHORT si precio > EMA200.
5. SL BASADO EN ATR: El SL DEBE ser al menos 1.5×ATR desde la entrada, y estar al otro lado del soporte/resistencia más cercano.
6. TP EN NIVELES REALES: TP1 = siguiente resistencia/soporte real. TP2 = siguiente nivel macro.
7. R:R MÍNIMO 2.0: Rechaza setups con R:R menor a 2. Con apalancamiento > 3x exige R:R ≥ 2.5.
8. VOLUMEN: Si el volumen es BAJO en el setup, reduce la confianza al menos 10 puntos.
9. NO REPETIR: Si tienes historial de conversación, no proponer el mismo par en la misma dirección.

Responde SOLO JSON sin markdown:
{
  "proposals": [{
    "par": "BTC/USDT",
    "tipo": "LONG",
    "setup": "RSI4H=28 sobrevendido + Engulfing Alcista + precio bajo BB inferior + sobre EMA200",
    "entrada": 70500,
    "stopLoss": 68900,
    "tp1": 73500,
    "tp2": 76000,
    "rr": "2.2",
    "confianza": 76,
    "confluence_score": 72,
    "signals_aligned": ["RSI sobrevendido","Engulfing alcista fuerte","Precio bajo BB inferior","Tendencia macro alcista","MACD hist positivo"],
    "signals_against": ["Volumen bajo media"],
    "atr_sl": 1600,
    "razon": "RSI4H=28 en zona crítica de sobrecompra, patrón Engulfing alcista fuerte confirmando reversión en soporte diario $68.9K. EMA200 a $67.1K como suelo macro. MACD hist virando positivo. TP1 en resistencia 4H $73.5K, TP2 en resistencia diaria $76K."
  }],
  "analisis_mercado": "Resumen técnico preciso del mercado con BTC como referencia.",
  "recomendacion_ia": "Consejo específico y personalizado para este trader basado en su historial y perfil."
}`,
    'Eres analista técnico senior de criptomonedas. Usas análisis multitimeframe, confluencia de indicadores y gestión del riesgo profesional. Responde SOLO con JSON válido sin markdown ni texto extra.',
    true
  );
  return parseJSON(raw);
}

async function aiScanMarket() {
  const { profile, strategy, alerts, activeTrades } = state;
  const techCtx      = buildTechContext();
  const tradeHistory = buildTradeHistory();
  const recentAlerts = alerts.slice(0, 5).map(a => `${a.par} ${a.tipo} entrada=${a.entrada} (${a.timestamp})`).join(' | ');
  const feasibleCtx  = buildFeasibleCoinsContext();

  const raw = await callClaude(
    `Eres un escáner de mercado automático. Analiza los datos técnicos AHORA y decide si existe una oportunidad de trading de ALTA CALIDAD.

━━━ DATOS TÉCNICOS REALES BINANCE ━━━
${techCtx}

━━━ CONTEXTO ━━━
Perfil: ${profile.style}, riesgo ${profile.risk_tolerance}, capital $${profile.capital}, leverage ${profile.leverage||1}x
Historial: ${tradeHistory}
Calendario económico: ${buildCalendarContext()}
Estrategia activa: ${strategy?.estrategiaAdaptada?.estiloRecomendado||'swing'} ${strategy?.estrategiaAdaptada?.timeframe||'4H'}
Alertas recientes (NO duplicar mismo par+dirección): ${recentAlerts||'ninguna'}
Posiciones abiertas: ${activeTrades.length}
${feasibleCtx}
━━━ CRITERIOS ESTRICTOS PARA hay_oportunidad=true ━━━
Todos deben cumplirse:
1. CAPITAL: La moneda debe estar en la lista EJECUTABLES (si existe esa sección). Es el criterio más importante.
2. CONFLUENCIA ≥60%: Al menos 3 señales alineadas entre RSI, EMA, MACD, BB, patrón de vela y volumen
3. TENDENCIA MACRO: El trade va en dirección de la tendencia 1D
4. R:R ≥ 2.0: Usando ATR y niveles reales de soporte/resistencia
5. Sin alerta reciente del mismo par y dirección en las últimas alertas
6. Volumen confirma (ratio ≥ 0.8× media)
7. EMA200 del lado correcto (LONG = precio > EMA200, SHORT = precio < EMA200)

Si no se cumplen TODOS: hay_oportunidad=false

Responde SOLO JSON:
{"hay_oportunidad":true,"urgencia":"ALTA","par":"ETH/USDT","tipo":"LONG","setup":"RSI28+Engulfing+BajoBB+TendAlcista","entrada":2015,"stopLoss":1940,"tp1":2150,"tp2":2280,"rr":"2.1","confianza":81,"confluence_score":73,"signals_aligned":["RSI4H=28","Engulfing alcista","Precio bajo BB","EMA200 soporte","MACD virando"],"razon":"RSI4H=28 sobrevendido. Engulfing alcista fuerte con volumen 1.4× media. Precio bajo BB inferior en soporte diario $1.94K. EMA200 a $1.89K como suelo macro. TP1 resistencia 4H $2.15K.","contexto_mercado":"Descripción concisa del estado del mercado global."}
Si NO hay oportunidad: {"hay_oportunidad":false,"razon":"motivo técnico concreto y específico"}`,
    'Eres escáner técnico de criptomonedas muy selectivo y preciso. Solo detectas oportunidades con confluencia alta y gestión del riesgo profesional. Responde SOLO con JSON válido sin markdown.'
  );
  return parseJSON(raw);
}

async function aiAdaptStrategy() {
  const { profile, closedTrades } = state;
  const techCtx = buildTechContext();
  const wins    = closedTrades.filter(t => t.result === 'WIN').length;

  const byPair = {};
  closedTrades.forEach(t => {
    if (!byPair[t.par]) byPair[t.par] = { wins:0, total:0, pnl:0, setups:[] };
    byPair[t.par].total++;
    byPair[t.par].pnl += t.pnl||0;
    if (t.result==='WIN') byPair[t.par].wins++;
    if (t.setup) byPair[t.par].setups.push(t.setup);
  });
  const pairStats = Object.entries(byPair)
    .map(([par,s]) => `${par}: ${s.wins}/${s.total} WR=${(s.wins/s.total*100).toFixed(0)}% P&L=$${s.pnl.toFixed(0)}`)
    .join(' | ');

  // Análisis de setups ganadores vs perdedores
  const winSetups  = closedTrades.filter(t=>t.result==='WIN').map(t=>t.setup).filter(Boolean);
  const lossSetups = closedTrades.filter(t=>t.result==='LOSS').map(t=>t.setup).filter(Boolean);

  const raw = await callClaude(
    `Analiza el historial real de este trader y genera una estrategia adaptada con reglas concretas.

━━━ HISTORIAL COMPLETO ━━━
WinRate: ${closedTrades.length>0?(wins/closedTrades.length*100).toFixed(0):0}% | ${wins}W/${closedTrades.length-wins}L | ${closedTrades.length} ops total
P&L total: $${closedTrades.reduce((a,t)=>a+(t.pnl||0),0).toFixed(2)}
Por par: ${pairStats||'sin datos suficientes'}
Setups ganadores frecuentes: ${winSetups.slice(0,5).join(', ')||'N/A'}
Setups perdedores frecuentes: ${lossSetups.slice(0,5).join(', ')||'N/A'}
Últimas 10 ops: ${closedTrades.slice(0,10).map(t=>`${t.par} ${t.tipo} ${t.result} PnL:$${(t.pnl||0).toFixed(0)}${t.notes?` [${t.notes}]`:''}`).join(' | ')}

━━━ PERFIL ━━━
Estilo: ${profile.style} | Riesgo: ${profile.risk_tolerance} | Capital: $${profile.capital} | Leverage: ${profile.leverage||1}x
Notas: ${profile.notes||'ninguna'}

━━━ CONTEXTO TÉCNICO ACTUAL ━━━
${techCtx}

Genera una estrategia adaptada con reglas MUY CONCRETAS y accionables. Las reglas deben ser checkboxes que el trader pueda verificar antes de entrar.

Responde SOLO JSON:
{"diagnostico":"Análisis honesto del rendimiento actual.","fortalezas":["Descripción concreta"],"debilidades":["Descripción concreta"],"alertas":["Riesgo específico detectado"],"cambios":[{"area":"Gestión de riesgo","descripcion":"Bajar riesgo a 1.5% por operación dado el drawdown reciente","impacto":"ALTO"}],"estrategiaAdaptada":{"estiloRecomendado":"Swing","timeframe":"4H","riesgoRecomendado":2,"activos":["BTC","ETH"],"resumen":"Descripción clara de la estrategia adaptada.","reglas":["Solo entrar si RSI < 35 en 4H","Confirmar con MACD histograma positivo","SL siempre 1.5×ATR","No más de 2 posiciones simultáneas"]}}`,
    'Eres coach de trading profesional. Das análisis honestos y consejos concretos y accionables basados en datos reales. Responde SOLO con JSON válido.'
  );
  return parseJSON(raw);
}
