import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, INTERVALS } from '../src/config.js';
import { Market } from '../src/market.js';
import { buildReport } from '../src/backtest.js';
import { wilson } from '../src/validation.js';

const args = process.argv.slice(2);
const cfg = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
try {
  if (args.length && (args.length !== 2 || args[0] !== '--input')) throw new Error('Cách dùng: npm run calibrate [-- --input data/market-history.json]');
  let dataset;
  if (args[0] === '--input') {
    dataset = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (dataset.source?.kind !== 'exchange-ohlcv') throw new Error('Chỉ dùng dữ liệu OHLCV có nguồn sàn; không dùng dữ liệu demo để xác nhận tỷ lệ thắng.');
  } else {
    const market = new Market(cfg), serverTime = await market.serverTime();
    const endTime = Math.floor(serverTime / Math.max(...cfg.timeframes.map(tf => INTERVALS[tf]))) * Math.max(...cfg.timeframes.map(tf => INTERVALS[tf]));
    const startTime = endTime - cfg.validation.days * 86_400_000;
    const warmupStart = startTime - (cfg.historyBars + 1) * INTERVALS[cfg.htf];
    dataset = { schemaVersion: 1, exchange: cfg.exchange, startTime, endTime,
      source: { kind: 'exchange-ohlcv', downloadedAt: serverTime }, series: {} };
    for (const symbol of cfg.symbols) for (const tf of [...new Set([...cfg.timeframes, cfg.htf])]) {
      console.log(`Đang tải ${symbol} ${tf}: ${cfg.validation.days} ngày và lịch sử khởi tạo...`);
      dataset.series[`${symbol}:${tf}`] = await market.candleRange(symbol, tf, warmupStart, endTime);
      console.log(`Đã nhận ${dataset.series[`${symbol}:${tf}`].length} nến đóng.`);
    }
  }
  const trades = [];
  const report = buildReport(cfg, dataset, p => console.log(`Kiểm chứng ${p.symbol} ${p.timeframe}: ${p.candidates} cơ hội, ${p.groups} nhóm.`), trade => trades.push(trade));
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const audit = trades.map(t => JSON.stringify(t)).join('\n') + (trades.length ? '\n' : '');
  const auditHash = createHash('sha256').update(audit).digest('hex');
  report.audit = { file: `validation-trades-${auditHash.slice(0, 16)}.jsonl`, sha256: auditHash, count: trades.length };
  fs.writeFileSync(path.join(cfg.dataDir, report.audit.file), audit, { mode: 0o600 });
  // Write only after ALL series pass. Failure leaves the prior report intact.
  const file = path.join(cfg.dataDir, 'calibration.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(report, null, 2), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  fs.rmSync(path.join(cfg.dataDir, 'calibration-retry-after.json'), { force: true });
  const passes = report.groups.filter(g => g.samples >= cfg.validation.minSamples && wilson(g.wins, g.samples)?.lower >= cfg.validation.target && g.sumNetR > 0);
  console.log(`Đã lưu ${file}. ${passes.length}/${report.groups.length} nhóm đạt cận dưới ≥${cfg.validation.target * 100}% và lãi/lỗ trung bình dương.`);
  console.log('Nếu 0 nhóm đạt, bot chỉ hiển thị cơ hội trong mục quan sát. Chưa có xác suất thắng riêng cho từng lệnh. Xung lực trong nến chưa được kiểm chứng.');
} catch (e) {
  if (Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0) {
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(cfg.dataDir, 'calibration-retry-after.json'), JSON.stringify({ retryAt: Date.now() + e.retryAfterMs }), { mode: 0o600 });
    } catch {}
  }
  console.error(`Chưa tạo được báo cáo kiểm chứng: ${e.message}`);
  console.error('Không gán tỷ lệ 80% và không thay báo cáo cũ bằng dữ liệu thiếu hoặc mô phỏng.');
  process.exitCode = 1;
}
