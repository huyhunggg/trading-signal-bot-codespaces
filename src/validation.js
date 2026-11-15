import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function strategyHash(cfg) {
  return createHash('sha256').update(JSON.stringify({
    revision: 'closed-confluence-net-v1', rules: cfg.rules, htf: cfg.htf,
    pinbar: cfg.pinbarEnabled, historyBars: cfg.historyBars,
    policy: simulationPolicy(cfg),
  })).digest('hex');
}

export function simulationPolicy(cfg) {
  const { feeBps, slippageBps, fundingBpsPer8h, maxHoldBars } = cfg.validation;
  return { metric: 'NET_PROFIT', entry: 'NEXT_BAR_OPEN', tieBreak: 'STOP_FIRST',
    partialTp1: 0.5, breakEvenAfterTp1: true, feeBps, slippageBps, fundingBpsPer8h, maxHoldBars };
}

export const groupKey = s => [s.exchange, s.symbol, s.timeframe, s.side, s.branch, s.layer].join(':');

export function wilson(wins, samples) {
  if (!Number.isInteger(samples) || samples <= 0 || !Number.isInteger(wins) || wins < 0 || wins > samples) return null;
  const z = 1.959963984540054, p = wins / samples, denominator = 1 + z * z / samples;
  const center = p + z * z / (2 * samples), margin = z * Math.sqrt(p * (1 - p) / samples + z * z / (4 * samples * samples));
  return { rate: p, lower: Math.max(0, (center - margin) / denominator), upper: Math.min(1, (center + margin) / denominator) };
}

export const REASONS = {
  MISSING_PROFILE: 'Chưa có báo cáo kiểm chứng lịch sử. Chạy npm run calibrate.',
  INVALID_PROFILE: 'Báo cáo không hợp lệ; chưa dùng để đánh giá tín hiệu.',
  SYNTHETIC: 'Dữ liệu mô phỏng không được dùng để xác nhận tỷ lệ thắng.',
  INCOMPATIBLE: 'Báo cáo dùng cấu hình khác; cần kiểm chứng lại.',
  STALE: 'Báo cáo đã quá hạn; cần cập nhật dữ liệu lịch sử.',
  FUTURE_DATA: 'Báo cáo chứa dữ liệu sau thời điểm tín hiệu; không được dùng.',
  UNSUPPORTED_LAYER: 'Xung lực trong nến chưa được kiểm chứng bằng dữ liệu diễn biến trong nến.',
  INSUFFICIENT_SAMPLES: 'Chưa đủ số lệnh lịch sử của nhóm tương tự.',
  BELOW_THRESHOLD: 'Cận dưới thống kê chưa đạt ngưỡng tỷ lệ thắng đã đặt.',
  NEGATIVE_EXPECTANCY: 'Lãi/lỗ trung bình sau chi phí chưa dương.',
  PASSED: 'Đạt bộ lọc lịch sử; không bảo đảm kết quả lệnh tiếp theo.',
  DEMO: 'Dữ liệu mô phỏng; chưa có tỷ lệ thắng được kiểm chứng.',
};

function validReport(report) {
  return report?.schemaVersion === 1 && report.kind === 'historical-validation' &&
    Number.isFinite(report.generatedAt) && Number.isFinite(report.dataThrough) &&
    Number.isFinite(report.evaluation?.startTime) && report.evaluation.startTime < report.dataThrough &&
    report.evaluation.purgedHorizon === true && report.generatedAt >= report.dataThrough &&
    Array.isArray(report.groups) && new Set(report.groups.map(g => g.key)).size === report.groups.length &&
    report.groups.every(g => typeof g.key === 'string' && Number.isInteger(g.samples) && g.samples >= 0 &&
      Number.isInteger(g.wins) && g.wins >= 0 && g.wins <= g.samples &&
      [g.sumNetR, g.positiveNetR, g.negativeNetR].every(Number.isFinite) &&
      g.positiveNetR >= 0 && g.negativeNetR >= 0 && Math.abs(g.sumNetR - g.positiveNetR + g.negativeNetR) < 1e-6);
}

export class ValidationGate {
  constructor(cfg) { this.cfg = cfg; this.signature = strategyHash(cfg); this.file = path.join(cfg.dataDir, 'calibration.json'); this.report = null; this.loadError = null; this.lastRead = -Infinity; }
  reload(now = Date.now()) {
    if (now - this.lastRead < 5000) return;
    this.lastRead = now;
    try {
      const report = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!validReport(report)) throw new Error('invalid');
      this.report = report; this.loadError = null;
    } catch (e) { this.report = null; this.loadError = e.code === 'ENOENT' ? 'MISSING_PROFILE' : 'INVALID_PROFILE'; }
  }
  reportStatus(now) {
    this.reload(now);
    if (!this.report) return this.loadError || 'MISSING_PROFILE';
    if (this.report.source?.kind !== 'exchange-ohlcv') return 'SYNTHETIC';
    if (this.report.strategyHash !== this.signature || this.report.exchange !== this.cfg.exchange) return 'INCOMPATIBLE';
    if (this.report.generatedAt > now + 1000 || this.report.dataThrough > now) return 'FUTURE_DATA';
    if (now - this.report.dataThrough > this.cfg.validation.maxAgeMs) return 'STALE';
    return 'READY';
  }
  assess(signal, now = Date.now()) {
    const status = this.reportStatus(now), report = this.report;
    const base = { eligible: false, status, reason: REASONS[status] || '', target: this.cfg.validation.target,
      minSamples: this.cfg.validation.minSamples, samples: 0, wins: 0, winRate: null, lower95: null, upper95: null,
      meanNetR: null, strategyHash: this.signature, metric: 'NET_PROFIT', dataThrough: report?.dataThrough ?? null,
      evaluationStart: report?.evaluation?.startTime ?? null, groupKey: groupKey(signal), policy: simulationPolicy(this.cfg), sourceSha256: report?.source?.sha256 ?? null };
    const fail = code => ({ ...base, status: code, reason: REASONS[code] });
    if (status !== 'READY') return base;
    if (signal.layer !== 'CLOSED') return fail('UNSUPPORTED_LAYER');
    if (!Number.isFinite(signal.observedAt) || report.dataThrough > signal.observedAt) return fail('FUTURE_DATA');
    const group = report.groups.find(g => g.key === base.groupKey), n = group?.samples || 0;
    if (n) {
      const interval = wilson(group.wins, n);
      Object.assign(base, { samples: n, wins: group.wins, winRate: interval.rate, lower95: interval.lower,
        upper95: interval.upper, meanNetR: group.sumNetR / n });
    }
    if (n < this.cfg.validation.minSamples) return fail('INSUFFICIENT_SAMPLES');
    if (base.lower95 < this.cfg.validation.target) return fail('BELOW_THRESHOLD');
    if (base.meanNetR <= 0) return fail('NEGATIVE_EXPECTANCY');
    return { ...base, eligible: true, status: 'PASSED', reason: REASONS.PASSED };
  }
  summary(now = Date.now()) {
    const status = this.reportStatus(now);
    return { status, reason: status === 'READY' ? 'Đang lọc bằng kết quả lịch sử theo từng nhóm tín hiệu.' : REASONS[status],
      target: this.cfg.validation.target, minSamples: this.cfg.validation.minSamples, metric: 'NET_PROFIT',
      dataThrough: this.report?.dataThrough ?? null, groupCount: this.report?.groups.length || 0,
      eligibleGroupCount: status === 'READY' ? this.report.groups.filter(g => g.samples >= this.cfg.validation.minSamples && wilson(g.wins, g.samples)?.lower >= this.cfg.validation.target && g.sumNetR > 0).length : 0,
      policy: simulationPolicy(this.cfg), usesLower95: true };
  }
}

export function validationText(v) {
  if (!v || v.winRate === null || v.winRate === undefined) return `Tỷ lệ thắng lịch sử: chưa đủ dữ liệu. ${v?.reason || ''}`.trim();
  const percent = x => (100 * x).toFixed(1) + '%';
  return `Tỷ lệ thắng lịch sử nhóm tương tự: ${percent(v.winRate)} (${v.wins}/${v.samples} lệnh). Khoảng Wilson 95%: ${percent(v.lower95)}–${percent(v.upper95)}. Lãi/lỗ TB: ${v.meanNetR.toFixed(3)}R. ${v.reason}`;
}
