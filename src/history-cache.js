import fs from 'node:fs';
import path from 'node:path';
import { INTERVALS } from './config.js';
import { validateCandle } from './market.js';

function check(candles, tf) {
  if (!Array.isArray(candles)) return false;
  try {
    candles.forEach((c, i) => { validateCandle(c, tf); if (!c.closed || i && c.openTime !== candles[i - 1].endTime) throw new Error('gap'); });
    return true;
  } catch { return false; }
}
export async function cachedHistory(market, cfg, symbol, tf, startTime, endTime) {
  const ms = INTERVALS[tf], start = Math.floor(startTime / ms) * ms, end = Math.floor(endTime / ms) * ms;
  const dir = path.join(cfg.dataDir, 'history'), file = path.join(dir, `${cfg.exchange}-${symbol}-${tf}.json`);
  let old = [];
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (data.exchange === cfg.exchange && data.symbol === symbol && data.tf === tf && check(data.candles, tf)) old = data.candles.filter(c => c.openTime >= start && c.endTime <= end); } catch {}
  let result;
  if (!old.length) result = await market.candleRange(symbol, tf, start, end);
  else {
    const prefix = old[0].openTime > start ? await market.candleRange(symbol, tf, start, old[0].openTime) : [];
    // Refresh the final two candles and fetch only newly completed data.
    const refreshFrom = Math.max(start, old.at(-1).endTime - 2 * ms);
    const suffix = await market.candleRange(symbol, tf, refreshFrom, end);
    result = [...prefix, ...old.filter(c => c.openTime < refreshFrom), ...suffix];
  }
  if (!check(result, tf) || result[0]?.openTime !== start || result.at(-1)?.endTime !== end) throw new Error(`${symbol} ${tf}: bộ nhớ lịch sử thiếu dữ liệu; không tạo thống kê.`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ exchange: cfg.exchange, symbol, tf, candles: result }), { mode: 0o600 }); fs.renameSync(tmp, file);
  return result;
}
