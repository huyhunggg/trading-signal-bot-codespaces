const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('Điền TELEGRAM_BOT_TOKEN trong .env trước.'); process.exitCode = 1; }
else {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ timeout: 0, limit: 50, allowed_updates: ['message'] }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error('Telegram không trả được danh sách chat. Kiểm tra token; dùng bot riêng chưa cài webhook.');
    const chats = new Map(json.result.filter(u => u.message?.chat).map(u => [String(u.message.chat.id), u.message.chat.type]));
    if (!chats.size) console.log('Chưa thấy chat. Mở bot của bạn trên Telegram, gửi /start rồi chạy lại lệnh này.');
    else for (const [id, type] of chats) console.log(`Chat ID: ${id} (${type}) — điền ID nơi bạn muốn nhận tin vào TELEGRAM_CHAT_ID.`);
  } catch { console.error('Không đọc được chat ID. Kiểm tra token, mạng và bảo đảm bot riêng chưa dùng webhook.'); process.exitCode = 1; }
}
