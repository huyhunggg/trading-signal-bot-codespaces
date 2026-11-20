import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { markRecovery, readBackoff, requestsPaused, saveBackoff } from '../src/provider-health.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = join(root, 'live-data', 'pc');
const settingsFile = join(dataDir, 'settings.json');
const config = { exchange: 'binance', dataDir, manualBanRecovery: true };
const host = '127.0.0.1', port = 8787, dashboard = `http://${host}:${port}`;

function checkPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Cổng ${port} đang được dùng. Nếu bot đã mở, vào ${dashboard}. Nếu là chương trình khác, đóng chương trình đó rồi thử lại.`)));
    server.listen(port, host, () => server.close(resolve));
  });
}

async function installDependencies() {
  if (['ws', 'proxy-agent'].every(name => existsSync(join(root, 'node_modules', name, 'package.json')))) return;
  console.log('Đang cài thư viện cho bot. Chỉ cần ở lần đầu…');
  const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
  const npm = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'npm', ...args]] : ['npm', args];
  await new Promise((resolve, reject) => {
    const child = spawn(...npm, { cwd: root, stdio: 'inherit' });
    const failure = () => reject(new Error('Chưa cài được thư viện. Kiểm tra Node.js 24 LTS và kết nối mạng, rồi mở lại.'));
    child.once('error', failure);
    child.once('exit', code => code === 0 ? resolve() : failure());
  });
}

async function checkBinanceMarket() {
  const held = readBackoff(config);
  if (requestsPaused(held) && (held.retryAt > Date.now() || existsSync(settingsFile))) return false;
  const { getJson } = await import('../src/market.js');
  try {
    const { serverTime } = await getJson('https://fapi.binance.com/fapi/v1/time',
      (url, options) => fetch(url, { ...options, redirect: 'error' }));
    if (!Number.isFinite(serverTime)) throw new Error('Binance chưa trả giờ máy chủ hợp lệ.');
  } catch (error) {
    if ([403, 418, 429, 451].includes(error.httpStatus)) {
      error.requestKind = 'connection-check';
      const { retryAt } = saveBackoff(config, error);
      const until = new Date(retryAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
      throw new Error(`Máy này chưa kết nối được Binance Futures (HTTP ${error.httpStatus}). Hạn chờ đã lưu: ${until} (UTC+7).`);
    }
    throw new Error(`Máy này chưa kết nối được Binance Futures. ${error.message}`);
  }
  if (held?.manualRecovery) markRecovery(config, false);
  console.log('Binance Futures đã phản hồi. Bot sẽ kiểm tra tài khoản sau khi mở dashboard.');
  return true;
}

function readSettings() {
  if (!existsSync(settingsFile)) return null;
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    if (validSettings(settings)) return settings;
  } catch {}
  throw new Error('Không đọc được live-data/pc/settings.json. Kiểm tra file cấu hình hoặc đổi tên file đó để nhập lại.');
}

function validSettings(settings) {
  return !!settings && ['key', 'secret'].every(k => typeof settings[k] === 'string' && /^[\x21-\x7E]+$/.test(settings[k])) &&
    typeof settings.password === 'string' && settings.password.length >= 8;
}

async function configure(connected) {
  const existingSettings = readSettings();
  if (!existingSettings && !connected) {
    const until = new Date(readBackoff(config).retryAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
    throw new Error(`Máy này đang có hạn chờ Binance. Mở lại sau ${until} (UTC+7).`);
  }
  if (existingSettings && !connected) return { settings: existingSettings, enabled: false };
  if (!process.stdin.isTTY) throw new Error('Mở chương trình trong cửa sổ Terminal để nhập cấu hình.');
  const hiddenOutput = new Writable({ write(_data, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: hiddenOutput, terminal: true });
  input.once('SIGINT', () => { input.close(); process.exit(130); });
  const ask = async label => {
    process.stdout.write(label);
    const value = await input.question('');
    process.stdout.write('\n');
    return value.trim();
  };
  try {
    if (existingSettings) {
      console.log('\n[1] Chỉ đọc tài khoản (mặc định)');
      console.log('[2] Cho phép giao dịch thật. Bot vẫn chờ bạn bấm Bật giao dịch trên dashboard.');
      const mode = await ask('Chọn 1 hoặc 2 rồi nhấn Enter: ');
      if (!['', '1', '2'].includes(mode)) throw new Error('Chọn 1 hoặc 2 khi mở lại bot.');
      return { settings: existingSettings, enabled: mode === '2' };
    }
    console.log('\nThiết lập lần đầu. Ký tự bạn nhập sẽ được ẩn.');
    const settings = {
      key: await ask('API Key Binance Futures: '),
      secret: await ask('API Secret Binance Futures: '),
      password: await ask('Mật khẩu riêng cho dashboard (ít nhất 8 ký tự): '),
    };
    if (!validSettings(settings)) throw new Error('Kiểm tra lại khóa API và mật khẩu dashboard. Chưa lưu cấu hình.');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { flag: 'wx', mode: 0o600 });
    return { settings, enabled: false };
  } finally {
    input.close();
  }
}

async function openDashboard(env) {
  let ready = false;
  for (let n = 0; n < 30 && !ready; n++) {
    try { ready = (await fetch(dashboard + '/healthz', { signal: AbortSignal.timeout(800) })).ok; } catch {}
    if (!ready) await delay(300, undefined, { ref: false });
  }
  if (!ready) return;
  const command = { win32: 'explorer.exe', darwin: 'open', linux: 'xdg-open' }[process.platform];
  if (!command) return;
  const browser = spawn(command, [dashboard], { env, detached: true, stdio: 'ignore' });
  browser.on('error', () => {});
  browser.unref();
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 5)) throw new Error('Cài Node.js 24 LTS từ https://nodejs.org/en/download rồi mở lại bot.');
  await checkPort();
  await installDependencies();
  const connected = await checkBinanceMarket();
  const { settings, enabled } = await configure(connected);
  const browserEnv = { ...process.env };
  delete browserEnv.BINANCE_API_KEY;
  delete browserEnv.BINANCE_API_SECRET;
  delete browserEnv.DASHBOARD_PASSWORD;
  Object.assign(process.env, {
    HOST: host, PORT: String(port), LIVE_DATA_DIR: dataDir, DASHBOARD_USER: 'bot',
    DASHBOARD_PASSWORD: settings.password, BINANCE_API_KEY: settings.key, BINANCE_API_SECRET: settings.secret,
    BINANCE_LIVE_ENABLED: String(enabled),
  });
  // Never reuse a Render deployment's deadline for the local PC.
  delete process.env.BINANCE_RETRY_NOT_BEFORE;
  process.argv.push('--local-pc');
  console.log(`\nMở ${dashboard} và đăng nhập bằng tên bot cùng mật khẩu dashboard.\nGiữ cửa sổ này mở khi chạy bot. Nhấn Ctrl+C để dừng.`);
  void openDashboard(browserEnv);
  await import('../src/binance-live-main.js');
} catch (error) {
  if (error.code === 'EEXIST') console.error('Bot đã được thiết lập trong thư mục này. Mở lại để sử dụng cấu hình đã lưu.');
  else console.error(error.message || 'Không khởi động được bot.');
  process.exitCode = 1;
}
