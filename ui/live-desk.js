const $ = id => document.getElementById(id);
const number = n => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
const date = t => new Date(t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
let latest, applySnapshot, bound = false, shown = false, dirty = false, saving = false, toggling = false, stale = false, formRevision = null;
let checking = false;

export function parseExitDraft(mode, tp, sl) {
  if (mode === 'strategy') return {};
  if (!['percent', 'price'].includes(mode)) throw new Error('Chọn cách đặt TP/CL.');
  const read = (v, label) => {
    const n = Number(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Nhập ${label} lớn hơn 0.`);
    return n;
  };
  const profit = read(tp, 'TP'), stop = read(sl, 'cắt lỗ');
  if (mode === 'percent') {
    if (profit < .05 || profit > 20 || stop < .05 || stop > 10) throw new Error('TP từ 0,05–20%; cắt lỗ từ 0,05–10%.');
    return { tpPercent: profit, slPercent: stop };
  }
  if (profit === stop) throw new Error('Giá TP và cắt lỗ phải khác nhau.');
  return { tpPrice: profit, slPrice: stop };
}
function loadForm(c) {
  $('live-asset-btc').checked = c.symbol === 'BTCUSDT'; $('live-asset-eth').checked = c.symbol === 'ETHUSDT';
  $('live-exit-mode').value = c.mode;
  $('live-tp').value = c.mode === 'price' ? c.tpPrice ?? '' : c.tpPercent ?? 1;
  $('live-sl').value = c.mode === 'price' ? c.slPrice ?? '' : c.slPercent ?? .5;
  formRevision = c.revision; dirty = false;
}
function message(text, bad = false) {
  $('live-settings-message').textContent = text;
  $('live-settings-message').className = bad ? 'desk-message-error' : '';
}
function updateDraft() {
  if (!latest?.trading) return;
  const t = latest.trading, mode = $('live-exit-mode').value, priceMode = mode === 'price';
  const symbol = $('live-asset-btc').checked ? 'BTCUSDT' : 'ETHUSDT';
  $('live-exit-fields').hidden = mode === 'strategy';
  $('live-tp-unit').textContent = $('live-sl-unit').textContent = priceMode ? 'USDT' : '%';
  $('live-tp').placeholder = priceMode ? 'Ví dụ: giá chốt lời' : '1';
  $('live-sl').placeholder = priceMode ? 'Ví dụ: giá cắt lỗ' : '0,5';
  $('live-draft-badge').textContent = saving ? 'Đang lưu…' : dirty ? (t.controls?.revision !== formRevision ? 'Có cấu hình mới' : 'Chưa lưu') : 'Đã lưu';
  $('live-draft-badge').dataset.state = dirty ? 'draft' : 'saved';
  $('live-settings-save').disabled = stale || saving || !dirty || !t.controls;
  $('live-settings-reload').disabled = saving || !dirty;
  $('live-settings-save').textContent = saving ? 'Đang lưu…' : 'Lưu cấu hình';
  for (const input of $('live-settings-form').querySelectorAll('input,select')) input.disabled = saving;
  const row = latest.rows?.filter(r => r.symbol === symbol).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const price = row && latest.serverNow - row.updatedAt <= 15000 ? row.price : null;
  let preview = mode === 'strategy'
    ? 'TP1 và cắt lỗ được tính từ tín hiệu/ATR khi bot mở lệnh.'
    : priceMode ? 'Giá USDT cố định. LONG cần TP > giá vào > CL; SHORT cần CL > giá vào > TP. Sai phía giá sẽ bỏ qua tín hiệu.'
    : 'Tính từ giá vào dự kiến; LONG: TP ở trên, CL ở dưới. SHORT: TP ở dưới, CL ở trên.';
  if (price && mode === 'percent') {
    try {
      const v = parseExitDraft(mode, $('live-tp').value, $('live-sl').value);
      preview = `Tham khảo LONG ${symbol.replace('USDT', '')}: TP ${number(price * (1 + v.tpPercent / 100))} · CL ${number(price * (1 - v.slPercent / 100))} USDT. SHORT đảo chiều; giá chốt thực tế được tính khi vào lệnh.`;
    } catch { /* Keep the input help while the user is typing. */ }
  }
  $('live-exit-preview').textContent = preview;
  $('live-resume').disabled = stale || toggling || dirty || saving || !t.enabled || t.halted || !t.controls || !!latest.status.recoveryRequired;
  $('live-pause').disabled = toggling || t.paused;
}
async function post(url, body = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Không thực hiện được (HTTP ${response.status}).`);
  return result;
}
export function bindLiveDesk(onSnapshot) {
  if (bound) return; bound = true; applySnapshot = onSnapshot;
  $('live-toggle-buttons').append($('live-resume'), $('live-pause'), $('live-action-result'));
  $('live-resume').textContent = 'Bật giao dịch'; $('live-pause').textContent = 'Tắt giao dịch';
  for (const input of $('live-settings-form').querySelectorAll('input,select')) input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
    if (input.id === 'live-exit-mode') {
      const c = latest?.trading?.controls, mode = input.value;
      $('live-tp').value = mode === 'price' ? (c?.mode === 'price' ? c.tpPrice : '') : (c?.mode === 'percent' ? c.tpPercent : 1);
      $('live-sl').value = mode === 'price' ? (c?.mode === 'price' ? c.slPrice : '') : (c?.mode === 'percent' ? c.slPercent : .5);
    }
    if (input.name === 'liveAsset' && $('live-exit-mode').value === 'price') { $('live-tp').value = ''; $('live-sl').value = ''; }
    dirty = true; message('Lưu cấu hình trước khi bật.'); updateDraft();
  });
  $('live-settings-reload').addEventListener('click', () => {
    if (!latest?.trading?.controls) return;
    loadForm(latest.trading.controls); message('Đã tải lại cấu hình đang áp dụng.'); updateDraft();
  });
  $('live-settings-form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving || !latest?.trading?.controls) return;
    let values;
    try { values = parseExitDraft($('live-exit-mode').value, $('live-tp').value, $('live-sl').value); }
    catch (e) { message(e.message, true); return; }
    const payload = { symbol: $('live-asset-btc').checked ? 'BTCUSDT' : 'ETHUSDT', mode: $('live-exit-mode').value, ...values, expectedRevision: formRevision };
    saving = true; updateDraft();
    try {
      const result = await post('/api/live/settings', payload);
      loadForm(result.trading.controls); applySnapshot(result); message('Đã lưu. Chỉ áp dụng cho lệnh mới.');
    } catch (e) { message(e.message, true); }
    finally { saving = false; updateDraft(); }
  });
  for (const action of ['pause', 'resume']) $('live-' + action).addEventListener('click', async () => {
    if (toggling || (action === 'resume' && (dirty || saving))) return;
    toggling = true; updateDraft(); $('live-action-result').textContent = 'Đang cập nhật…';
    try {
      const result = await post('/api/live/' + action); applySnapshot(result);
      $('live-action-result').textContent = action === 'pause' ? 'Đã tắt mở lệnh mới.' : 'Đã bật chờ tín hiệu. Chỉ vào lệnh khi kết nối và điều kiện hợp lệ.';
    } catch (e) { $('live-action-result').textContent = e.message; }
    finally { toggling = false; updateDraft(); }
  });
  $('live-check-connection').addEventListener('click', async () => {
    if (checking) return;
    const button = $('live-check-connection');
    checking = true; button.disabled = true;
    $('live-check-result').textContent = 'Đang kiểm tra…';
    try {
      applySnapshot(await post('/api/live/check-connection'));
      $('live-check-result').textContent = 'API công khai đã phản hồi. Đang đồng bộ giá và kiểm tra tài khoản.';
    } catch (e) { $('live-check-result').textContent = e.message; }
    finally { checking = false; }
  });
}
export function renderLiveDesk(t, snapshot) {
  latest = snapshot; stale = false;
  if (!shown) {
    $('trading-risk-details').open = false;
    $('trading-panel').setAttribute('aria-label', 'Điều khiển giao dịch Binance Futures tiền thật');
    document.title = 'Confluence · Binance Futures';
    document.querySelector('.brand small').textContent = 'TRADING DESK';
    document.querySelector('footer p').textContent = 'Cấu hình TP/CL áp dụng cho lệnh mới. Đối chiếu vị thế và lịch sử giao dịch thực tế trên Binance.';
    shown = true;
  }
  $('live-desk').hidden = false; $('live-controls').hidden = true;
  if (t.controls && !dirty && !saving && t.controls.revision !== formRevision) loadForm(t.controls);
  const c = t.controls, name = c?.symbol?.replace('USDT', '') || '—';
  $('live-saved-symbol').textContent = `${name} / USDT`;
  $('live-saved-exits').textContent = !c ? 'Chờ cấu hình từ máy chủ.' : c.mode === 'strategy' ? 'TP/CL theo chiến lược' : c.mode === 'percent' ? `TP ${c.tpPercent}% · CL ${c.slPercent}%` : `TP ${number(c.tpPrice)} · CL ${number(c.slPrice)} USDT`;
  const health = snapshot.sources?.find(s => s.exchange === 'binance');
  const retryAt = Math.max(snapshot.status.retryAt || 0, health?.retryAt || 0, t.accountRetryAt || 0);
  const recoveryRequired = !!snapshot.status.recoveryRequired;
  const waiting = retryAt > snapshot.serverNow;
  const blocked = snapshot.status.phase === 'BLOCKED' || waiting;
  const on = t.enabled && !t.paused && !t.halted;
  $('live-power-label').textContent = t.halted ? 'Đã khóa mở lệnh' : !t.enabled ? 'Chưa cấp quyền giao dịch' : on ? 'Đang bật' : 'Đang tắt';
  $('live-power-description').textContent = on ? (blocked ? 'Chờ Binance mở truy cập' : 'Chờ tín hiệu đủ điều kiện') : 'Không mở vị thế mới';
  $('live-power-icon').dataset.on = String(on);
  $('live-resume').hidden = on; $('live-pause').hidden = !on;
  const activationHint = snapshot.localPc
    ? 'Mở lại bot và chọn 2 để cấp quyền cho nút Bật giao dịch. Bạn vẫn có thể lưu TP/CL.'
    : 'Đặt BINANCE_LIVE_ENABLED=true trong Render để cấp quyền cho nút Bật. Cấu hình TP/CL vẫn lưu được ngay.';
  $('live-power-hint').textContent = t.halted ? 'Có lỗi cần kiểm tra trên Binance. Bật lại không xóa khóa HALTED.' : !t.enabled ? activationHint : 'Tắt chỉ dừng mở thêm. Lệnh đã gửi có thể hoàn tất; vị thế đang mở vẫn giữ SL/TP trên sàn.';
  const card = $('live-connection-card');
  card.dataset.state = blocked ? 'blocked' : snapshot.status.phase === 'STREAMING' ? 'online' : 'waiting';
  const code = snapshot.status.httpStatus || health?.httpStatus;
  $('live-connection-title').textContent = blocked ? `Tạm dừng truy cập${code ? ' · HTTP ' + code : ''}` : snapshot.status.phase === 'STREAMING' ? 'Đã kết nối giá thị trường' : 'Đang chờ nguồn giá';
  if (snapshot.status.configuredDeadline) $('live-connection-title').textContent = 'Đang giữ hạn chờ đã lưu';
  if (recoveryRequired) {
    $('live-connection-detail').textContent = waiting
      ? `Bot đã dừng gọi API. Có thể kiểm tra kết nối sau ${date(retryAt)} (UTC+7).`
      : 'Đã hết hạn chờ. Bấm kiểm tra để gửi một yêu cầu đọc tới Binance.';
  } else {
    $('live-connection-detail').textContent = blocked ? `Binance đang giới hạn máy chủ. ${retryAt ? 'Thử lại sau ' + date(retryAt) + ' (UTC+7).' : ''}` : t.status === 'ERROR' || t.status === 'NEED_KEYS' ? t.reason : 'Bot chỉ mở lệnh khi dữ liệu mới và tài khoản sẵn sàng.';
  }
  const seconds = Math.max(0, Math.ceil((retryAt - snapshot.serverNow) / 1000));
  $('live-retry-countdown').textContent = seconds ? `Còn ${Math.floor(seconds / 3600)} giờ ${Math.floor(seconds % 3600 / 60)} phút ${seconds % 60} giây.` : '';
  const check = $('live-check-connection');
  check.hidden = !recoveryRequired;
  check.disabled = waiting || checking || snapshot.status.checkingConnection || t.enabled;
  if (recoveryRequired && t.enabled && !checking) $('live-check-result').textContent = snapshot.localPc
    ? 'Mở lại bot và chọn 1 (Chỉ đọc) để kiểm tra kết nối.'
    : 'Đặt BINANCE_LIVE_ENABLED=false trên Render để kiểm tra ở chế độ chỉ đọc.';
  $('trading-title').textContent = 'Trạm giao dịch · Tiền thật';
  $('trading-status').textContent = t.halted ? 'Cần kiểm tra' : blocked ? 'Binance đang giới hạn' : t.paused ? 'Đã tắt mở lệnh' : !t.enabled ? 'Chế độ chỉ đọc' : t.status === 'READY' ? 'Sẵn sàng · chờ tín hiệu' : t.status === 'POSITION_OPEN' ? 'Đang theo dõi vị thế' : 'Chưa sẵn sàng';
  if (t.paused && !t.halted) $('trading-reason').textContent = 'Đã tắt mở vị thế mới. Cấu hình vẫn lưu được; vị thế hiện có tiếp tục được đối chiếu khi API truy cập được.';
  else if (blocked && !t.halted) $('trading-reason').textContent = 'Đã ghi nhận cấu hình. Bot chưa mở lệnh vì Binance đang giới hạn truy cập.';
  else if (t.status === 'PAUSED' && !t.paused) $('trading-reason').textContent = 'Đã bật chờ tín hiệu mới. Bot sẽ kiểm tra tài khoản và kết nối trước khi vào lệnh.';
  updateDraft();
}
export function markDeskStale() {
  if (latest?.trading?.mode !== 'BINANCE_LIVE') return;
  stale = true;
  $('live-connection-title').textContent = 'Mất kết nối dashboard';
  $('live-connection-detail').textContent = 'Trạng thái bên dưới là dữ liệu cũ. Bot có thể vẫn chạy; cần kết nối lại để xác nhận.';
  $('live-connection-card').dataset.state = 'waiting';
  $('live-resume').disabled = true; $('live-settings-save').disabled = true;
  $('live-check-connection').disabled = true;
  $('live-power-description').textContent = 'Chưa xác nhận trạng thái hiện tại';
}
