'use strict';

/**
 * Valida variables de entorno requeridas al arrancar.
 * Variables obligatorias para Supabase:
 *   SUPABASE_URL          → URL del proyecto (ej: https://xxx.supabase.co)
 *   SUPABASE_SERVICE_KEY  → service_role key (NO la anon key)
 *
 * Variables opcionales con advertencia:
 *   APP_PASSWORD, ANTHROPIC_API_KEY, BITUNIX_API_KEY, BITUNIX_SECRET,
 *   DEBUG_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, APP_URL,
 *   TRADINGVIEW_SECRET
 */
function validateEnv() {
  const errors   = [];
  const warnings = [];

  // — Supabase (críticas) —
  if (!process.env.SUPABASE_URL)
    errors.push('SUPABASE_URL no configurada — la app no puede arrancar sin base de datos.');
  if (!process.env.SUPABASE_SERVICE_KEY)
    errors.push('SUPABASE_SERVICE_KEY no configurada — usa la service_role key de tu proyecto.');

  // — Opcionales con advertencia —
  if (!process.env.APP_PASSWORD)
    warnings.push('APP_PASSWORD no configurada — cualquiera puede acceder sin contraseña.');
  if (!process.env.ANTHROPIC_API_KEY)
    warnings.push('ANTHROPIC_API_KEY no configurada — el análisis IA no funcionará.');
  if (!process.env.BITUNIX_API_KEY || !process.env.BITUNIX_SECRET)
    warnings.push('BITUNIX_API_KEY / BITUNIX_SECRET no configuradas — trading real desactivado.');
  if (!process.env.DEBUG_TOKEN)
    warnings.push('DEBUG_TOKEN no configurada — endpoint /api/bitunix/debug solo accesible con sesión.');
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)
    warnings.push('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no configuradas — notificaciones desactivadas.');
  if (!process.env.TRADINGVIEW_SECRET)
    warnings.push('TRADINGVIEW_SECRET no configurada — webhook TradingView sin autenticación (inseguro).');

  if (errors.length) {
    console.error('\n❌  ERRORES CRÍTICOS DE CONFIGURACIÓN:');
    errors.forEach(e => console.error(`   • ${e}`));
    process.exit(1);
  }

  if (warnings.length) {
    console.warn('\n⚠️   ADVERTENCIAS DE CONFIGURACIÓN:');
    warnings.forEach(w => console.warn(`   • ${w}`));
    console.warn('');
  }
}

const config = {
  port:              process.env.PORT             || 3000,
  appPassword:       process.env.APP_PASSWORD,
  supabaseUrl:       process.env.SUPABASE_URL,
  supabaseKey:       process.env.SUPABASE_SERVICE_KEY,
  anthropicKey:      process.env.ANTHROPIC_API_KEY,
  bitunixApiKey:     process.env.BITUNIX_API_KEY,
  bitunixSecret:     process.env.BITUNIX_SECRET,
  debugToken:        process.env.DEBUG_TOKEN,
  telegramToken:     process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId:    process.env.TELEGRAM_CHAT_ID,
  appUrl:            process.env.APP_URL          || '',
  tradingviewSecret: process.env.TRADINGVIEW_SECRET,
  sessionTtlMs:      12 * 60 * 60 * 1000,  // 12 horas
};

module.exports = { validateEnv, config };
