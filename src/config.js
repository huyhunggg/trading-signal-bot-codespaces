export const INTERVALS = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
export const RULES = Object.freeze({
  rsiLong: 15, rsiShort: 85, maxBodyAtr: 0.85, wickFraction: 0.45,
  barsGap: 4, stopAtr: 1.8, tp1Atr: 0.8, tp2Atr: 1.8,
  impulseAtr: 1.25, impulseStopAtr: 1.5, impulseTpAtr: 0.8,
});

export function loadConfig(env = process.env) {
  const list = (key, fallback) => (env[key] || fallback).split(',').map(s => s.trim()).filter(Boolean);
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key}: expected integer ${min}..${max}`);
    return value;
  };
  const cfg = {
    exchange: env.EXCHANGE || 'binance',
    symbols: [...new Set(list('SYMBOLS', 'BTCUSDT,ETHUSDT,SOLUSDT'))],
    timeframes: [...new Set(list('TIMEFRAMES', '5m,15m'))], htf: env.HTF || '1h',
    pinbarEnabled: (env.PINBAR_ENABLED || 'true') === 'true',
    historyBars: number('HISTORY_BARS', 650, 600, 1000),
    maxSignalAgeMs: number('SIGNAL_MAX_AGE_SECONDS', 120, 5, 300) * 1000,
    streamStaleMs: number('STREAM_STALE_SECONDS', 90, 10, 300) * 1000,
    dataDir: env.DATA_DIR || './data', host: env.HOST || '127.0.0.1',
    port: number('PORT', 8787, 1, 65535),
    telegramToken: env.TELEGRAM_BOT_TOKEN || '', telegramChatId: env.TELEGRAM_CHAT_ID || '',
    rules: RULES,
  };
  if (!['binance', 'bybit'].includes(cfg.exchange)) throw new Error('EXCHANGE must be binance or bybit');
  if (!cfg.symbols.length || cfg.symbols.length > 20 || cfg.symbols.some(s => !/^[A-Z0-9]{2,20}USDT$/.test(s))) throw new Error('SYMBOLS: 1..20 USDT perpetual symbols required');
  if (!['1h', '4h'].includes(cfg.htf) || !cfg.timeframes.length || cfg.timeframes.some(tf => !['5m', '15m'].includes(tf))) throw new Error('TIMEFRAMES: 5m,15m; HTF: 1h or 4h');
  if (env.PINBAR_ENABLED && !['true', 'false'].includes(env.PINBAR_ENABLED)) throw new Error('PINBAR_ENABLED must be true or false');
  if (Boolean(cfg.telegramToken) !== Boolean(cfg.telegramChatId)) throw new Error('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or leave both empty');
  return cfg;
}
