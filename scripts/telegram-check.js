import { loadConfig } from '../src/config.js';
const cfg = loadConfig();
if (!cfg.telegramToken) { console.error('Điền TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID trong .env trước.'); process.exitCode = 1; }
else {
  try {
    for (const [method, body] of [['getMe', {}], ['getChat', { chat_id: cfg.telegramChatId }]]) {
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(`Telegram ${method} chưa thành công (HTTP ${res.status}). Kiểm tra token/chat ID và gửi /start cho bot.`);
    }
    console.log('Telegram token và chat ID hợp lệ. Chưa gửi tin nhắn kiểm tra.');
  } catch (e) { console.error(e.message.startsWith('Telegram ') ? e.message : 'Không kết nối được Telegram. Kiểm tra mạng và cấu hình.'); process.exitCode = 1; }
}
