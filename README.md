# Confluence — bot cảnh báo crypto LONG/SHORT

Bản 0.1.1 dành cho BTCUSDT, ETHUSDT, SOLUSDT, khung 5m/15m và xác nhận H1 trên thị trường **USDT perpetual**. Dữ liệu công khai Binance hoặc Bybit; không cần API key tài khoản sàn. Có bảng theo dõi và cảnh báo Telegram. Có thể chạy trên trình duyệt bằng **GitHub Codespaces**, không cần cài Node.js trên máy cá nhân.

**Trạng thái bàn giao:** phần tính tín hiệu, lưu trạng thái, gửi tin có thử lại và HTTP dashboard đã được kiểm thử tự động. Môi trường xây dựng bị Binance trả HTTP 451 và Bybit trả HTTP 403 do giới hạn truy cập/khu vực. Chưa xác minh dữ liệu WebSocket live, Telegram thực tế hoặc hiệu quả đầu tư. Chưa triển khai một tiến trình chạy 24/7. Giao diện đã kiểm tra HTTP và cú pháp JavaScript; chưa kiểm tra hiển thị trong trình duyệt ở môi trường này.

Bot chỉ cảnh báo. Các mức entry/SL/TP là **giá tham khảo**, không phải xác nhận khớp lệnh. Chưa tự đặt, chốt hoặc dời SL, và chưa mô phỏng kết quả vị thế. Không có số liệu chứng minh mức thắng 80%+ hoặc tham số “tối ưu”.

## Chạy trên trình duyệt bằng GitHub Codespaces

[Mở môi trường chạy bot trên GitHub Codespaces](https://codespaces.new/huyhunggg/trading-signal-bot-codespaces)

1. Trong repository GitHub, bấm **Code → Codespaces → Create codespace on main**.
2. Đợi môi trường tạo xong. Cấu hình `.devcontainer` chuẩn bị Node.js 24 và tự cài thư viện trên máy chủ.
3. Mở Terminal trong trình duyệt và chạy `npm run demo`. Hoặc chọn **Terminal → Run Task → Bot: demo**.
4. Mở thẻ **Ports**, chọn cổng **8787** rồi bấm mở trong trình duyệt. Giữ **Port visibility = Private** để chỉ bạn truy cập.

Demo có nhãn dữ liệu tổng hợp và tắt Telegram. Dừng demo bằng Ctrl+C trước khi chạy bot thật. Khi chạy thật, tạo `.env` bằng `cp .env.example .env`, cấu hình Telegram theo phần dưới rồi chạy `npm start`. Cũng có thể dùng Codespaces secrets cho hai biến Telegram thay vì ghi token vào file. Nếu thay đổi secrets, khởi động lại Codespace để nạp biến mới.

Codespaces cần tài khoản GitHub và quota phù hợp; thời gian máy chủ hoạt động có thể phát sinh phí. Codespaces có thể tự dừng theo thời gian không hoạt động, nên phù hợp để mở, thử và kiểm tra bot. GitHub repository và GitHub Actions không phải máy chủ theo dõi thị trường liên tục. Khi Codespace dừng thì bot cũng dừng. Máy chủ vẫn cần quyền truy cập hợp lệ đối với API sàn; Codespaces không giải quyết giới hạn 403/451.

## Chạy liên tục bằng Docker trên máy chủ

Nếu đã có máy chủ hỗ trợ Docker Compose và được phép truy cập sàn, bạn không cần cài Node.js trên máy cá nhân hoặc cài Node.js riêng trên máy chủ. Trong bản checkout của repository, tạo `.env` rồi chạy:

```sh
cp .env.example .env
# Điền Telegram và cấu hình trong .env trước khi bật bot thật.
docker compose up -d --build
docker compose logs -f bot
```

Lệnh `up` tạo và chạy container trên chính máy đang thực hiện lệnh. Container tự khởi động lại sau lỗi/khởi động máy nếu Docker hoạt động. Trạng thái chống báo trùng và nhật ký lưu trong volume `bot-data` qua những lần cập nhật container. `docker compose down` dừng bot nhưng giữ volume; không dùng `down -v` nếu muốn giữ trạng thái.

Dashboard được ánh xạ riêng vào `127.0.0.1` của máy chủ. Dùng đường hầm SSH riêng để xem từ xa; chưa có đăng nhập để mở công khai. Kiểm tra health của container chỉ xác nhận HTTP dashboard phản hồi, không xác nhận kết nối sàn hay Telegram; xem trạng thái thực trong dashboard và log.

Đọc chat ID và kiểm tra Telegram trực tiếp trong container, không cần Node.js trên máy bạn:

```sh
docker compose run --rm bot node --use-env-proxy scripts/telegram-chat.js
docker compose run --rm bot node --use-env-proxy scripts/telegram-check.js
```

Sau khi sửa `.env`, chạy `docker compose up -d --force-recreate` để nạp cấu hình mới. Mỗi thư mục dữ liệu chỉ chạy một tiến trình bot thật.

## Chạy trực tiếp trên Windows nếu muốn

1. Cài **Node.js 24.5 trở lên**, khuyến nghị bản 24 LTS mới nhất từ https://nodejs.org/.
2. Giải nén toàn bộ thư mục `trading-signal-bot` vào một nơi dễ tìm.
3. Trong thư mục đó, mở PowerShell/Terminal và chạy:

```powershell
npm ci
Copy-Item .env.example .env
npm run demo
```

Mở http://127.0.0.1:8787 trong trình duyệt. Chế độ demo dùng giá tổng hợp, ghi nhãn MÔ PHỎNG và **luôn tắt Telegram**, kể cả khi `.env` đã có token. Demo giúp kiểm tra phần mềm, không phải backtest hay bằng chứng chiến lược sinh lời. Nhấn `Ctrl+C` để dừng.

Trên macOS/Linux, dùng `cp .env.example .env` thay cho `Copy-Item`. Không chép đè `.env` đã điền thông tin của bạn.

## 2. Cài Telegram nhận cảnh báo

1. Trong ứng dụng Telegram, mở tài khoản chính thức **@BotFather**, dùng `/newbot` để tạo bot riêng.
2. Mở `.env` bằng trình soạn thảo và điền `TELEGRAM_BOT_TOKEN`. Giữ token ở máy chạy bot, không gửi token vào cuộc trò chuyện hay đăng lên Git.
3. Mở bot vừa tạo trong Telegram, bấm Start hoặc gửi `/start`.
4. Chạy lệnh này để đọc chat ID của bạn từ bot riêng:

```powershell
npm run telegram:chat
```

5. Điền ID đó vào `TELEGRAM_CHAT_ID` trong `.env`, rồi chạy:

```powershell
npm run telegram:check
```

Lệnh kiểm tra chỉ đọc thông tin bot/chat, chưa gửi tin nhắn. Bot riêng không nên được dùng đồng thời bởi ứng dụng khác hoặc cài webhook. Nếu danh sách chat trống, gửi thêm một tin nhắn cho bot rồi thử lại. Token và chat ID chỉ được đọc phía tiến trình bot, không được trả về dashboard hay ghi vào nhật ký tín hiệu.

## 3. Bật dữ liệu thật

Trong `.env`, giữ `EXCHANGE=binance` hoặc đặt `EXCHANGE=bybit`. Mỗi lần chạy dùng một sàn nhất quán; không trộn giá Binance với mức tham khảo Bybit.

```powershell
npm run check
npm start
```

`check` xác minh REST và dữ liệu nến; chưa xác minh WebSocket. Sau `npm start`, dashboard chuyển sang **Đang nhận dữ liệu** khi đã kết nối WebSocket và đồng bộ lịch sử. Telegram báo “đã cấu hình” chỉ có nghĩa là đã điền hai trường; chạy `telegram:check` để kiểm tra chúng, và trạng thái “gửi gần nhất” chỉ xuất hiện sau lần gửi thành công.

Nếu API trả 403/451, bot hiển thị trạng thái bị từ chối và dừng tự thử kết nối dữ liệu. Kiểm tra quyền truy cập/điều khoản của sàn đối với nơi chạy; khi đã có quyền truy cập hợp lệ, khởi động lại bot. Không dùng dữ liệu demo làm dữ liệu thật. Khi mất kết nối thông thường, bot tự kết nối lại và tải lịch sử bù. Giá cũ vẫn được ghi rõ trên dashboard.

Bot chỉ theo dõi khi tiến trình đang chạy. Để hoạt động 24/7, cần máy luôn bật hoặc máy chủ được phép truy cập sàn, có Node.js và một trình quản lý tiến trình tự khởi động lại bot. Dashboard mặc định chỉ nghe `127.0.0.1`; khi dùng máy chủ từ xa, truy cập qua đường hầm SSH riêng. Không mở cổng dashboard công khai: bản này chưa có đăng nhập.

## 4. Quy tắc được triển khai

### Lớp 1 — tín hiệu sau khi đóng nến

Điều kiện chung cho cả hai nhánh:

| Điều kiện | LONG | SHORT |
| --- | --- | --- |
| Xu hướng khung giao dịch | Close > EMA200 và EMA50 > EMA200 | Close < EMA200 và EMA50 < EMA200 |
| H1/H4 đã đóng | Close HTF > EMA21/50/200 HTF | Close HTF < EMA21/50/200 HTF |
| Chống nến quá dài | Body ≤ 0.85 × ATR(14) | Body ≤ 0.85 × ATR(14) |
| Màu nến xác nhận | Close > Open | Close < Open |

Sau đó cần **một trong hai nhánh** sau:

| Nhánh | LONG | SHORT |
| --- | --- | --- |
| `RSI_HOOK` | Close < EMA21, Close ≤ VWAP; RSI(2) trước <15, RSI hiện tại > RSI trước | Close > EMA21, Close ≥ VWAP; RSI trước >85, RSI hiện tại < RSI trước |
| `PINBAR_RECLAIM` | Râu dưới ≥45% toàn nến; Low < EMA21, Low ≤ VWAP; Close > EMA21 | Râu trên ≥45% toàn nến; High > EMA21, High ≥ VWAP; Close < EMA21 |

**Điểm đã làm rõ từ mô tả gốc:** yêu cầu Close dưới EMA21 của LONG Hook không thể đồng thời đi với pin-bar đóng trở lại phía trên EMA21. Vì vậy pin-bar là một nhánh thay thế: kiểm tra vùng bằng râu nến và xác nhận bằng giá đóng qua EMA21, không bắt buộc RSI Hook. SHORT đối xứng. Cả hai nhánh vẫn phải đạt các điều kiện chung.

Nhánh pin-bar mặc định được bật để triển khai hai cơ chế mà bạn mô tả, không phải vì đã chứng minh hiệu suất tốt hơn. Đặt `PINBAR_ENABLED=false` để chạy Hook-only và so sánh nhật ký sau này. Mỗi cảnh báo ghi tên nhánh. Chưa tự thay đổi tham số dựa trên kết quả chưa có.

- Tín hiệu cùng chiều, cùng cặp/khung cách nhau ít nhất **4 khoảng nến**: chênh lệch thời gian mở ≥4 × độ dài khung. LONG/SHORT và 5m/15m có bộ đếm riêng.
- Các mức tham khảo: SL cách giá đóng 1.8 ATR; TP1 0.8 ATR; TP2 1.8 ATR. ATR lấy tại nến xác nhận và cố định trong cảnh báo.
- Phân bổ 50% TP1, 50% TP2 và dời SL về entry sau TP1 là **quy tắc dự kiến nếu sau này có quản lý vị thế**, chưa được thực thi trong bản cảnh báo này. Entry không phải hòa vốn sau phí.
- Nếu cả hai TP đạt, lợi nhuận gộp theo tỷ trọng là 1.3 ATR trước phí; SL toàn phần là 1.8 ATR. Chỉ nhìn tỷ lệ thắng không đủ kết luận hiệu quả.

### Lớp 2 — cảnh báo xung lực khi nến đang chạy

- |Giá hiện tại − Open| ≥1.25 × **ATR của nến đã đóng liền trước**.
- LONG: nến đang xanh, giá > EMA200 của nến đã đóng, H1/H4 đã đóng là LONG, giá > VWAP đang cập nhật.
- SHORT: điều kiện đối xứng.
- Mỗi chiều báo một lần trên một nến/cặp/khung, kể cả khi khởi động lại. Không phải tín hiệu đóng nến; điều kiện có thể mất đi trước khi nến kết thúc.
- TP tham khảo 0.8 ATR, SL tham khảo 1.5 ATR; chưa quản lý vị thế.
- Hai lớp độc lập: cảnh báo xung lực trong nến không ngăn một tín hiệu đóng nến sau đó, và không thay thế tín hiệu đó.

### Quy ước chỉ báo và thời gian

- EMA21/50/200: khởi tạo SMA, sau đó cập nhật EMA thông thường.
- RSI(2): RSI của Wilder chu kỳ 2, **không phải** chỉ báo tổng hợp ConnorsRSI nhiều thành phần.
- ATR(14): True Range được làm mượt Wilder, khởi tạo bằng trung bình 14 True Range (cây đầu dùng High−Low).
- VWAP: HLC3 × volume tài sản cơ sở từ nến, đặt lại lúc **00:00 UTC**, tức **07:00 Việt Nam**. Đây là VWAP xấp xỉ từ OHLCV, không phải phép cộng từng giao dịch. Phiên đầu thiếu dữ liệu được bỏ qua đến phiên UTC đầy đủ.
- ADX(14) và RVOL(20): hiển thị để quan sát; **chưa chặn lệnh**, vì quy tắc gốc không cho ngưỡng. RVOL so với trung bình 20 nến trước, không tính nến hiện tại vào mẫu chuẩn.
- Khung lớn mặc định `1h`, có thể đổi `HTF=4h`.
- Mức tham khảo được tính theo giá giao dịch cuối của nến, không phải mark price hoặc bid/ask có thể khớp thực tế.

## 5. Độ trễ, dữ liệu và lưu trạng thái

- Bot dùng WebSocket. Theo tài liệu sàn tại thời điểm xây dựng, Binance kline cập nhật khoảng 250 ms nếu có dữ liệu; Bybit kline có tần suất 1–60 giây. Đây không phải cam kết thời gian nhận Telegram. Còn độ trễ mạng, sự kiện đóng nến, hàng đợi và Telegram.
- Tín hiệu lớp 1 đợi cờ đóng nến. H1/H4 cũng phải đã đóng tại thời điểm tín hiệu; ở ranh giới giờ, bot đợi sự kiện H1 thay vì dùng H1 cũ. Dữ liệu có thể được sàn điều chỉnh sau đó; không có bảo đảm “không repaint 100%”.
- Khi khởi động/khôi phục, tải 650 nến cho mỗi luồng và không phát lại lịch sử như tín hiệu mới. Nếu lịch sử thiếu hoặc đứt đoạn, tạm dừng và đồng bộ lại. Cặp mới niêm yết chưa đủ lịch sử sẽ chưa được hỗ trợ.
- Mặc định dữ liệu một luồng im lặng quá 90 giây sẽ gây kết nối lại. Cảnh báo đóng nến trễ quá 120 giây bị bỏ qua. Tin Telegram chưa gửi hết hạn sau 120 giây từ đóng nến đối với lớp 1, từ phát hiện đối với lớp 2.
- `data/state.json`: ID đã báo, mốc chống spam, 100 tín hiệu gần nhất và hàng đợi Telegram. `data/signals.jsonl`: nhật ký lâu dài, mỗi dòng một tín hiệu.
- Lưu trạng thái qua file tạm và đổi tên. Chỉ chạy **một tiến trình cho mỗi thư mục dữ liệu**; cần sao lưu và theo dõi dung lượng nhật ký khi vận hành lâu dài.
- Telegram thử lại khi lỗi và tuân thủ `retry_after`. Trường hợp Telegram đã nhận tin nhưng tiến trình dừng trước khi lưu xác nhận có thể tạo một tin lặp sau khởi động lại; ID trong tin giúp nhận biết. Chưa có bảo đảm giao tin đúng một lần hoặc nhận ngay tức thì.
- Dùng proxy/CA đã cấu hình trong môi trường nếu có, giữ xác minh TLS. Không tự chuyển nguồn hay lách giới hạn khu vực.

## 6. Cấu hình chính

| Biến trong `.env` | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `EXCHANGE` | `binance` | `binance` hoặc `bybit`, dữ liệu USDT perpetual |
| `SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT` | Cặp phân cách bằng dấu phẩy, tối đa 20 |
| `TIMEFRAMES` | `5m,15m` | 5m, 15m hoặc cả hai |
| `HTF` | `1h` | 1h hoặc 4h |
| `PINBAR_ENABLED` | `true` | Bật nhánh pin-bar thay thế |
| `HISTORY_BARS` | `650` | 600–1000 nến cho mỗi luồng |
| `SIGNAL_MAX_AGE_SECONDS` | `120` | Giới hạn tuổi tín hiệu/hàng đợi |
| `STREAM_STALE_SECONDS` | `90` | Phát hiện luồng không cập nhật |
| `PORT` | `8787` | Cổng bảng theo dõi |
| `HOST` | `127.0.0.1` | Chỉ máy cục bộ theo mặc định |
| `DATA_DIR` | `./data` | Trạng thái và nhật ký thật |

Các ngưỡng chiến lược hiện giữ trong `src/config.js` → `RULES`. Đổi cấu hình rồi khởi động lại. Demo dùng thư mục `demo-data` riêng. Không xóa `data` khi nâng cấp nếu muốn giữ chống báo trùng và lịch sử.

## 7. Kiểm thử và cấu trúc mã

```powershell
npm test
```

Kiểm thử bao gồm công thức chỉ báo; điều kiện LONG/SHORT; hai nhánh và hai lớp; chọn HTF theo thời điểm; đợi HTF tại ranh giới giờ; dữ liệu thiếu/cũ; chống báo trùng qua khởi động lại; thời hạn/thử lại gửi tin bằng bộ gửi giả; chuẩn hóa dữ liệu hai sàn; và HTTP dashboard. Không dùng tiền thật hoặc gửi Telegram trong kiểm thử.

- `src/market.js`: REST, WebSocket và chuẩn hóa dữ liệu hai sàn.
- `src/indicators.js`: các chỉ báo có tính nhân quả theo thời gian.
- `src/strategy.js`: điều kiện và các mức giá tham khảo.
- `src/engine.js`: đồng bộ khung lớn, kiểm tra dữ liệu, điều phối tín hiệu.
- `src/store.js`: lưu trạng thái, nhật ký và Telegram.
- `src/main.js`: khởi động, khôi phục kết nối và demo.
- `ui/`: dashboard chỉ đọc.

Repository có sẵn workflow `.github/workflows/ci.yml` để chạy kiểm thử và build Docker image khi push hoặc tạo pull request. Workflow không chạy bot liên tục hoặc tự gửi Telegram.

Bản đóng gói đã được kiểm tra: 25 kiểm thử đạt; Docker image build thành công với chứng chỉ proxy của môi trường kiểm thử được cấp tạm qua BuildKit secret; container chạy bằng user thường, ghi trạng thái vào vùng lưu riêng và phục vụ được dashboard qua Host chuyển tiếp. Không đưa chứng chỉ proxy vào repository/image. Cấu hình Codespaces đã đối chiếu image Node.js 24 có sẵn; chưa mở một Codespace trong tài khoản của bạn.

Đây là cách triển khai mới từ bản mô tả bạn cung cấp, chưa đối chiếu được file `server.js` trên máy Windows của bạn. Trước khi dùng tiền thật ở phiên bản tự giao dịch sau này, cần backtest có phí/trượt giá/funding, chia tập đánh giá theo thời gian, thống kê riêng từng nhánh, rồi chạy paper trading theo dữ liệu live. Chưa có các bước này trong bản 0.1.1.

## Tài liệu API đã đối chiếu

- Binance USDⓈ-M market streams, gồm đường dẫn `/market/stream` và kline: https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market
- Binance REST klines: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data
- Bybit WebSocket kline: https://bybit-exchange.github.io/docs/v5/websocket/public/kline
- Bybit REST kline: https://bybit-exchange.github.io/docs/v5/market/kline
- Telegram Bot API: https://core.telegram.org/bots/api
