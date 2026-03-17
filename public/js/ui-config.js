/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — ui-config.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ── Render: Strategy ────────────────────────────────────────────────────── */
function renderStrategy() {
  const root = qs('#sec-strat');
  if (!root) return;
  const { strategy } = state;
  const canAdapt = state.closedTrades.length >= 3;

  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <div class="stl" style="margin-bottom:0">◈ Estrategia Adaptada por IA</div>
      ${canAdapt ? `<button class="btn btny" style="font-size:11px;padding:7px 14px" onclick="onAdaptStrategy()">🧠 Adaptar estrategia</button>` : ''}
    </div>
    <div class="al al-b" style="margin-bottom:13px">🧠 La IA analiza tu historial real. Necesitas al menos 3 operaciones cerradas.</div>`;

  if (!strategy) {
    html += `<div class="empty"><div class="ei">🧠</div><div class="et">Cierra al menos 3 operaciones<br>y presiona <b style="color:var(--yellow)">Adaptar estrategia</b> arriba.</div></div>`;
  } else {
    const ea = strategy.estrategiaAdaptada || {};
    html += `
      <div class="strat-block"><div class="strat-tag">DIAGNÓSTICO</div><div style="font-size:12px;line-height:1.7">${strategy.diagnostico}</div></div>
      <div class="grid-2" style="margin-bottom:13px">
        <div class="card">
          <div class="stl" style="color:var(--green)">✓ Fortalezas</div>
          ${(strategy.fortalezas||[]).map(f=>`<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px;color:#c8f0d8"><span style="color:var(--green)">◈</span>${f}</div>`).join('')}
        </div>
        <div class="card">
          <div class="stl" style="color:var(--red)">⚠ Debilidades</div>
          ${(strategy.debilidades||[]).map(d=>`<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px;color:#f0c8c8"><span style="color:var(--red)">◈</span>${d}</div>`).join('')}
        </div>
      </div>
      ${strategy.alertas?.length ? `<div class="al al-y" style="margin-bottom:13px">⚡ ${strategy.alertas.join(' · ')}</div>` : ''}
      <div class="card" style="margin-bottom:13px">
        <div class="stl">Cambios Recomendados</div>
        ${(strategy.cambios||[]).map(c=>`
          <div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)">
            <span class="tag ${c.impacto==='ALTO'?'tr':c.impacto==='MEDIO'?'ty':'tb'}" style="flex-shrink:0">${c.impacto}</span>
            <div><div style="font-size:11px;color:var(--accent);margin-bottom:2px">${c.area}</div><div style="font-size:11px;color:var(--muted);line-height:1.5">${c.descripcion}</div></div>
          </div>`).join('')}
      </div>
      <div class="strat-block" style="border-color:var(--green)">
        <div class="strat-tag" style="color:var(--green)">ESTRATEGIA ADAPTADA</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:14px">
          <div class="cs"><div class="csl">Estilo</div><div class="csv" style="color:var(--accent)">${ea.estiloRecomendado||'—'}</div></div>
          <div class="cs"><div class="csl">Timeframe</div><div class="csv" style="color:var(--accent)">${ea.timeframe||'—'}</div></div>
          <div class="cs"><div class="csl">Riesgo/Op</div><div class="csv" style="color:var(--yellow)">${ea.riesgoRecomendado||'—'}%</div></div>
          <div class="cs"><div class="csl">Activos</div><div class="csv" style="color:var(--green);font-size:11px">${(ea.activos||[]).join(', ')}</div></div>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.6">${ea.resumen||''}</div>
        <div class="stl">Reglas</div>
        ${(ea.reglas||[]).map((r,i)=>`<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:11px"><span style="color:var(--green);font-weight:bold;min-width:22px">${String(i+1).padStart(2,'0')}</span><span>${r}</span></div>`).join('')}
      </div>`;
  }
  root.innerHTML = html;
}

/* ── Render: Profile ─────────────────────────────────────────────────────── */
function renderProfile() {
  const root = qs('#sec-profile');
  if (!root) return;
  const p = state.profile;

  const styleChips  = ['swing','scalp','position','dca'];
  const riskChips   = ['conservador','moderado','agresivo'];
  const coinChips   = ['BTC','ETH','SOL','XRP','BNB','DOGE'];

  root.innerHTML = `
    <div class="stl">◈ Mi Perfil</div>
    <div class="card">
      <div class="lbl">Estilo</div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:13px">
        ${styleChips.map(s=>`<span class="chip${p.style===s?' on':''}" onclick="setProfileField('style','${s}')">${s.charAt(0).toUpperCase()+s.slice(1)}</span>`).join('')}
      </div>
      <div class="lbl">Tolerancia al riesgo</div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:13px">
        ${riskChips.map(r=>`<span class="chip${p.risk_tolerance===r?' on':''}" onclick="setProfileField('risk_tolerance','${r}')">${r.charAt(0).toUpperCase()+r.slice(1)}</span>`).join('')}
      </div>
      <div class="lbl">Activos preferidos</div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:13px">
        ${coinChips.map(c=>`<span class="chip${p.preferred_coins.includes(c)?' on':''}" onclick="toggleCoin('${c}')">${c}</span>`).join('')}
      </div>
      <div class="lbl">Notas para la IA</div>
      <textarea id="profile-notes" class="inp" placeholder="Ej: Solo opero tendencias alcistas..." style="height:64px;resize:none;margin-bottom:12px">${p.notes}</textarea>
      <button class="btn btng" onclick="saveProfile()">✓ Guardar perfil</button>
    </div>

    <!-- TELEGRAM -->
    <div class="stl" style="margin-top:18px">◈ Notificaciones Telegram</div>
    <div class="card" id="telegram-config-panel">
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.6">
        Recibe alertas instantáneas en Telegram cuando la IA detecta una oportunidad, cuando un trade llega al TP/SL, o cuando se activa el breakeven — aunque tengas el navegador cerrado.
      </div>
      <div id="telegram-status-msg" style="font-size:11px;color:var(--muted)">Comprobando...</div>
    </div>`;

  // Comprobar estado de Telegram
  authFetch('/api/telegram/status').then(r => r.json()).then(data => {
    const el = qs('#telegram-status-msg');
    if (!el) return;
    if (data.configured) {
      el.innerHTML = `<span style="color:var(--green)">✓ Telegram configurado y activo</span>`;
    } else {
      el.innerHTML = `<span style="color:var(--yellow)">⚠️ Sin configurar — añade las variables en Railway</span>`;
    }
  }).catch(() => {});
}

function setProfileField(key, value) {
  state.profile[key] = value;
  saveKey('profile', state.profile);
  renderProfile();
}

function toggleCoin(coin) {
  const idx = state.profile.preferred_coins.indexOf(coin);
  if (idx > -1) state.profile.preferred_coins.splice(idx, 1);
  else state.profile.preferred_coins.push(coin);
  saveKey('profile', state.profile);
  renderProfile();
}

function saveProfile() {
  const notes = qs('#profile-notes');
  if (notes) state.profile.notes = notes.value;
  saveKey('profile', state.profile);
  syncProfileToServer();
  logActivity('config_save', 'Perfil actualizado');
  showToast('✓ Perfil guardado');
}

async function testTelegram() {
  const btn       = qs('#telegram-config-panel button');
  const statusEl  = qs('#telegram-status-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando...'; }
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--muted)">Conectando con Telegram...</span>';
  try {
    const res  = await authFetch('/api/telegram/test', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      const botStr = data.botName ? ` (@${data.botName})` : '';
      showToast(`✅ Telegram funcionando${botStr} — revisa tu chat`);
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--green)">✓ Telegram activo${botStr}</span>`;
    } else {
      const errMsg = data.error || 'Error desconocido';
      showToast('❌ Telegram: ' + errMsg, true);
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">✗ ${errMsg}</span>`;
    }
  } catch (e) {
    showToast('❌ Error de red: ' + e.message, true);
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">✗ Error de red</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📨 Enviar mensaje de prueba'; }
  }
}


/* ── Render: Capital ─────────────────────────────────────────────────────── */
function renderCapital() {
  const root = qs('#sec-capital');
  if (!root) return;
  const p = state.profile;
  const lev     = p.leverage || 1;
  const riskUSD = (p.capital * p.risk_pct / 100).toFixed(2);
  const cap3    = (p.capital * p.risk_pct / 100 * 3).toFixed(2);
  const capOps  = Math.floor(50 / p.risk_pct);
  const riskColor = p.risk_pct <= 1 ? 'var(--green)' : p.risk_pct <= 3 ? 'var(--yellow)' : 'var(--red)';
  const levColor  = lev === 1 ? 'var(--green)' : lev <= 5 ? 'var(--yellow)' : 'var(--red)';
  const barW    = Math.min(p.risk_pct / 10 * 100, 100);
  const levOptions = [1, 2, 3, 5, 10, 20, 25, 50, 75];

  root.innerHTML = `
    <div class="stl">◈ Capital y Gestión de Riesgo</div>
    <div class="card">
      <div class="grid-2" style="margin-bottom:16px">
        <div>
          <label class="lbl">Capital total (USD)</label>
          <input class="inp" type="number" id="cap-input" value="${p.capital}" oninput="updateCapCalc()">
        </div>
        <div>
          <label class="lbl">Riesgo por operación (%)</label>
          <input class="inp" type="number" id="risk-input" value="${p.risk_pct}" min="0.1" max="10" step="0.1" oninput="updateCapCalc()">
        </div>
      </div>

      <!-- Circuit Breaker -->
      <div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:14px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:14px">🛑</span>
          <div style="font-size:12px;font-weight:600;color:var(--text)">Circuit Breaker — Límite de pérdida diaria</div>
          ${state.circuitBreakerTripped ? '<span style="font-size:10px;font-weight:700;color:#fff;background:var(--red);padding:2px 8px;border-radius:20px">ACTIVO</span>' : ''}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px;line-height:1.5">
          Si tu P&L del día cae por debajo de este valor, la app bloqueará nuevas operaciones automáticamente. Pon <b>0</b> para desactivar.
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <div style="flex:1">
            <label class="lbl">Pérdida máxima diaria (USD)</label>
            <input class="inp" type="number" id="daily-loss-input" value="${p.daily_loss_limit || 0}" min="0" step="1" placeholder="0 = desactivado">
          </div>
          <div style="flex:1">
            <div class="csl">P&L hoy</div>
            <div class="csv" style="color:${(() => { const now=Date.now(); const todayPnl=state.closedTrades.filter(t=>(now-new Date(t.closedAt||0).getTime())<86400000).reduce((a,t)=>a+(t.pnl||0),0); return todayPnl>=0?'var(--green)':'var(--red)'; })()}">${(() => { const now=Date.now(); const todayPnl=state.closedTrades.filter(t=>(now-new Date(t.closedAt||0).getTime())<86400000).reduce((a,t)=>a+(t.pnl||0),0); return (todayPnl>=0?'+':'')+fmtUSD(todayPnl); })()}</div>
          </div>
        </div>
      </div>

      <div class="lbl" style="margin-bottom:8px">Apalancamiento por defecto</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
        ${levOptions.map(x => `
          <button id="lev-btn-${x}" class="btn" style="padding:6px 12px;font-size:11px;font-weight:bold;
            ${lev===x ? `background:rgba(251,191,36,.18);border-color:var(--yellow);color:var(--yellow)` : ''}"
            onclick="setLeverage(${x})">${x}x</button>
        `).join('')}
      </div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:14px;padding:8px;background:rgba(0,0,0,.2);border-radius:6px;line-height:1.6">
        ${lev === 1
          ? '✓ Sin apalancamiento. Riesgo máximo = capital en riesgo por operación.'
          : lev >= 50
          ? `<span style="color:var(--red)">⚠️ ${lev}x — LEVERAGE EXTREMO. Un movimiento del ${(100/lev).toFixed(1)}% en tu contra liquida el margen. Solo para setups con SL muy ajustado y alta convicción.</span>`
          : `⚡ ${lev}x — Las ganancias <b style="color:var(--green)">y pérdidas</b> se multiplican por ${lev}. Usa con precaución.`}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:14px">
        <div class="cs"><div class="csl">Riesgo/Op</div><div class="csv" id="cap-rv" style="color:${riskColor}">${p.risk_pct}%</div></div>
        <div class="cs"><div class="csl">En USD</div><div class="csv" id="cap-rusd">$${riskUSD}</div></div>
        <div class="cs"><div class="csl">Max 3 ops</div><div class="csv" id="cap-r3" style="color:var(--muted)">$${cap3}</div></div>
        <div class="cs"><div class="csl">Capacidad</div><div class="csv" id="cap-ops" style="color:var(--accent)">~${capOps} ops</div></div>
        <div class="cs"><div class="csl">Apalancamiento</div><div class="csv" style="color:${levColor}">${lev}x</div></div>
      </div>
      <div class="lbl">Nivel de riesgo</div>
      <div class="bar" style="margin-bottom:12px"><div class="bf" id="cap-bar" style="width:${barW}%;background:${riskColor}"></div></div>
      <button class="btn btng" onclick="saveCapital()">✓ Guardar</button>
    </div>

    <div class="card">
      <div class="stl">Monedas seguidas</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">
        Selecciona qué monedas aparecen en Mercado y se usan en el análisis IA. Mínimo 2, máximo 10.
      </div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:14px">
        ${ALL_COINS.map(c => {
          const active = state.watchedCoins.includes(c);
          return `<span class="chip${active ? ' on' : ''}" onclick="toggleWatchedCoin('${c}')">${c} <span style="font-size:9px;color:var(--muted)">${COIN_NAMES[c] || ''}</span></span>`;
        }).join('')}
      </div>
      <div style="font-size:10px;color:var(--muted)">
        Activas: <b style="color:var(--text)">${state.watchedCoins.join(', ')}</b>
      </div>

    <!-- Widget: Capital mínimo por moneda y leverage -->
    <div class="card" style="padding:0;overflow:hidden">
      <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
        <div class="stl" style="margin:0">📊 Capital mínimo por moneda y leverage</div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px">Capital necesario = qty_min × precio / leverage &nbsp;·&nbsp; 🟢 &lt;$5 &nbsp;·&nbsp; 🟡 $5–$30 &nbsp;·&nbsp; 🔴 &gt;$30</div>
      </div>
      <div style="overflow-x:auto">
        <table id="lev-table" style="width:100%;border-collapse:collapse;min-width:700px;font-size:11px">
        </table>
      </div>
    </div>

    <!-- Widget: Comisiones Bitunix -->
    <div class="card" style="padding:0;overflow:hidden;margin-top:0">
      <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
        <div class="stl" style="margin:0">💸 Comisiones Bitunix por operación</div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px">Maker 0.02% · Taker 0.06% · Comisión = tamaño_posición × fee · La posición = capital × leverage</div>
      </div>
      <div style="overflow-x:auto">
        <table id="fee-table" style="width:100%;border-collapse:collapse;min-width:700px;font-size:11px">
        </table>
      </div>
    </div>
    </div>`;
  renderLevTable();
  renderFeeTable();
}


function renderLevTable() {
  const tbl = qs('#lev-table');
  if (!tbl) return;
  const LEVERAGES = [1, 2, 3, 5, 10, 20, 25, 50, 75];
  const COINS = [
    { coin:'DOGE',  minQty:10,    price:0.097,    color:'#c29d43' },
    { coin:'ADA',   minQty:1,     price:0.273,    color:'#0d65bf' },
    { coin:'MATIC', minQty:1,     price:0.50,     color:'#8247e5' },
    { coin:'XRP',   minQty:1,     price:1.42,     color:'#347ab6' },
    { coin:'ATOM',  minQty:0.1,   price:1.84,     color:'#6f728e' },
    { coin:'UNI',   minQty:0.1,   price:4.00,     color:'#ff007a' },
    { coin:'DOT',   minQty:0.1,   price:4.00,     color:'#e6007a' },
    { coin:'LINK',  minQty:0.1,   price:9.20,     color:'#2a5ada' },
    { coin:'AVAX',  minQty:0.1,   price:9.83,     color:'#e84142' },
    { coin:'LTC',   minQty:0.01,  price:55.15,    color:'#a6a9aa' },
    { coin:'SOL',   minQty:0.1,   price:88.55,    color:'#9945ff' },
    { coin:'BNB',   minQty:0.01,  price:661.82,   color:'#f3ba2f' },
    { coin:'ETH',   minQty:0.01,  price:2095.00,  color:'#627eea' },
    { coin:'BTC',   minQty:0.001, price:71471.00, color:'#f7931a' },
  ].sort((a, b) => a.minQty * a.price - b.minQty * b.price);

  // Header
  let html = '<thead><tr style="background:var(--s2)">';
  html += '<th style="text-align:left;padding:8px 12px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap">Moneda · qty mín.</th>';
  LEVERAGES.forEach(l => {
    html += `<th style="padding:8px 6px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border);text-align:center">${l}x</th>`;
  });
  html += '</tr></thead><tbody>';

  COINS.forEach(({ coin, minQty, price, color }) => {
    html += `<tr style="border-bottom:1px solid var(--border)">`;
    html += `<td style="padding:7px 12px;white-space:nowrap">`;
    html += `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle"></span>`;
    html += `<b>${coin}</b><span style="color:var(--muted);font-size:10px"> ·${minQty}</span></td>`;
    LEVERAGES.forEach(lev => {
      const cap = (minQty * price) / lev;
      const bg  = cap < 5  ? 'rgba(34,197,94,.12)' : cap < 30 ? 'rgba(234,179,8,.12)' : 'rgba(239,68,68,.1)';
      const fg  = cap < 5  ? 'var(--green)'         : cap < 30 ? 'var(--yellow)'        : 'var(--red)';
      const val = cap < 1  ? cap.toFixed(3) : cap.toFixed(2);
      html += `<td style="padding:7px 6px;text-align:center;background:${bg};color:${fg};font-weight:600">$${val}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody>';
  tbl.innerHTML = html;
}

function renderFeeTable() {
  const tbl = qs('#fee-table');
  if (!tbl) return;

  const LEVERAGES  = [1, 2, 3, 5, 10, 20, 25, 50, 75];
  const MAKER_FEE  = 0.0002;  // 0.02%
  const TAKER_FEE  = 0.0006;  // 0.06%
  const capital    = state.profile?.capital || 1000;

  // Header
  let html = '<thead><tr style="background:var(--s2)">';
  html += '<th style="text-align:left;padding:8px 12px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap">Capital · Tipo</th>';
  LEVERAGES.forEach(l => {
    html += `<th style="padding:8px 6px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border);text-align:center">${l}x</th>`;
  });
  html += '</tr></thead><tbody>';

  // Rows: para el capital actual del usuario, maker y taker
  [
    { label: 'Maker (0.02%)', fee: MAKER_FEE, color: 'var(--green)' },
    { label: 'Taker (0.06%)', fee: TAKER_FEE, color: 'var(--yellow)' },
  ].forEach(({ label, fee, color }) => {
    html += `<tr style="border-bottom:1px solid var(--border)">`;
    html += `<td style="padding:7px 12px;white-space:nowrap;font-weight:600;color:${color}">${label}</td>`;
    LEVERAGES.forEach(lev => {
      const posSize   = capital * lev;
      const comision  = posSize * fee;
      // ida + vuelta (apertura + cierre)
      const roundTrip = comision * 2;
      html += `<td style="padding:7px 6px;text-align:center;color:var(--muted)">`;
      html += `<span style="font-size:10px;color:var(--subtle)">×1 </span>$${comision.toFixed(3)}`;
      html += `<br><span style="font-size:10px;color:var(--subtle)">×2 $${roundTrip.toFixed(3)}</span>`;
      html += `</td>`;
    });
    html += '</tr>';
  });

  // Fila extra: break-even mínimo (cuánto debe moverse el precio solo para cubrir comisiones taker)
  html += `<tr style="border-bottom:1px solid var(--border);background:var(--s2)">`;
  html += `<td style="padding:7px 12px;white-space:nowrap;font-weight:600;color:var(--muted);font-size:10px">Break-even mín.<br><span style="font-weight:400">% para cubrir fees (×2 taker)</span></td>`;
  LEVERAGES.forEach(lev => {
    const bePct = (TAKER_FEE * 2 * 100).toFixed(3);
    const bePctLev = (TAKER_FEE * 2 / lev * 100).toFixed(4);
    html += `<td style="padding:7px 6px;text-align:center;font-size:11px;color:var(--muted)">`;
    html += `<b style="color:var(--text)">${bePct}%</b>`;
    html += `<br><span style="font-size:10px;color:var(--subtle)">${bePctLev}% capital</span>`;
    html += `</td>`;
  });
  html += '</tr>';

  html += '</tbody>';
  tbl.innerHTML = html;
}


function updateCapCalc() {
  const cap  = parseFloat(qs('#cap-input')?.value)  || 1000;
  const risk = parseFloat(qs('#risk-input')?.value) || 2;
  const riskColor = risk <= 1 ? 'var(--green)' : risk <= 3 ? 'var(--yellow)' : 'var(--red)';
  const set = (id, val, color) => {
    const el = qs('#' + id);
    if (el) { el.textContent = val; if (color) el.style.color = color; }
  };
  set('cap-rv',   risk + '%',                                riskColor);
  set('cap-rusd', '$' + (cap * risk / 100).toFixed(2),       '');
  set('cap-r3',   '$' + (cap * risk / 100 * 3).toFixed(2),   '');
  set('cap-ops',  '~' + Math.floor(50 / risk) + ' ops',      '');
  const bar = qs('#cap-bar');
  if (bar) { bar.style.width = Math.min(risk/10*100,100) + '%'; bar.style.background = riskColor; }
}

function toggleWatchedCoin(coin) {
  const idx = state.watchedCoins.indexOf(coin);
  if (idx > -1) {
    if (state.watchedCoins.length <= 2) { showToast('Mínimo 2 monedas activas', true); return; }
    state.watchedCoins.splice(idx, 1);
  } else {
    if (state.watchedCoins.length >= 10) { showToast('Máximo 10 monedas activas', true); return; }
    state.watchedCoins.push(coin);
  }
  saveKey('watchedCoins', state.watchedCoins);
  initMarketMeta(state.watchedCoins);
  connectWS(); // reconectar WS con la nueva lista
  fetchMarketMeta();
  renderCapital();
  if (state.currentTab === 'mkt') renderMkt();
}

function setLeverage(lev) {
  state.profile.leverage = lev;
  saveKey('profile', state.profile);
  syncProfileToServer();
  renderCapital();
}

function saveCapital() {
  state.profile.capital          = parseFloat(qs('#cap-input')?.value)        || 1000;
  state.profile.risk_pct         = parseFloat(qs('#risk-input')?.value)        || 2;
  state.profile.daily_loss_limit = parseFloat(qs('#daily-loss-input')?.value)  || 0;
  // leverage ya se guarda en setLeverage al hacer clic
  saveKey('profile', state.profile);
  syncProfileToServer();
  // Re-evaluar el circuit breaker con el nuevo límite
  checkCircuitBreaker();
  logActivity('config_save', `Capital actualizado: $${state.profile.capital} · Límite diario: ${state.profile.daily_loss_limit > 0 ? '-$' + state.profile.daily_loss_limit : 'desactivado'}`);
  showToast('✓ Capital y límites guardados');
}

/* ── Render: Storage panel ───────────────────────────────────────────────── */
function renderStoragePanel() { /* eliminado — panel de datos internos quitado */ }

function resetAll() {
  if (!confirm('¿Borrar todos los datos guardados? Esta acción no se puede deshacer.')) return;
  Object.values(STORAGE_KEYS).forEach(k => storage.del(k));
  state.activeTrades  = [];
  state.closedTrades  = [];
  state.alerts        = [];
  state.strategy      = null;
  state.profile       = { ...DEFAULT_PROFILE };
  state.scanInterval  = 5;
  state.watchedCoins  = [...DEFAULT_WATCHED_COINS];
  state.pending       = [];
  state.priceAlerts   = [];
  state.scanLog       = [];
  state.aiHistory     = [];
  stopScanner();
  renderAll();
  showToast('Todos los datos han sido borrados.');
}



/* ── Navigation ──────────────────────────────────────────────────────────── */
