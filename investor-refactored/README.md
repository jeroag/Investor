# CryptoPlan IA v2.0

App de trading de crypto con análisis IA, escáner de mercado 24/7, integración Bitunix y notificaciones Telegram.

## 🆕 Novedades v2.0

| Área | Cambio |
|------|--------|
| **Base de datos** | SQLite (efímero en Railway) → **Supabase** (permanente) |
| **Sesiones** | Solo en memoria → **persistentes en Supabase** (sobreviven reinicios) |
| **Escáner** | Solo precios spot → **OHLCV real** (RSI, EMA, soporte/resistencia, volumen) |
| **Arquitectura** | 1 fichero `server.js` de 900 líneas → **módulos separados** en `src/` |
| **Seguridad** | Sin cabeceras → **helmet.js + CSP** |
| **Rate limiting** | 1 límite global → **por ruta** (Claude API separado) |
| **Tests** | Sin tests → **6 suites** para PnL, TP/SL, RSI, EMA, S/R, drawdown |
| **Telegram** | Solo envío → **bidireccional** (comandos /estado, /precios, /trades…) |
| **Equity Curve** | Barras simples → **gráfica interactiva Chart.js** con KPIs |
| **TradingView** | No existía → **webhook** recibe alertas LONG/SHORT/CLOSE |

---

## 🚀 Inicio rápido

### 1. Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com)
2. Ve a **SQL Editor** y ejecuta el contenido de `supabase-schema.sql`
3. Copia la **Project URL** y la **service_role key** de Settings → API

### 2. Variables de entorno en Railway

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
APP_PASSWORD=tu_password
ANTHROPIC_API_KEY=sk-ant-...
APP_URL=https://tu-app.railway.app
```

Ver `.env.example` para la lista completa.

### 3. Deploy

```bash
# Railway detecta automáticamente Node.js con railway.toml
git push
```

---

## 📁 Estructura del proyecto

```
├── server.js              ← Punto de entrada (bootstrap + wiring)
├── src/
│   ├── config.js          ← Variables de entorno + validación
│   ├── state.js           ← Estado compartido en memoria
│   ├── websocket.js       ← Servidor WebSocket
│   ├── db/
│   │   └── supabase.js    ← Todos los helpers de BD
│   ├── middleware/
│   │   ├── auth.js        ← Sesiones (memoria + Supabase)
│   │   ├── rateLimit.js   ← Rate limiters por ruta
│   │   └── security.js    ← Helmet + CSP
│   ├── services/
│   │   ├── binance.js     ← WS + OHLCV REST + calcRSI/EMA/S-R
│   │   ├── scanner.js     ← Escáner 24/7 con contexto OHLCV real
│   │   ├── tpsl.js        ← Checker TP/SL server-side
│   │   └── telegram.js    ← Envío + webhook bidireccional
│   └── routes/
│       ├── auth.js        ← POST /auth/login|logout, GET /auth/check
│       ├── trades.js      ← /api/trades/* + equity curve
│       ├── scanner.js     ← /api/scanner/*
│       ├── claude.js      ← POST /api/claude
│       ├── telegram.js    ← /api/telegram/*
│       ├── bitunix.js     ← /api/bitunix/*
│       └── tradingview.js ← POST /api/tradingview/webhook
├── public/                ← Frontend (igual que v1, + equity curve)
├── tests/
│   └── calculations.test.js ← 6 suites, 25+ casos
├── supabase-schema.sql    ← Ejecutar en Supabase una sola vez
├── .env.example           ← Plantilla de variables
└── railway.toml
```

---

## 🔌 TradingView Webhook

**URL:** `https://tu-app.railway.app/api/tradingview/webhook`

**JSON de la alerta en TradingView:**
```json
{
  "secret":   "TU_TRADINGVIEW_SECRET",
  "action":   "LONG",
  "symbol":   "BTCUSDT",
  "price":    {{close}},
  "interval": "{{interval}}",
  "message":  "{{strategy.order.comment}}"
}
```

Acciones soportadas: `LONG`, `SHORT`, `CLOSE`

---

## 📱 Telegram bidireccional

Tras configurar `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`:

**Activar el webhook** (una sola vez):
```
POST /api/telegram/setup
Body: { "appUrl": "https://tu-app.railway.app" }
```

**Comandos desde Telegram:**

| Comando | Respuesta |
|---------|-----------|
| `/estado` | Resumen de cuenta y P&L total |
| `/precios` | Precios actuales de todas las monedas |
| `/trades` | Lista de trades activos |
| `/historial` | Últimos 10 trades cerrados |
| `/ayuda` | Lista de comandos |

---

## 🧪 Tests

```bash
npm test
```

Suites:
- `calcPnL` — LONG/SHORT con y sin leverage
- `TP/SL detection` — lógica de hits con TP2, coinOf
- `calcRSI` — zonas sobreventa/sobrecompra, fallback
- `calcMaxDrawdown` — equity curve
- `calcEMA` — media móvil exponencial
- `calcSupportResistance` — soporte y resistencia desde OHLCV

---

## 📊 Equity Curve

En la pestaña **Historial** → botón **📈 Equity Curve**.

Muestra:
- Gráfica acumulada de P&L (Chart.js)
- KPIs: P&L total, Win Rate, Avg Win/Loss, Max Drawdown
- Mapa visual de trades (verde=WIN, rojo=LOSS)
