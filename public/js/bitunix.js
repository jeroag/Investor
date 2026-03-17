/* ═══════════════════════════════════════════════════
   CRYPTOPLAN IA — bitunix.js
   ═══════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════════════
   BITUNIX INTEGRATION
   ══════════════════════════════════════════════════════════ */

// Estado Bitunix
const bitunix = {
  configured: false,   // si las API keys están en el servidor
  account:    null,    // datos de cuenta reales
  positions:  [],      // posiciones abiertas reales
  lastSync:   0,
};

/* Comprueba si Bitunix está configurado */
async function checkBitunixStatus() {
  try {
    const res  = await authFetch('/api/bitunix/status');
    const data = await res.json();
    bitunix.configured = !!data.configured;
  } catch { bitunix.configured = false; }
  return bitunix.configured;
}

/* Fetch saldo real de Bitunix */
async function fetchBitunixAccount() {
  if (!bitunix.configured) return null;
  try {
    const res  = await authFetch('/api/bitunix/account');
    const data = await res.json();
    if (data.ok && data.account) {
      bitunix.account  = data.account;
      bitunix.lastSync = Date.now();

      // Leer equity real (incluye PnL no realizado = valor real de la cuenta)
      const equity = parseFloat(
        data.account.equity          ??
        data.account.totalEquity     ??
        data.account.walletBalance   ??
        data.account.totalBalance    ??
        data.account.balance         ?? 0
      );
      // Fallback: saldo disponible si no hay equity
      const available = parseFloat(
        data.account.available        ??
        data.account.availableBalance ??
        data.account.availAmt         ??
        data.account.freeBalance      ??
        data.account.free             ?? 0
      );
      const unrealized = parseFloat(data.account.unrealizedPnl ?? data.account.unrealPnl ?? 0);
      const margin     = parseFloat(data.account.usedMargin ?? data.account.positionMargin ?? 0);

      // Guardar snapshot en state.bitunixBalance para la UI
      state.bitunixBalance = {
        equity:     equity.toFixed(2),
        balance:    (equity - unrealized).toFixed(2),
        unrealized: unrealized,
        usedMargin: margin.toFixed(2),
      };

      // Preferir equity sobre available para cálculos de riesgo más precisos
      const realCapital = equity > 0 ? equity : available;
      if (realCapital > 0) {
        const prev = state.profile.capital;
        state.profile.capital = parseFloat(realCapital.toFixed(2));
        saveKey('profile', state.profile);
        // Notificar si el capital cambió significativamente (>1%)
        if (prev > 0 && Math.abs(realCapital - prev) / prev > 0.01) {
          const diff = realCapital - prev;
          showToast(`💼 Capital actualizado: $${realCapital.toFixed(2)} (${diff >= 0 ? '+' : ''}$${diff.toFixed(2)})`, false);
        }
      }
    } else {
      console.warn('[Bitunix account] respuesta sin datos:', data);
      bitunix.accountError = data.error || 'Sin datos';
    }
    return bitunix.account;
  } catch (e) {
    console.warn('fetchBitunixAccount:', e.message);
    bitunix.accountError = e.message;
    return null;
  }
}

/* Fetch posiciones abiertas de Bitunix y las sincroniza con activeTrades */
async function syncBitunixPositions() {
  if (!bitunix.configured) return;
  try {
    const res  = await authFetch('/api/bitunix/positions');
    const data = await res.json();
    if (!data.ok) return;

    bitunix.positions = data.positions || [];

    // Marcar trades locales que tienen una posición real en Bitunix
    // y actualizar la entrada con el precio real de ejecución del exchange
    bitunix.positions.forEach(pos => {
      const symbol = pos.symbol?.replace('USDT', ''); // "BTCUSDT" → "BTC"
      const side   = pos.side === 'BUY' ? 'LONG' : 'SHORT';
      const match  = state.activeTrades.find(t =>
        coinOf(t.par) === symbol && t.tipo === side
      );
      if (match) {
        match.bitunixPos     = true;
        match.bitunixSymbol  = pos.symbol;
        match.unrealizedPnl  = parseFloat(pos.unrealizedPnl || 0);
        match.bitunixQty     = parseFloat(pos.qty || 0);
        match.bitunixSide    = pos.side;

        // ── Precio real de ejecución en Bitunix ────────────────────
        // Bitunix devuelve el precio medio de apertura en openPrice / avgOpenPrice
        const realEntry = parseFloat(
          pos.openPrice || pos.avgOpenPrice || pos.avgPrice || pos.entryPrice || 0
        );
        if (realEntry > 0 && !match.entradaBitunix) {
          // Primera sincronización: guardar el precio real y actualizar entrada
          match.entradaBitunix   = realEntry;  // precio real del exchange
          match.entradaApp       = match.entrada; // precio original de la app (para referencia)
          match.entrada          = realEntry;   // usar precio real para cálculos de P&L
          saveKey('activeTrades', state.activeTrades);
          console.log(`[Bitunix sync] ${symbol} entrada actualizada: app=${match.entradaApp} → real=${realEntry}`);
        }
      }
    });

    renderAll();
  } catch (e) {
    console.warn('syncBitunixPositions:', e.message);
  }
}

/* Calcular qty en unidades base para Bitunix dado el riskUSD y precio */
function calcBitunixQty(riskUSD, entry, stopLoss, leverage, symbol) {
  // Fórmula correcta para futuros:
  // qty = riskUSD / slDist
  // El leverage NO va en el denominador — solo afecta el margen requerido.
  // Si el precio cae hasta SL, la pérdida = qty * slDist = riskUSD exacto.
  const dist = Math.abs(entry - stopLoss);
  if (dist === 0) return 0;
  const qty = riskUSD / dist;
  // Redondear según el par (mínimos de Bitunix)
  const coin = symbol?.replace('USDT','') || '';
  const decimals = coin === 'BTC' ? 3
    : coin === 'ETH' ? 2
    : coin === 'SOL' ? 1
    : coin === 'XRP' || coin === 'ADA' || coin === 'MATIC' || coin === 'ATOM' ? 0
    : coin === 'DOGE' ? -1   // múltiplo de 10
    : 2;
  const rounded = decimals >= 0
    ? parseFloat(qty.toFixed(decimals))
    : Math.floor(qty / 10) * 10;
  return rounded;
}

/* Ejecutar orden en Bitunix */
async function placeBitunixOrder(trade) {
  const symbol   = coinOf(trade.par) + 'USDT';
  const side     = trade.tipo === 'LONG' ? 'BUY' : 'SELL';
  const leverage = trade.leverage || 1;
  const qty      = calcBitunixQty(trade.riskUSD, trade.entrada, trade.stopLoss, leverage, symbol);

  if (qty <= 0) {
    showToast('⚠️ Qty calculada es 0 — revisa SL y capital', true);
    return null;
  }

  // TP1 = cierre real en Bitunix (orden automática en el exchange)
  // TP2 = objetivo visual en la app — cuando se alcance TP1 ya estarás fuera
  const tpPrice = trade.tp1 || null;

  const marginEstimado = (qty * trade.entrada / leverage).toFixed(2);
  showToast(`📡 Enviando orden ${symbol} ${side} · qty=${qty} · margen ~$${marginEstimado} · TP=${tpPrice} SL=${trade.stopLoss}...`);

  try {
    const res  = await authFetch('/api/bitunix/place-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol,
        qty:           qty,
        side,
        leverage,
        orderType:     'MARKET',
        tpPrice:       tpPrice,
        slPrice:       trade.stopLoss || null,
        clientOrderId: trade.id,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      trade.bitunixOrderId = data.orderId;
      trade.bitunixSymbol  = symbol;
      trade.bitunixQty     = qty;
      showToast(`✅ Orden ejecutada — TP1 ${fmtP(tpPrice, coinOf(trade.par))} · SL ${fmtP(trade.stopLoss, coinOf(trade.par))} · ID ${data.orderId}`);
      saveKey('activeTrades', state.activeTrades);
      setTimeout(syncBitunixPositions, 3000);
    } else {
      showToast(`❌ Error Bitunix: ${data.error}`, true);
    }
    return data;
  } catch (e) {
    showToast(`❌ Error enviando a Bitunix: ${e.message}`, true);
    return null;
  }
}

/* Flash close en Bitunix */
async function flashCloseBitunix(trade) {
  const symbol = trade.bitunixSymbol || (coinOf(trade.par) + 'USDT');
  const side   = trade.tipo === 'LONG' ? 'LONG' : 'SHORT';
  try {
    const res  = await authFetch('/api/bitunix/close-position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, side }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`✅ Posición cerrada en Bitunix`);
    } else {
      showToast(`⚠️ Error cerrando en Bitunix: ${data.error}`, true);
    }
    return data;
  } catch (e) {
    showToast(`⚠️ No se pudo cerrar en Bitunix: ${e.message}`, true);
    return null;
  }
}

/* Actualiza el SL de una posición abierta en Bitunix (para breakeven) */
async function updateBitunixSL(trade) {
  try {
    const res  = await authFetch('/api/bitunix/update-sl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol:   trade.bitunixSymbol || (coinOf(trade.par) + 'USDT'),
        side:     trade.tipo === 'LONG' ? 'LONG' : 'SHORT',
        slPrice:  trade.stopLoss,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[Breakeven] SL actualizado en Bitunix → ${trade.stopLoss}`);
    } else {
      console.warn('[Breakeven] Error actualizando SL en Bitunix:', data.error);
    }
    return data;
  } catch (e) {
    console.warn('[Breakeven] updateBitunixSL error:', e.message);
    return null;
  }
}
