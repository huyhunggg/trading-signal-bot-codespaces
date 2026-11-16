import { refreshStatus } from './status-poller.js';

const $ = id => document.getElementById(id);
let last;
const fmt = (v, digits = 2) => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const date = t => new Date(t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const labelled = (label, value, className = 'num') => { const n = el('div'); n.append(el('small', label), el('div', value, className)); return n; };
function render(s) {
  last = s;
  renderTrading(s.trading);
  const paper = s.trading?.mode?.startsWith('PAPER_'), showcase = s.trading?.mode === 'PAPER_DEMO';
  document.querySelector('.validation-panel').hidden = !!paper;
  document.querySelector('.history').hidden = !!paper;
  document.querySelector('.metrics').hidden = showcase;
  if (paper) {
    document.querySelector('.intro h1').textContent = 'Bot tự mua/bán bằng tiền ảo.';
    document.querySelector('.intro p').textContent = showcase ? 'Demo chạy ngay. Không cần tài khoản sàn hoặc API key.' : 'Tài khoản ảo, giá thị trường thật. Không cần API key.';
  }
  const live = s.status.phase === 'STREAMING', demo = s.demo;
  $('connection').textContent = demo ? 'CHẾ ĐỘ MÔ PHỎNG' : s.status.phase === 'STREAMING' && s.status.transport === 'REST_POLL' ? 'Đang cập nhật giá qua REST' : ({ STREAMING: 'Đang nhận dữ liệu WebSocket', SELECTING: 'Đang chọn nguồn giá', CONNECTING: 'Đang kết nối', SYNCING: 'Đang đồng bộ lịch sử', RETRYING: 'Mất kết nối · đang thử lại', PAUSED: 'Đang chờ nguồn giá mở lại', BLOCKED: 'API từ chối truy cập · cần kiểm tra' }[s.status.phase] || s.status.phase);
  $('dot').className = 'dot ' + (demo ? 'demo' : live ? 'online' : '');
  $('clock').textContent = date(s.serverNow) + ' UTC+7';
  $('source').textContent = `${s.exchange.toUpperCase()} · USDT perpetual · HTF ${s.htf}${s.status.transport === 'REST_POLL' ? ` · chu kỳ ${Math.round((s.status.pollIntervalMs || 5000) / 1000)}s` : ''}`;
  $('telegram').textContent = demo ? 'Telegram tắt trong chế độ mô phỏng' : !s.telegram.configured ? 'Telegram: chưa cấu hình' : s.telegram.lastError ? 'Telegram: lỗi gửi tin, đang thử lại' : s.telegram.lastSuccessAt ? `Telegram: gửi gần nhất ${date(s.telegram.lastSuccessAt)}` : 'Telegram: đã cấu hình · chờ tín hiệu đầu tiên';
  const notice = $('notice'); notice.hidden = !demo && live && !s.status.message;
  notice.className = 'notice' + (demo ? ' demo' : '');
  notice.textContent = demo ? 'DỮ LIỆU TỔNG HỢP — Các giá và cảnh báo dưới đây chỉ minh họa phần mềm, không phải tín hiệu thị trường thật.' : (s.status.error || s.status.message || 'Chưa sẵn sàng phát tín hiệu. Bot đang kết nối và đồng bộ dữ liệu.') + (s.status.retryAt ? ' Thử lại sau ' + date(s.status.retryAt) + '.' : '');
  $('source-health').textContent = (s.sources || []).filter(p => p.state).map(p => `${p.exchange.toUpperCase()}: ${p.state === 'AVAILABLE' ? (p.exchange === s.exchange ? 'đang dùng' : 'khả dụng') : `tạm dừng${p.httpStatus ? ' (HTTP ' + p.httpStatus + ')' : ''} đến ${date(p.retryAt)}`}`).join(' · ');
  $('coverage').textContent = `${s.symbols.length} cặp / ${s.timeframes.length} khung`;
  $('htf').textContent = `${s.timeframes.join(' + ')} · xác nhận ${s.htf} đã đóng`;
  $('closedCount').textContent = s.signals.filter(x => x.validation?.eligible === true).length;
  $('impulseCount').textContent = (s.candidates || []).length;
  const validation = s.validation;
  $('validation-target').textContent = `${fmt(100 * (validation?.target ?? 0.8), 0)}%`;
  $('validation-detail').textContent = validation
    ? `${validation.reason} Tối thiểu ${validation.minSamples} lệnh/nhóm. ${validation.eligibleGroupCount || 0}/${validation.groupCount || 0} nhóm đạt.${validation.dataThrough ? ' Dữ liệu đến ' + date(validation.dataThrough) + '.' : ''}`
    : 'Chưa có dữ liệu kiểm chứng. Khởi động lại bot sau khi cập nhật để bật bộ lọc lịch sử.';
  if (s.calibrationJob?.phase === 'RUNNING') $('validation-detail').textContent += ' Đang tự kiểm chứng lịch sử; bảng giá vẫn tiếp tục cập nhật.' + (s.calibrationJob.progress ? ' ' + s.calibrationJob.progress : '');
  if (s.calibrationJob?.phase === 'FAILED') $('validation-detail').textContent += ' ' + s.calibrationJob.error;
  if (s.calibrationJob?.phase === 'DELAYED') $('validation-detail').textContent += ' Sàn yêu cầu đợi đến ' + date(s.calibrationJob.retryAt) + ' trước khi tải lịch sử tiếp.';
  const seconds = Math.ceil((300_000 - s.serverNow % 300_000) / 1000);
  $('countdown').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  if ($('symbol').options.length === 1) s.symbols.forEach(symbol => { const o = el('option', symbol); o.value = symbol; $('symbol').append(o); });
  const cards = [];
  for (const symbol of s.symbols) for (const tf of s.timeframes) {
    const r = s.rows.find(x => x.symbol === symbol && x.timeframe === tf);
    const stale = !demo && (!live || !r || s.serverNow - r.updatedAt > s.streamStaleMs);
    const card = el('article', undefined, 'market'), top = el('div', undefined, 'market-top'), title = el('h3', symbol.replace('USDT', ''));
    title.append(el('small', `USDT · ${tf}`));
    top.append(title, el('span', stale ? 'DỮ LIỆU CHƯA SẴN SÀNG' : r?.htf ? `${s.htf} ${r.htf}` : 'ĐỢI HTF', `pill ${!stale && r?.htf === 'LONG' ? 'long' : !stale && r?.htf === 'SHORT' ? 'short' : 'neutral'}`));
    card.append(top, el('div', fmt(r?.price, 4), 'price'), el('div', r ? demo ? 'Giá mô phỏng' : stale ? 'Giá cuối đã nhận · không dùng làm giá live' : r.priceKind === 'CLOSED_CANDLE' ? 'Giá đóng nến mới nhất · đang chờ cập nhật giá' : `Cập nhật ${Math.max(0, Math.floor((s.serverNow - r.updatedAt) / 1000))} giây trước` : 'Chưa có dữ liệu', 'fresh'));
    const stats = el('div', undefined, 'stats');
    for (const [label, value] of [['RSI(2)', fmt(r?.rsi)], ['ATR(14)', fmt(r?.atr, 4)], ['RVOL(20)', r?.rvol ? `${fmt(r.rvol)}×` : '—']]) { const n = el('div'); n.append(el('span', label), el('strong', value)); stats.append(n); }
    card.append(stats);
    const side = r?.htf === 'SHORT' ? 'SHORT' : 'LONG', check = r?.closedChecks?.find(x => x.side === side);
    card.append(el('div', `Điều kiện ${side} · nến đóng${stale ? ' · dữ liệu cũ' : ''}`, 'checkslabel'));
    const checks = el('div', undefined, 'conditions');
    for (const [key, label] of [['trend','Xu hướng'],['htf','HTF'],['discount','Vùng giá'],['hook','RSI Hook'],['candle','Nến'],['antiStretch','Thân/ATR']]) {
      const pass = !stale && check?.checks[key]; checks.append(el('span', `${pass ? '●' : '○'} ${label}`, `condition${pass ? ' pass' : ''}`));
    }
    if (s.pinbarEnabled) checks.append(el('span', `${!stale && check?.checks.pinbar ? '●' : '○'} Pin-bar (thay Hook + vùng đóng)`, `condition${!stale && check?.checks.pinbar ? ' pass' : ''}`));
    card.append(checks); if (r?.waiting) card.append(el('p', r.waiting, 'fresh')); cards.push(card);
  }
  $('markets').replaceChildren(...cards); renderSignals();
}
function renderTrading(t) {
  $('trading-panel').hidden = !t;
  if (!t) return;
  const paper = t.mode === 'PAPER_DEMO' || t.mode === 'PAPER_LIVE';
  $('paper-controls').hidden = !paper;
  if (paper) { renderPaper(t); return; }
  const names = { STARTING: 'Đang kiểm tra', NEED_KEYS: 'Chưa nhập API Demo', READY: 'Đang chờ tín hiệu để vào lệnh',
    POSITION_OPEN: 'Đang quản lý / chờ vị thế', ORDER_SENT: 'Đã gửi lệnh', PAUSED: 'Tạm dừng mở lệnh', HALTED: 'Đã dừng vì cần kiểm tra', ERROR: 'Lỗi kết nối / cấu hình' };
  $('trading-status').textContent = names[t.status] || t.status;
  $('trading-reason').textContent = t.reason;
  $('trading-limits').textContent = `Isolated 1x · tối đa 1 vị thế · hạn mức ${fmt(t.maxNotional)} USDT/lệnh · rủi ro SL dự kiến ≤${fmt(t.risk)} USDT · dừng mở lệnh khi vốn giảm ${fmt(t.dailyLoss)} USDT/ngày UTC. Giá khớp có thể trượt.`;
  $('trading-account').replaceChildren(labelled('Vốn USDT Demo', fmt(t.equity)), labelled('Lãi/lỗ chưa chốt', fmt(t.unrealizedPnl)), labelled('Thay đổi vốn hôm nay (UTC)', fmt(t.dayChange)), labelled('Đồng bộ tài khoản', t.lastSync ? date(t.lastSync) : 'Chưa kết nối'));
  $('trading-positions').replaceChildren(...(t.positions.length ? t.positions.map(p => el('p', `${p.instId} · ${Number(p.size) > 0 ? 'LONG' : 'SHORT'} · ${p.size} hợp đồng · vào ${fmt(Number(p.entry), 6)} · PnL ${fmt(Number(p.upl))} USDT`)) : [el('p', t.lastSync ? 'Không có vị thế mở.' : 'Chưa đọc được tài khoản.') ]));
  $('trading-orders').replaceChildren(...(t.entries.length ? t.entries.map(o => el('p', `${date(o.createdAt)} · ${o.instId} · ${o.body.side.toUpperCase()} ${o.body.sz} hợp đồng · ${o.status}${o.fillPrice ? ' · khớp ' + o.fillPrice : ''} · SL ${o.body.attachAlgoOrds[0].slTriggerPx} / TP ${o.body.attachAlgoOrds[0].tpTriggerPx}`)) : [el('p', 'Chưa gửi lệnh. Bot chỉ vào khi xuất hiện tín hiệu mới; không ép mở lệnh.') ]));
  $('trading-history').replaceChildren(...(t.fills.length ? t.fills.map(p => el('p', `${date(p.closedAt)} · ${p.instId} · PnL đã thực hiện ${fmt(Number(p.pnl))} USDT (gồm giao dịch khác nếu có)`)) : [el('p', 'Chưa có lịch sử vị thế đóng.') ]));
}
function renderPaper(t) {
  const offline = t.mode === 'PAPER_DEMO';
  $('trading-title').textContent = offline ? 'DEMO TỰ TRADING · Không cần API key' : `PAPER TRADING ${t.exchange?.toUpperCase() || ''} · Tiền ảo theo giá thật`;
  $('trading-status').textContent = t.paused ? 'Đã tạm dừng mở lệnh' : t.positions.length ? 'Đang tự theo dõi vị thế ảo' : 'Đang chờ mở lệnh ảo';
  $('trading-reason').textContent = t.reason;
  if (!offline && (t.quoteError || ['BLOCKED', 'RETRYING', 'SELECTING', 'SYNCING'].includes(t.marketPhase))) {
    $('trading-status').textContent = 'Đang chờ dữ liệu thị trường';
    $('trading-reason').textContent = t.quoteError?.message || t.marketError || 'Đang kết nối và tải lịch sử. Chỉ giao dịch ảo khi nhận được giá thật, còn mới.';
  } else if (t.pendingSignal) $('trading-reason').textContent = `${t.pendingSignal.side} ${t.pendingSignal.symbol}: chờ bid/ask mới để khớp lệnh ảo.`;
  $('trading-limits').textContent = 'Vốn khởi đầu 10.000 USDT ảo · tối đa 1 vị thế · tối đa 1.000 USDT/vị thế · phí 0,06% và trượt giá 0,02% mỗi chiều.';
  $('trading-policy').textContent = offline
    ? 'KỊCH BẢN MINH HỌA: giá tổng hợp chạy mỗi giây, bot luân phiên LONG/SHORT để bạn thấy mở lệnh → lãi/lỗ → TP/SL. Không phải dữ liệu thị trường hay kết quả kiểm chứng chiến lược.'
    : 'Lệnh chỉ tồn tại trong sổ tiền ảo. Tín hiệu RSI Hook / Pin-bar kết hợp EMA, VWAP và xác nhận H1; chờ bid/ask mới sau tín hiệu để khớp ảo. LONG mua ask/bán bid, SHORT bán bid/mua ask; chốt toàn bộ tại TP1 hoặc SL. Chưa mô phỏng funding/độ sâu sổ lệnh và chưa kiểm chứng lợi nhuận.';
  $('trading-account').replaceChildren(labelled('Tổng vốn ảo (gồm vị thế mở)', fmt(t.equity)), labelled('Lãi/lỗ chưa chốt', fmt(t.unrealizedPnl)), labelled('Lãi/lỗ đã chốt sau phí', fmt(t.realizedPnl)), labelled('Lệnh đóng · thắng / thua', `${t.trades.length} · ${t.wins} / ${t.losses}`));
  $('trading-positions').replaceChildren(...(t.positions.length ? t.positions.map(p => el('p', `${p.side} ${p.symbol} · ${fmt(p.quantity, 6)} coin · vào ${fmt(p.entry, 4)} · hiện tại ${fmt(p.mark, 4)} · SL ${fmt(p.sl, 4)} / TP ${fmt(p.tp, 4)} · PnL ${fmt(t.unrealizedPnl)} USDT ảo`, p.side.toLowerCase())) : [el('p', t.paused ? 'Đã dừng mở lệnh ảo.' : offline ? 'Chuẩn bị mở giao dịch ảo tiếp theo…' : 'Chờ tín hiệu đóng nến mới. Không cần tài khoản hoặc API key.') ]));
  $('trading-orders-title').textContent = 'Lệnh ảo bot đã tự mở';
  $('trading-orders').replaceChildren(...(t.entries.length ? t.entries.slice(0, 10).map(p => el('p', `${date(p.openedAt)} · ${p.side} ${p.symbol} · ${fmt(p.quantity, 6)} coin · giá vào ${fmt(p.entry, 4)} · phí vào ${fmt(p.entryFee, 4)} USDT ảo`)) : [el('p', 'Chưa có lệnh ảo.') ]));
  $('trading-history').replaceChildren(...(t.trades.length ? t.trades.slice(0, 15).map(p => el('p', `${date(p.closedAt)} · ${p.side} ${p.symbol} · ${p.reason} · vào ${fmt(p.entry, 4)} → đóng ${fmt(p.exit, 4)} · sau phí ${p.pnl >= 0 ? '+' : ''}${fmt(p.pnl)} USDT ảo`, p.pnl >= 0 ? 'long' : 'short')) : [el('p', offline ? 'Giao dịch đầu sẽ tự đóng khi chạm TP/SL hoặc sau tối đa 20 giây.' : 'Chưa có giao dịch ảo đóng.') ]));
  $('trading-help').textContent = offline ? 'Không kết nối tài khoản sàn. Bấm Tạm dừng hoặc Bắt đầu lại ở trên để thử. Khởi động lại chương trình sẽ bắt đầu một phiên minh họa mới.' : `Không cần API key. Giá bid/ask mới nhất: ${t.quoteUpdatedAt ? date(t.quoteUpdatedAt) : 'chưa nhận được'}. Sổ ảo lưu riêng theo sàn trong paper-data. Tạm dừng chỉ ngăn mở thêm; Bắt đầu lại xóa giao dịch và vị thế ảo của phiên này.`;
}
for (const action of ['pause', 'resume', 'reset']) $('paper-' + action).addEventListener('click', async () => {
  try {
    const response = await fetch('/api/paper/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('action failed');
    render(await response.json()); $('paper-action-result').textContent = 'Đã cập nhật.';
  } catch { $('paper-action-result').textContent = 'Chưa thực hiện được. Kiểm tra kết nối bot.'; }
});
function renderSignals() {
  if (!last) return;
  const records = [...last.signals.map(s => ({ ...s, watch: false })), ...(last.candidates || []).map(s => ({ ...s, watch: true }))];
  const signals = records.filter(x => (!$('symbol').value || x.symbol === $('symbol').value) && (!$('layer').value || x.layer === $('layer').value) &&
    (!$('eligibility').value || ($('eligibility').value === 'passed' ? x.validation?.eligible === true : x.validation?.eligible !== true))).sort((a, b) => b.observedAt - a.observedAt);
  const nodes = signals.map(s => {
    const n = el('article', undefined, 'signal'), first = el('div'), title = el('strong', `${s.side} · ${s.symbol} · ${s.timeframe}`, s.side.toLowerCase());
    first.append(title, el('div', `${s.exchange.toUpperCase()} · ${s.layer === 'CLOSED' ? 'ĐÃ ĐÓNG NẾN' : 'NẾN ĐANG CHẠY'} · ${s.branch}`, s.layer === 'CLOSED' ? 'meta' : 'meta early'));
    const v = s.validation;
    first.append(el('div', last.demo ? 'MÔ PHỎNG' : v?.eligible ? 'ĐÃ QUA BỘ LỌC LỊCH SỬ' : s.watch ? 'QUAN SÁT · CHƯA GỬI' : 'LƯU TRỮ · CHƯA KIỂM CHỨNG', `meta ${v?.eligible ? 'long' : 'early'}`));
    const detail = v?.winRate !== null && v?.winRate !== undefined
      ? `Thắng lịch sử ${fmt(v.winRate * 100, 1)}% (${v.wins}/${v.samples}); khoảng 95% ${fmt(v.lower95 * 100, 1)}–${fmt(v.upper95 * 100, 1)}%. TB ${fmt(v.meanNetR, 3)}R. ${v.reason}`
      : `Tỷ lệ thắng: chưa đủ dữ liệu. ${v?.reason || 'Tín hiệu lưu từ bản chưa có kiểm chứng.'}`;
    first.append(el('div', detail, 'validation-result'));
    n.append(first, labelled('GIÁ THAM KHẢO', fmt(s.referencePrice, 6)), labelled('SL THAM KHẢO', fmt(s.sl, 6)), labelled('TP1 / TP2 THAM KHẢO', `${fmt(s.tp1, 6)}${s.tp2 !== null ? ' / ' + fmt(s.tp2, 6) : ''}`));
    const time = el('time', date(s.observedAt)); time.dateTime = new Date(s.observedAt).toISOString(); n.append(time); return n;
  });
  if (!nodes.length) nodes.push(el('p', last.demo ? 'Không có cảnh báo mô phỏng khớp bộ lọc.' : last.status.phase === 'STREAMING' ? 'Chưa có cảnh báo khớp bộ lọc. Bot đang tiếp tục theo dõi.' : 'Chưa có cảnh báo. Kiểm tra kết nối dữ liệu ở phía trên.', 'empty'));
  $('signals').replaceChildren(...nodes);
}
$('symbol').addEventListener('change', renderSignals); $('layer').addEventListener('change', renderSignals);
$('eligibility').addEventListener('change', renderSignals);
async function poll() {
  try {
    await refreshStatus({ render,
      onConnectionError: error => showDashboardProblem('CONNECTION', error),
      onRenderError: error => { console.error('Dashboard rendering failed', error); showDashboardProblem('RENDER', error); },
    });
  } finally { setTimeout(poll, 1000); }
}
function showDashboardProblem(kind, error) {
  const connected = kind === 'RENDER', notice = $('notice');
  $('connection').textContent = connected ? 'Lỗi hiển thị dashboard' : 'Dashboard chưa kết nối được máy chạy bot';
  $('dot').className = 'dot'; notice.hidden = false; notice.className = 'notice';
  notice.textContent = connected
    ? 'Máy chạy bot vẫn trả dữ liệu, nhưng giao diện gặp lỗi hiển thị. Tải lại trang. Lỗi này không xác nhận bot đã dừng giao dịch.'
    : `Không nhận được trạng thái máy chạy bot${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ''}. Kiểm tra Codespaces và Terminal đang chạy npm run paper:binance. Dữ liệu dưới đây chưa được cập nhật; chưa thể xác nhận bot còn chạy hay đã dừng.`;
  if (last?.trading) {
    $('trading-status').textContent = 'Trạng thái chưa cập nhật';
    $('trading-reason').textContent = 'Thông tin vị thế và tín hiệu đang hiển thị là dữ liệu đã nhận trước đó. Cần kết nối lại để xác nhận trạng thái hiện tại.';
  }
}
poll();

