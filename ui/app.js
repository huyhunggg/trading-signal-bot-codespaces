const $ = id => document.getElementById(id);
let last;
const fmt = (v, digits = 2) => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const date = t => new Date(t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const labelled = (label, value, className = 'num') => { const n = el('div'); n.append(el('small', label), el('div', value, className)); return n; };
function render(s) {
  last = s;
  const live = s.status.phase === 'STREAMING', demo = s.demo;
  $('connection').textContent = demo ? 'CHẾ ĐỘ MÔ PHỎNG' : ({ STREAMING: 'Đang nhận dữ liệu', CONNECTING: 'Đang kết nối', SYNCING: 'Đang đồng bộ lịch sử', RETRYING: 'Mất kết nối · đang thử lại', BLOCKED: 'API từ chối truy cập · cần kiểm tra' }[s.status.phase] || s.status.phase);
  $('dot').className = 'dot ' + (demo ? 'demo' : live ? 'online' : '');
  $('clock').textContent = date(s.serverNow) + ' UTC+7';
  $('source').textContent = `${s.exchange.toUpperCase()} · USDT perpetual · HTF ${s.htf}`;
  $('telegram').textContent = demo ? 'Telegram tắt trong chế độ mô phỏng' : !s.telegram.configured ? 'Telegram: chưa cấu hình' : s.telegram.lastError ? 'Telegram: lỗi gửi tin, đang thử lại' : s.telegram.lastSuccessAt ? `Telegram: gửi gần nhất ${date(s.telegram.lastSuccessAt)}` : 'Telegram: đã cấu hình · chờ tín hiệu đầu tiên';
  const notice = $('notice'); notice.hidden = !demo && live;
  notice.className = 'notice' + (demo ? ' demo' : '');
  notice.textContent = demo ? 'DỮ LIỆU TỔNG HỢP — Các giá và cảnh báo dưới đây chỉ minh họa phần mềm, không phải tín hiệu thị trường thật.' : s.status.error || 'Chưa sẵn sàng phát tín hiệu. Bot đang kết nối và đồng bộ dữ liệu.';
  $('coverage').textContent = `${s.symbols.length} cặp / ${s.timeframes.length} khung`;
  $('htf').textContent = `${s.timeframes.join(' + ')} · xác nhận ${s.htf} đã đóng`;
  $('closedCount').textContent = s.signals.filter(x => x.layer === 'CLOSED').length;
  $('impulseCount').textContent = s.signals.filter(x => x.layer === 'IMPULSE').length;
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
    card.append(top, el('div', fmt(r?.price, 4), 'price'), el('div', r ? demo ? 'Giá mô phỏng' : stale ? 'Giá cuối đã nhận · không dùng làm giá live' : `Cập nhật ${Math.max(0, Math.floor((s.serverNow - r.updatedAt) / 1000))} giây trước` : 'Chưa có dữ liệu', 'fresh'));
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
function renderSignals() {
  if (!last) return;
  const signals = last.signals.filter(x => (!$('symbol').value || x.symbol === $('symbol').value) && (!$('layer').value || x.layer === $('layer').value));
  const nodes = signals.map(s => {
    const n = el('article', undefined, 'signal'), first = el('div'), title = el('strong', `${s.side} · ${s.symbol} · ${s.timeframe}`, s.side.toLowerCase());
    first.append(title, el('div', `${s.layer === 'CLOSED' ? 'ĐÃ ĐÓNG NẾN' : 'NẾN ĐANG CHẠY'} · ${s.branch}`, s.layer === 'CLOSED' ? 'meta' : 'meta early'));
    n.append(first, labelled('GIÁ THAM KHẢO', fmt(s.referencePrice, 6)), labelled('SL THAM KHẢO', fmt(s.sl, 6)), labelled('TP1 / TP2 THAM KHẢO', `${fmt(s.tp1, 6)}${s.tp2 !== null ? ' / ' + fmt(s.tp2, 6) : ''}`));
    const time = el('time', date(s.observedAt)); time.dateTime = new Date(s.observedAt).toISOString(); n.append(time); return n;
  });
  if (!nodes.length) nodes.push(el('p', last.demo ? 'Không có cảnh báo mô phỏng khớp bộ lọc.' : last.status.phase === 'STREAMING' ? 'Chưa có cảnh báo khớp bộ lọc. Bot đang tiếp tục theo dõi.' : 'Chưa có cảnh báo. Kiểm tra kết nối dữ liệu ở phía trên.', 'empty'));
  $('signals').replaceChildren(...nodes);
}
$('symbol').addEventListener('change', renderSignals); $('layer').addEventListener('change', renderSignals);
async function poll() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('status unavailable');
    render(await response.json());
  } catch {
    $('connection').textContent = 'Không kết nối được bot'; $('dot').className = 'dot';
    if (last) render({ ...last, status: { ...last.status, phase: 'RETRYING', error: 'Mất kết nối với tiến trình bot. Dữ liệu bên dưới là dữ liệu đã nhận trước đó.' } });
    else { $('notice').hidden = false; $('notice').textContent = 'Không đọc được trạng thái bot. Kiểm tra tiến trình npm start trên máy.'; }
  } finally { setTimeout(poll, 1000); }
}
poll();
