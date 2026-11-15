import { INTERVALS } from './config.js';

export function runDemo(engine, cfg) {
  const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const now = day + 12 * 3_600_000, basePrices = { BTCUSDT: 70_000, ETHUSDT: 2500, SOLUSDT: 150 };
  for (const symbol of cfg.symbols) {
    const base = basePrices[symbol] || 100, sign = symbol === 'ETHUSDT' ? -1 : 1;
    const htfMs = INTERVALS[cfg.htf], htfEnd = Math.floor(now / htfMs) * htfMs;
    const build = (tf, count, end, dip) => {
      const ms = INTERVALS[tf]; let previous;
      return Array.from({ length: count }, (_, i) => {
        let fraction = 0.92 + i * 0.00012;
        if (dip && i >= 644 && i <= 649) fraction = 0.92 + 643 * 0.00012 - (i - 643) * 0.0005;
        if (dip && i === 650) fraction = 0.92 + 643 * 0.00012 - 6 * 0.0005 + 0.0002;
        const close = base * (sign === 1 ? fraction : 2 - fraction), open = previous ?? close - sign * base * 0.0001;
        previous = close;
        return { openTime: end - (count - i) * ms, endTime: end - (count - i - 1) * ms, open, close,
          high: Math.max(open, close) + base * 0.0002, low: Math.min(open, close) - base * 0.0002, volume: 100 + i % 20, closed: true };
      });
    };
    engine.seed(symbol, cfg.htf, build(cfg.htf, 650, htfEnd, false));
    for (const tf of cfg.timeframes) {
      const ms = INTERVALS[tf], end = Math.floor(now / ms) * ms;
      const bars = build(tf, 651, end, true), final = bars.pop();
      engine.seed(symbol, tf, bars);
      engine.ingest({ symbol, timeframe: tf, candle: final, eventTime: now });
      const atr = engine.calculated(symbol, tf).at(-1).atr;
      const open = final.close, close = open + sign * 15 * atr;
      engine.ingest({ symbol, timeframe: tf, eventTime: now + 1000, candle: {
        openTime: end, endTime: end + ms, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 150, closed: false,
      } });
    }
  }
  return now;
}
