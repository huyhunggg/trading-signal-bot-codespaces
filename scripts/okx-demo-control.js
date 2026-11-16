import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.DATA_DIR || './data', file = path.join(dir, 'STOP-OKX-DEMO');
fs.mkdirSync(dir, { recursive: true });
if (process.argv[2] === 'pause') {
  fs.writeFileSync(file, 'Pause new demo entries\n', { mode: 0o600 });
  console.log('Đã yêu cầu dừng mở lệnh mới (tối đa một yêu cầu đang gửi có thể hoàn tất). SL/TP trên sàn vẫn hoạt động.');
} else if (process.argv[2] === 'resume') {
  fs.rmSync(file, { force: true });
  console.log('Đã bỏ tạm dừng. Nếu bot báo HALTED, cần kiểm tra nhật ký và lệnh trên OKX trước; lệnh này không xóa khóa lỗi.');
} else throw new Error('Use pause or resume');
