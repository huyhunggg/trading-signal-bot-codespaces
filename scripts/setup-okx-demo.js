import fs from 'node:fs';
import { Writable } from 'node:stream';
import readline from 'node:readline/promises';

if (!process.stdin.isTTY) throw new Error('Open an interactive Codespaces Terminal to enter demo credentials.');
console.log('Chỉ nhập API tạo trong OKX → Demo Trading → Demo Trading API.');
console.log('Thông tin nhập sẽ được ẩn và lưu cục bộ vào .env.okx-demo (không đưa lên GitHub).');
const silent = new Writable({ write(chunk, encoding, done) { done(); } });
const rl = readline.createInterface({ input: process.stdin, output: silent, terminal: true });
rl.on('SIGINT', () => { rl.close(); process.exit(130); });
const values = {};
try {
  for (const [name, label] of [['OKX_DEMO_API_KEY', 'Demo API key'], ['OKX_DEMO_SECRET_KEY', 'Demo secret key'], ['OKX_DEMO_PASSPHRASE', 'Demo passphrase']]) {
    process.stdout.write(label + ' (ẩn): ');
    const value = (await rl.question('')).trim(); process.stdout.write('\n');
    if (!value || /[\r\n\x00]/.test(value) || /['"\\]/.test(value)) throw new Error('Giá trị rỗng hoặc chứa ký tự không hỗ trợ.');
    values[name] = value;
  }
  const file = '.env.okx-demo', tmp = file + '.tmp';
  fs.writeFileSync(tmp, Object.entries(values).map(([k,v]) => `${k}='${v}'`).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file);
  console.log('Đã lưu. Chạy: HOST=0.0.0.0 PORT=8787 npm run okx:demo');
} finally { rl.close(); }
