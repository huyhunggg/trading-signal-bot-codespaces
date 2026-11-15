const finite = (...values) => values.every(v => typeof v === 'number' && Number.isFinite(v));

export function htfTrend(c) {
  if (!c?.closed || !finite(c.close, c.ema21, c.ema50, c.ema200)) return null;
  if ([c.ema21, c.ema50, c.ema200].every(x => c.close > x)) return 'LONG';
  if ([c.ema21, c.ema50, c.ema200].every(x => c.close < x)) return 'SHORT';
  return 'NEUTRAL';
}

export function evaluateClosed(c, prev, htf, cfg) {
  if (!c?.closed || !prev?.closed || !finite(c.ema21, c.ema50, c.ema200, c.vwap, c.rsi, prev.rsi, c.atr) || c.atr <= 0) return [];
  const r = cfg.rules, range = c.high - c.low, body = Math.abs(c.close - c.open), trend = htfTrend(htf);
  return ['LONG', 'SHORT'].map(side => {
    const long = side === 'LONG', sign = long ? 1 : -1;
    const checks = {
      trend: long ? c.close > c.ema200 && c.ema50 > c.ema200 : c.close < c.ema200 && c.ema50 < c.ema200,
      htf: trend === side,
      discount: long ? c.close < c.ema21 && c.close <= c.vwap : c.close > c.ema21 && c.close >= c.vwap,
      hook: long ? prev.rsi < r.rsiLong && c.rsi > prev.rsi : prev.rsi > r.rsiShort && c.rsi < prev.rsi,
      candle: sign * (c.close - c.open) > 0,
      antiStretch: body <= r.maxBodyAtr * c.atr,
    };
    const wick = long ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close);
    const pinbar = cfg.pinbarEnabled && range > 0 && wick / range >= r.wickFraction && checks.candle &&
      (long ? c.low < c.ema21 && c.low <= c.vwap && c.close > c.ema21 : c.high > c.ema21 && c.high >= c.vwap && c.close < c.ema21);
    const common = checks.trend && checks.htf && checks.antiStretch;
    const hook = checks.discount && checks.hook && checks.candle;
    return { side, branch: hook ? 'RSI_HOOK' : pinbar ? 'PINBAR_RECLAIM' : null, passed: common && (hook || pinbar), checks: { ...checks, pinbar }, atr: c.atr };
  });
}

export function evaluateImpulse(live, baseline, currentVwap, htf, cfg) {
  if (live.closed || !baseline?.closed || !finite(baseline.atr, baseline.ema200, currentVwap) || baseline.atr <= 0) return null;
  const delta = live.close - live.open, side = delta > 0 ? 'LONG' : 'SHORT', long = side === 'LONG';
  if (Math.abs(delta) < cfg.rules.impulseAtr * baseline.atr || htfTrend(htf) !== side) return null;
  if (!(long ? live.close > baseline.ema200 && live.close > currentVwap : live.close < baseline.ema200 && live.close < currentVwap)) return null;
  return { side, branch: 'IMPULSE', atr: baseline.atr, bodyAtr: Math.abs(delta) / baseline.atr };
}

export function makeSignal({ result, candle, symbol, timeframe, cfg, observedAt, htfEndTime, layer }) {
  const sign = result.side === 'LONG' ? 1 : -1, r = cfg.rules, entry = candle.close;
  return {
    id: `${cfg.exchange}:${symbol}:${timeframe}:${candle.openTime}:${layer}:${result.side}`,
    exchange: cfg.exchange, market: 'USDT perpetual', symbol, timeframe, side: result.side, layer,
    branch: result.branch, referencePrice: entry, atr: result.atr,
    sl: entry - sign * (layer === 'CLOSED' ? r.stopAtr : r.impulseStopAtr) * result.atr,
    tp1: entry + sign * (layer === 'CLOSED' ? r.tp1Atr : r.impulseTpAtr) * result.atr,
    tp2: layer === 'CLOSED' ? entry + sign * r.tp2Atr * result.atr : null,
    candleOpenTime: candle.openTime, candleEndTime: candle.endTime, htfEndTime,
    observedAt, closed: layer === 'CLOSED', checks: result.checks || null,
    note: layer === 'CLOSED' ? 'Mốc tham khảo tại đóng nến; chưa đặt lệnh. TP1 50%, phần còn lại TP2; dời SL về entry sau TP1 là quy tắc dự kiến.' : 'Cảnh báo sớm khi nến đang chạy; có thể thay đổi, không phải xác nhận vào lệnh.',
  };
}
