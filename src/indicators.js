export function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out[i] = value = alpha * values[i] + (1 - alpha) * value;
  return out;
}

export function rsi(values, period = 2) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  const score = () => gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gain += Math.max(0, d) / period; loss += Math.max(0, -d) / period; }
  out[period] = score();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
    out[i] = score();
  }
  return out;
}

function wilder(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  let v = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = v;
  for (let i = period; i < values.length; i++) out[i] = v = (v * (period - 1) + values[i]) / period;
  return out;
}

export function atr(candles, period = 14) {
  return wilder(candles.map((c, i) => Math.max(c.high - c.low,
    i ? Math.abs(c.high - candles[i - 1].close) : 0,
    i ? Math.abs(c.low - candles[i - 1].close) : 0)), period);
}

// Session VWAP: HLC3 * base-asset volume, reset at 00:00 UTC, never at local midnight.
// An incomplete first session stays unavailable until a complete UTC session starts.
export function vwap(candles) {
  let day = -1, pv = 0, volume = 0, complete = false;
  return candles.map(c => {
    const nextDay = Math.floor(c.openTime / 86_400_000);
    if (nextDay !== day) { day = nextDay; pv = 0; volume = 0; complete = c.openTime % 86_400_000 === 0; }
    pv += ((c.high + c.low + c.close) / 3) * c.volume; volume += c.volume;
    return complete && volume > 0 ? pv / volume : null;
  });
}

export function adx(candles, period = 14) {
  const plus = [], minus = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high, down = candles[i - 1].low - candles[i].low;
    plus.push(up > down && up > 0 ? up : 0); minus.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  const p = wilder(plus, period), m = wilder(minus, period), t = wilder(tr, period), dx = [];
  for (let i = period - 1; i < tr.length; i++) {
    const sum = p[i] + m[i]; dx.push(t[i] === 0 || sum === 0 ? 0 : 100 * Math.abs(p[i] - m[i]) / sum);
  }
  const smooth = wilder(dx, period), out = Array(candles.length).fill(null);
  smooth.forEach((v, i) => { out[i + period] = v; });
  return out;
}

export function features(candles) {
  const closes = candles.map(c => c.close), e21 = ema(closes, 21), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const rs = rsi(closes), at = atr(candles), vw = vwap(candles), ax = adx(candles);
  return candles.map((c, i) => {
    const before = candles.slice(Math.max(0, i - 20), i), avg = before.length === 20 ? before.reduce((s, x) => s + x.volume, 0) / 20 : 0;
    return { ...c, ema21: e21[i], ema50: e50[i], ema200: e200[i], rsi: rs[i], atr: at[i], vwap: vw[i], adx: ax[i], rvol: avg > 0 ? c.volume / avg : null };
  });
}
