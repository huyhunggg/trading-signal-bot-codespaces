export function controlError(message, status = 400) {
  const error = new Error(message); error.status = status; error.publicMessage = message; return error;
}

export const defaultControls = () => ({ symbol: 'ETHUSDT', mode: 'strategy', tpPercent: 1, slPercent: 0.5, tpPrice: null, slPrice: null, revision: 0 });

export function validateControls(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw controlError('Cấu hình giao dịch không hợp lệ.');
  const allowed = ['symbol', 'mode', 'tpPercent', 'slPercent', 'tpPrice', 'slPrice', 'expectedRevision', 'revision'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw controlError('Cấu hình có trường không được hỗ trợ.');
  if (!['BTCUSDT', 'ETHUSDT'].includes(input.symbol)) throw controlError('Chỉ chọn BTC/USDT hoặc ETH/USDT.');
  if (!['strategy', 'percent', 'price'].includes(input.mode)) throw controlError('Chọn cách đặt TP và cắt lỗ.');
  const result = { ...defaultControls(), symbol: input.symbol, mode: input.mode };
  const decimal = (v, name, max) => {
    if (!['number', 'string'].includes(typeof v) || String(v).trim() === '') throw controlError(`Nhập ${name}.`);
    const n = Number(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || n > max) throw controlError(`${name} phải lớn hơn 0${Number.isFinite(max) ? ` và không quá ${max}` : ''}.`);
    return n;
  };
  if (input.mode === 'percent') {
    result.tpPercent = decimal(input.tpPercent, 'TP (%)', 20); result.slPercent = decimal(input.slPercent, 'Cắt lỗ (%)', 10);
    if (result.tpPercent < 0.05 || result.slPercent < 0.05) throw controlError('TP và cắt lỗ tối thiểu 0,05%.');
  }
  if (input.mode === 'price') {
    result.tpPrice = decimal(input.tpPrice, 'giá TP (USDT)', Infinity); result.slPrice = decimal(input.slPrice, 'giá cắt lỗ (USDT)', Infinity);
    if (result.tpPrice === result.slPrice) throw controlError('Giá TP và cắt lỗ phải khác nhau.');
  }
  return result;
}

export function exitLevels(signal, price, controls) {
  if (!controls || controls.mode === 'strategy') return { sl: signal.sl, tp: signal.tp1 };
  if (controls.mode === 'price') return { sl: controls.slPrice, tp: controls.tpPrice };
  const sign = signal.side === 'LONG' ? 1 : -1;
  return { sl: price * (1 - sign * controls.slPercent / 100), tp: price * (1 + sign * controls.tpPercent / 100) };
}
