# Confluence — tín hiệu crypto và OKX Demo tự động

## Demo tự trading ngay — không tài khoản, không API key

Dùng lệnh này để xem bot tự mua/bán bằng tiền ảo ngay trên dashboard:

```bash
HOST=0.0.0.0 PORT=8787 npm run demo
```

Mở cổng **8787**. Bot có sẵn **10.000 USDT ảo**, mở giao dịch đầu ngay khi chạy và cập nhật giá/vị thế/lãi lỗ mỗi giây. Bot tự đóng ở TP/SL hoặc sau tối đa 20 giây, đợi 3 giây rồi mở giao dịch tiếp theo, luân phiên LONG/SHORT qua BTC, ETH, SOL. Dashboard có nút **Tạm dừng**, **Tiếp tục** và **Bắt đầu lại**; có tính phí 0,06% và trượt giá giả định 0,02% mỗi chiều. Tạm dừng vẫn cho phép thoát vị thế hiện có; bắt đầu lại xóa sổ ảo và mở lại phiên mới.

**Đây là kịch bản minh họa với giá tổng hợp, không phải chiến lược giao dịch hay số liệu thắng/lãi thực tế.** Chế độ này hoạt động không cần mạng, không đọc API key hoặc gọi API đặt lệnh. Mỗi lần chạy là một phiên vốn ảo mới, không liên quan tới tài khoản OKX. Tham số giới hạn: tối đa 1 vị thế, giá trị 1.000 USDT ảo/vị thế và rủi ro dự kiến theo SL 10 USDT ảo.

Nếu bạn đang ở nhánh nâng cấp trong Codespaces, dừng bot cũ bằng **Ctrl+C**, rồi cập nhật và chạy:

```bash
git pull --ff-only origin codex/okx-demo-autotrade
HOST=0.0.0.0 PORT=8787 npm run demo
```

### Tiền ảo theo giá thị trường thật — cũng không cần API key

```bash
HOST=0.0.0.0 PORT=8787 npm run paper
```

Chế độ này chỉ đọc dữ liệu công khai OKX; không đăng nhập, không đặt lệnh lên sàn. Chờ tín hiệu đóng nến mới từ chiến lược hiện có để mở vị thế ảo, không yêu cầu ngưỡng kiểm chứng 80%. Vì thế không nhất thiết có lệnh ngay. Không tự chuyển sang giá giả nếu mất kết nối. Lệnh thoát dựa trên tick thực sự quan sát được, có thể bỏ lỡ diễn biến giữa hai tick; không phải mô hình khớp lệnh thực tế. Dùng toàn bộ TP1/SL, giới hạn giữ 48 nến. Sổ ảo lưu ở `paper-data/ledger.json` (Git bỏ qua), có thể đổi đường dẫn bằng `PAPER_DATA_DIR`. Chỉ chạy một tiến trình trên cùng sổ. Dashboard có điều khiển tạm dừng và reset như trên; reset xóa giao dịch/vị thế ảo đã lưu, không tác động tài khoản bên ngoài.

Chế độ `okx:demo` dưới đây là tùy chọn riêng để gửi lệnh tới tài khoản Demo của sàn, nên mới cần API Demo.

## Mới: tự giao dịch trên tài khoản OKX Demo

`npm run okx:demo` thêm khả năng **đặt lệnh thực sự trong môi trường Demo của OKX bằng tiền ảo**. Khác với `npm run demo` (tự giao dịch minh họa ngay trong sổ ảo cục bộ). Không có chế độ đặt lệnh tiền thật.

### Bắt đầu trong Codespaces

1. Dừng bot cũ bằng **Ctrl+C** trong Terminal. Chỉ chạy một tiến trình giao dịch trên một tài khoản Demo và giữ cổng Codespaces ở chế độ **Private**.
2. Trên OKX, mở **Trade → Demo Trading → Demo Trading API**, tạo API với quyền **Read** và **Trade**. Không dùng API của tài khoản tiền thật. Chuẩn bị số dư USDT ảo trong tài khoản giao dịch Demo; chọn chế độ vị thế **One-way / Net** và chế độ tài khoản hỗ trợ futures isolated.
3. Trong Terminal, chạy lần lượt:

```bash
npm ci --ignore-scripts
npm run okx:demo:setup
HOST=0.0.0.0 PORT=8787 npm run okx:demo
```

Lệnh setup hỏi key, secret và passphrase với ký tự nhập được ẩn; lưu vào `.env.okx-demo` chỉ đọc/ghi bởi người dùng hiện tại. File đã bị Git bỏ qua. Không gửi thông tin này vào chat, ảnh chụp, repository hoặc dashboard. API chưa được kiểm tra cho đến lúc chạy bot. Nếu cần nhập lại, dừng bot rồi chạy lại setup.

4. Mở cổng **8787**. Phần đầu dashboard có **OKX DEMO · Tự động giao dịch bằng tiền ảo**, số dư, trạng thái tài khoản, vị thế, lệnh bot và lịch sử vị thế đóng. Chờ trạng thái **Đang chờ tín hiệu để vào lệnh**. Bot chỉ dùng tín hiệu đóng nến mới, không đặt lệnh ép buộc và không phát lại tín hiệu cũ.
5. Đối chiếu lệnh và SL/TP trong ứng dụng **OKX Demo Trading**. Chưa có lệnh nếu chiến lược chưa xuất hiện tín hiệu; việc lấy được giá không đồng nghĩa bot sẽ lập tức mua/bán.

### Quy tắc của bản thử nghiệm

- Khóa OKX và nguồn dữ liệu OKX; không chuyển sàn tự động. Mọi yêu cầu giao dịch dùng `https://openapi.okx.com` và header `x-simulated-trading: 1`, không theo redirect; không có tùy chọn chuyển tiền thật.
- Chỉ USDT linear perpetual, **isolated 1x**, tối đa **một vị thế trên tài khoản**. Bất kỳ vị thế, lệnh chờ hoặc SL/TP chờ hiện có đều chặn mở thêm. Dùng tài khoản Demo dành riêng cho bot, không đặt lệnh thủ công hoặc chạy bản sao khác trong lúc bot hoạt động.
- Mặc định hạn mức danh nghĩa **50 USDT/lệnh**, rủi ro theo khoảng SL và chi phí dự phòng **1 USDT/lệnh**. Đọc `ctVal`, `ctMult`, `lotSz`, `minSz`, `tickSz` từ sàn; bỏ qua khi khối lượng dưới tối thiểu, giá đã vượt SL/TP, giá lệch quá 0.5%, ticker cũ hơn 15 giây hoặc tín hiệu cũ hơn 60 giây. Các hạn mức là tính toán trước khi gửi; trượt giá có thể làm giá trị thực tế lớn hơn.
- Lệnh market gửi kèm SL và TP lên sàn. **Chốt toàn bộ tại TP1 hoặc SL**, chưa có chốt 50%/TP2/dời SL. Vì khác cách thoát lệnh của backtest cũ, thống kê đó không đánh giá hiệu quả chế độ Demo này.
- Luồng thử nghiệm dùng tín hiệu đóng nến **không yêu cầu đạt bộ lọc lịch sử 80%**; dashboard ghi rõ việc này. Không mở theo cảnh báo xung lực chưa đóng nến. Telegram tắt và không tự tải kiểm chứng lịch sử trong chế độ này. `npm start` giữ luồng cảnh báo và bộ lọc cũ.
- Khi vốn USDT (gồm lãi/lỗ chưa chốt) giảm **5 USDT** so với lần đồng bộ đầu của ngày UTC, bot khóa mở lệnh mới. Không tự đóng cưỡng bức vị thế. Đây là giới hạn dừng mở lệnh, không bảo đảm lỗ tối đa; nạp/rút/reset số dư Demo làm sai so sánh nên không thay đổi vốn khi chạy.
- Ghi ý định đặt lệnh trước khi gửi, dùng client ID cố định và đối chiếu trạng thái khi khởi động lại. Timeout gửi lệnh không được tự gửi lại. Lệnh market chưa khớp đủ sau 30 giây, lệnh hủy đã khớp một phần, hoặc không xác minh được SL/TP sẽ khóa mở thêm và yêu cầu kiểm tra trên OKX. Bot không tự vá SL/TP hoặc đóng vị thế trong trường hợp đó.
- File `data/okx-demo.lock` ngăn hai tiến trình dùng cùng thư mục dữ liệu. Cơ chế này không ngăn bản bot trên máy/thư mục khác; chỉ chạy một bản trên tài khoản. Giữ `data/okx-demo-trades.json` bền vững, không xóa để ép bot đặt lại lệnh.

Có thể đặt giới hạn thấp hơn trong `.env` bằng `OKX_DEMO_MAX_NOTIONAL_USDT`, `OKX_DEMO_RISK_USDT`, `OKX_DEMO_DAILY_LOSS_USDT`. Giới hạn cứng của bản Demo tương ứng 100, 2 và 10 USDT.

### Dừng / kiểm tra lỗi

Trong **Terminal mới**, chạy:

```bash
npm run okx:demo:pause
```

Bot ngừng mở thêm sau khi kiểm tra tài khoản; một yêu cầu đang gửi có thể vẫn hoàn tất. SL/TP ở sàn vẫn hoạt động. Tiếp tục sau tạm dừng thông thường bằng `npm run okx:demo:resume`. Nhấn **Ctrl+C** dừng tiến trình, nhưng không hủy lệnh hay đóng vị thế ở OKX; thực hiện các việc đó trong ứng dụng OKX Demo nếu cần.

Trạng thái **HALTED** là khóa lỗi bền vững, không được xóa bằng resume hoặc khởi động lại. Trước khi can thiệp nhật ký, đối chiếu client ID, lệnh chờ, SL/TP và vị thế trên OKX; cần người hiểu code kiểm tra và khôi phục. Không xóa file nhật ký hoặc tạo bản bot khác để bỏ qua khóa.

**Kiểm chứng bản nâng cấp:** kiểm thử tự động dùng API giả lập cho chữ ký/header Demo, tính hợp đồng, giới hạn vốn, chống trùng, khởi động lại, timeout, khớp một phần và SL/TP. Chưa xác minh đặt/khớp lệnh trên tài khoản OKX Demo thật vì chưa có thông tin API của người dùng. Đặt lệnh thật trên môi trường Demo là bước kiểm thử tiếp theo; kết quả Demo không chứng minh lợi nhuận tiền thật. Codespaces có thể tự dừng.

Tài liệu API: [OKX Demo Trading Services](https://www.okx.com/docs-v5/en/#overview-demo-trading-services), [Place order và attached TP/SL](https://www.okx.com/docs-v5/en/#order-book-trading-trade-post-place-order).

## Chế độ cảnh báo hiện có

Bản 0.3.0 dành cho BTCUSDT, ETHUSDT, SOLUSDT, khung 5m/15m và xác nhận H1 trên thị trường **USDT perpetual**. Có bảng theo dõi giá và cơ hội LONG/SHORT, thống kê thắng lịch sử theo nhóm và Telegram. Dữ liệu công khai OKX, Bybit hoặc Binance, không cần API key tài khoản sàn. Có thể chạy trên trình duyệt bằng **GitHub Codespaces**, không cần cài Node.js trên máy cá nhân.

**Trạng thái kiểm chứng:** đã kiểm tra sáu bảng giá BTC/ETH/SOL bằng dữ liệu OKX thật và xác nhận giá tiếp tục cập nhật qua REST. Môi trường kiểm tra chưa kết nối được WebSocket OKX nên chế độ REST dự phòng được dùng và ghi rõ trên giao diện. Chưa xác minh gửi Telegram thật hoặc hiệu quả đầu tư. Việc host luôn bật và lưu dữ liệu bền vững phụ thuộc dịch vụ triển khai; gói có tự ngủ không đáp ứng theo dõi 24/7.

## Khi triển khai trên Render

Repo có Dockerfile cho Web Service; dùng `HOST=0.0.0.0` và để Render cấp `PORT`. Endpoint kiểm tra tiến trình là `/api/status`, có trường `version` để xác nhận bản đang chạy. Trạng thái HTTP 200 chỉ cho biết giao diện hoạt động, không bảo đảm nguồn thị trường đã kết nối.

Mặc định `EXCHANGE=okx`, `DATA_SOURCE_MODE=auto`. Bot ưu tiên nguồn được chọn, sau đó mới thử nguồn độc lập khác có thể truy cập; mỗi phiên dùng một sàn duy nhất. Nếu muốn chỉ dùng Binance hoặc Bybit, đặt `EXCHANGE` tương ứng và `DATA_SOURCE_MODE=fixed`. Không dùng proxy hoặc địa chỉ Binance khác để vượt hạn chế API.

HTTP **418** là trạng thái IP bị sàn tạm khóa. Bot đọc `Retry-After` và thời điểm hết khóa trong phản hồi nếu có, lưu thời hạn chờ, không tiếp tục gọi nguồn đó trong thời gian bị khóa. Với 403/451, nguồn được tạm dừng thay vì thử liên tục. Khi tất cả nguồn chưa khả dụng, giao diện hiển thị trạng thái chờ và thời điểm thử lại; không điền giá giả.

Lịch sử được tải trước dù WebSocket lỗi. Nếu WebSocket không hoạt động, bot chuyển sang **REST thật với chu kỳ mục tiêu 5 giây**, còn phụ thuộc độ trễ mạng và số luồng; giao diện ghi rõ chế độ REST và thời gian cập nhật. Đây không phải độ trễ WebSocket 250 ms. REST được xếp hàng, mặc định cách nhau ít nhất 350 ms/yêu cầu trong mỗi tiến trình.

Tác vụ kiểm chứng chạy riêng với heap tối đa 256 MB theo mặc định. Lịch sử được cache riêng từng sàn/cặp/khung ở `data/history`, lần sau chỉ tải dữ liệu mới và làm mới hai nến cuối. Báo cáo cũng tách theo sàn, không lấy tỷ lệ Binance để gán cho tín hiệu OKX. Nên giữ ba cặp mặc định trên máy ít RAM. Cần ổ đĩa bền vững nếu muốn giữ cache, thống kê và thời hạn chờ qua những lần thay container.

Bot chỉ cảnh báo, chưa tự đặt, chốt hoặc dời SL. Các mức entry/SL/TP là **giá tham khảo**, không phải xác nhận khớp lệnh. Có bộ mô phỏng lịch sử để kiểm chứng và lọc thông báo; chưa có số liệu thực chứng minh chiến lược đạt 80%+ trong môi trường xây dựng bị giới hạn API. Không gán điểm hội tụ thành xác suất thắng và không bảo đảm lợi nhuận tương lai.

## Xem tỷ lệ thắng và bộ lọc mục tiêu 80 phần trăm

Mỗi tín hiệu chính thức hiển thị **tỷ lệ thắng lịch sử của nhóm tương tự**, số lệnh mẫu, khoảng Wilson 95% và lãi/lỗ trung bình sau chi phí giả định. Nhóm được tách theo sàn, coin, khung thời gian, LONG/SHORT và nhánh RSI Hook/Pin-bar; không lấy tỷ lệ thắng của BTC LONG để gán cho SOL SHORT. Đây chưa phải mô hình xác suất riêng đã được hiệu chỉnh cho từng lệnh mới.

Thông báo chính thức cần đồng thời đạt:

- Tối thiểu **100 lệnh** trong nhóm trên giai đoạn kiểm chứng.
- **Cận dưới Wilson 95% ≥80%**, thay vì chỉ yêu cầu tỷ lệ đếm thô ≥80%. Ví dụ minh họa: 80 thắng/100 lệnh chưa đủ điều kiện này; 90/100 có cận dưới khoảng 82.6%.
- Lãi/lỗ trung bình sau chi phí giả định **dương**.
- Báo cáo đúng cấu hình và sàn hiện tại, chưa quá 7 ngày, không chứa dữ liệu sau thời điểm tín hiệu.

Khi chưa đủ dữ liệu hoặc không đạt ngưỡng, cơ hội vẫn hiện trong mục **Tín hiệu và cơ hội quan sát**, kèm lý do bị lọc, nhưng không gửi Telegram. Tỷ lệ chưa biết hiển thị “chưa đủ dữ liệu”, không tự điền 80%. Lớp xung lực trong nến được giữ ở mục quan sát vì nến 5m/15m không tái hiện đủ diễn biến để kiểm chứng điểm kích hoạt trong nến. Tín hiệu cũ trong hàng đợi chưa qua kiểm chứng cũng không được gửi lại sau nâng cấp.

Khi kết nối live đã hoạt động, mặc định bot tự chạy kiểm chứng lịch sử trong tiến trình riêng; bảng giá tiếp tục phản hồi. Báo cáo được làm mới sau khoảng một ngày khi bot đang chạy, tối đa một tác vụ đồng thời và một lần thử mỗi giờ nếu lỗi. Có thể đặt `AUTO_CALIBRATE=false` để chỉ chạy thủ công:

```sh
npm run calibrate
```

Mặc định tải 180 ngày lịch sử và thêm nến khởi tạo EMA. Quy tắc giữ cố định; thống kê chỉ lấy **30% giai đoạn cuối**, không tự dò tham số trên tập đó để ép đạt 80%. Báo cáo ở `data/calibration-<sàn>.json`, log ở `data/calibration.log`; file `data/validation-trades-*.jsonl` ghi từng kết quả mô phỏng và được dẫn bằng SHA256 trong báo cáo. Bot tự nạp báo cáo mới, không cần khởi động lại để đọc thống kê. Báo cáo `calibration.json` của bản cũ chỉ được dùng nếu đúng sàn và cấu hình. Nếu sàn từ chối API hoặc lịch sử thiếu, báo cáo mới không được tạo; không thay bằng dữ liệu mô phỏng.

### Quy ước tính thắng

“Thắng” nghĩa là **tổng lãi/lỗ của cả vị thế sau chi phí giả định >0**. Chạm TP1 không tự động được tính thắng. Giá vào mô phỏng là Open của nến kế tiếp, cộng trượt giá bất lợi; bỏ qua nếu giá mở/giá khớp giả định đã vượt SL hoặc TP1. Mô hình chưa tái hiện độ trễ thực tế từ đóng nến đến nhận thông báo.

TP1 chốt 50%, phần còn lại TP2, dời SL về giá khớp giả định sau TP1. Nếu nến chạm cả TP lẫn SL mà không biết thứ tự, dùng cách tính bất lợi; giá Open đã biết được xử lý trước các cực trị trong nến. Gap qua SL khớp ở giá mở bất lợi, gap qua TP không được hưởng giá tốt hơn mức TP. Phần vị thế chưa đóng sau **48 nến** được đóng giả định ở Close của nến thứ 48; kết quả này được đánh dấu `TIME_EXIT` và tính vào thống kê. Bỏ toàn bộ các điểm vào ở cuối dữ liệu không có đủ 48 nến theo dõi, kể cả các lệnh kết thúc sớm, để tránh chọn riêng các kết quả nhanh đã biết.

Chi phí mặc định là **6 bps phí và 2 bps trượt giá cho mỗi lần khớp**, cùng giả định funding luôn bị tính phí 1 bps/8 giờ, quy đổi theo thời gian và tỷ trọng vị thế còn lại. Với lần thoát trong nến chưa rõ thời điểm, phí funding quy đổi cho cả nến theo hướng bảo thủ. Đây không phải biểu phí, funding hoặc giá khớp thật của tài khoản bạn; cần chỉnh theo thực tế trước khi diễn giải hiệu quả. 1 bps = 0.01%.

Khoảng Wilson là tham khảo theo giả định mẫu nhị thức độc lập. Các tín hiệu thị trường có thể tương quan hoặc chồng lấn, và chế độ thị trường có thể thay đổi; cận dưới này không phải bảo đảm rằng xác suất thật của lệnh tiếp theo đạt 80%. Chưa có kiểm chứng paper trading liên tục theo dữ liệu live.

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

Trong `.env`, mặc định `EXCHANGE=okx` và `DATA_SOURCE_MODE=auto`; có thể chọn `binance` hoặc `bybit`. Mỗi phiên dùng một sàn nhất quán; mức TP/SL và thống kê luôn thuộc nguồn được ghi trên giao diện. `DATA_SOURCE_MODE=fixed` tắt việc chọn nguồn dự phòng.

```powershell
npm run check
npm start
```

`check` xác minh nguồn REST và dữ liệu nến; chưa xác minh WebSocket. Sau `npm start`, dashboard ghi rõ đang nhận WebSocket hay đang cập nhật REST. Việc kiểm chứng lịch sử diễn ra riêng; có thể chưa nhóm nào đạt bộ lọc 80% dù luồng giá hoạt động. Telegram báo “đã cấu hình” chỉ có nghĩa là đã điền hai trường; chạy `telegram:check` để kiểm tra chúng, và trạng thái “gửi gần nhất” chỉ xuất hiện sau lần gửi thành công.

Nếu một nguồn bị chặn, chế độ auto chỉ thử nguồn độc lập khác; nguồn bị chặn vẫn tuân thủ thời hạn chờ. Chế độ fixed chờ đúng nguồn đã chọn. Không dùng dữ liệu demo làm dữ liệu thật. Khi mất kết nối thông thường, bot tự kết nối lại và tải lịch sử bù. Giá cũ vẫn được ghi rõ trên dashboard.

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

- Bot ưu tiên WebSocket và có REST dự phòng. Theo tài liệu sàn, Binance kline cập nhật khoảng 250 ms nếu có dữ liệu, OKX nhanh nhất khoảng 1 giây, Bybit 1–60 giây. REST có chu kỳ mục tiêu 5 giây. Đây không phải cam kết thời gian nhận Telegram; còn độ trễ mạng, sự kiện đóng nến, hàng đợi và Telegram.
- Tín hiệu lớp 1 đợi cờ đóng nến. H1/H4 cũng phải đã đóng tại thời điểm tín hiệu; ở ranh giới giờ, bot đợi sự kiện H1 thay vì dùng H1 cũ. Dữ liệu có thể được sàn điều chỉnh sau đó; không có bảo đảm “không repaint 100%”.
- Khi khởi động/khôi phục, tải 650 nến cho mỗi luồng và không phát lại lịch sử như tín hiệu mới. Nếu lịch sử thiếu hoặc đứt đoạn, tạm dừng và đồng bộ lại. Cặp mới niêm yết chưa đủ lịch sử sẽ chưa được hỗ trợ.
- Mặc định dữ liệu một luồng im lặng quá 90 giây sẽ gây kết nối lại. Cảnh báo đóng nến trễ quá 120 giây bị bỏ qua. Tin Telegram chưa gửi hết hạn sau 120 giây từ đóng nến đối với lớp 1, từ phát hiện đối với lớp 2.
- `data/state.json`: ID đã báo, mốc chống spam, 100 tín hiệu gần nhất và hàng đợi Telegram. `data/signals.jsonl`: nhật ký lâu dài, mỗi dòng một tín hiệu.
- Lưu trạng thái qua file tạm và đổi tên. Chỉ chạy **một tiến trình cho mỗi thư mục dữ liệu**; cần sao lưu và theo dõi dung lượng nhật ký khi vận hành lâu dài.
- Telegram thử lại khi lỗi và tuân thủ `retry_after`. Trường hợp Telegram đã nhận tin nhưng tiến trình dừng trước khi lưu xác nhận có thể tạo một tin lặp sau khởi động lại; ID trong tin giúp nhận biết. Chưa có bảo đảm giao tin đúng một lần hoặc nhận ngay tức thì.
- Giữ xác minh TLS và mạng/proxy hợp lệ có sẵn của môi trường. Auto chỉ chọn API công khai của sàn độc lập khác; không đổi IP hoặc tên miền để lách lệnh khóa của một sàn.

## 6. Cấu hình chính

| Biến trong `.env` | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `EXCHANGE` | `okx` | Nguồn ưu tiên: `okx`, `bybit` hoặc `binance`, USDT perpetual |
| `DATA_SOURCE_MODE` | `auto` | `auto` chọn nguồn độc lập khả dụng; `fixed` chỉ một sàn |
| `REST_MIN_INTERVAL_MS` | `350` | Khoảng cách tối thiểu giữa yêu cầu REST mỗi tiến trình |
| `POLL_INTERVAL_SECONDS` | `5` | Chu kỳ mục tiêu khi dùng REST thay WebSocket |
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
| `MIN_WIN_RATE_PERCENT` | `80` | Ngưỡng cận dưới Wilson, cho phép 80–99 |
| `AUTO_CALIBRATE` | `true` | Tự kiểm chứng khi có kết nối live |
| `VALIDATION_HEAP_MB` | `256` | Heap tối đa của tiến trình kiểm chứng |
| `VALIDATION_MIN_SAMPLES` | `100` | Số lệnh tối thiểu mỗi nhóm |
| `VALIDATION_DAYS` | `180` | Số ngày lịch sử tải để kiểm chứng |
| `VALIDATION_MAX_AGE_DAYS` | `7` | Tuổi tối đa của báo cáo |
| `VALIDATION_MAX_HOLD_BARS` | `48` | Hạn giữ vị thế trong mô phỏng |
| `VALIDATION_FEE_BPS` | `6` | Phí giả định cho mỗi lần khớp |
| `VALIDATION_SLIPPAGE_BPS` | `2` | Trượt giá bất lợi giả định mỗi lần khớp |
| `VALIDATION_FUNDING_BPS_8H` | `1` | Chi phí funding giả định mỗi 8 giờ |

Các ngưỡng chiến lược hiện giữ trong `src/config.js` → `RULES`. Đổi cấu hình rồi khởi động lại. Demo dùng thư mục `demo-data` riêng. Không xóa `data` khi nâng cấp nếu muốn giữ chống báo trùng và lịch sử.

## 7. Kiểm thử và cấu trúc mã

```powershell
npm test
```

Kiểm thử bao gồm chỉ báo, LONG/SHORT, chọn HTF theo thời điểm, dữ liệu thiếu/cũ, chống báo trùng, mô phỏng phí và gap/TP/SL, kiểm tra không dùng dữ liệu tương lai, cỡ mẫu và khoảng Wilson, phân trang dữ liệu hai sàn, hàng đợi gửi tin, tác vụ tự kiểm chứng và HTTP dashboard của tiến trình demo. Không dùng tiền thật hoặc gửi Telegram trong kiểm thử.

- `src/market.js`: REST, WebSocket và chuẩn hóa dữ liệu ba sàn.
- `src/provider-health.js`: hàng đợi REST và thời hạn chờ API.
- `src/source-manager.js`: chọn một nguồn dữ liệu nhất quán.
- `src/live-session.js`: bootstrap và chuyển WebSocket sang REST khi cần.
- `src/history-cache.js`: cache và tải bổ sung lịch sử.
- `src/indicators.js`: các chỉ báo có tính nhân quả theo thời gian.
- `src/strategy.js`: điều kiện và các mức giá tham khảo.
- `src/engine.js`: đồng bộ khung lớn, kiểm tra dữ liệu, điều phối tín hiệu.
- `src/store.js`: lưu trạng thái, nhật ký và Telegram.
- `src/main.js`: khởi động, khôi phục kết nối và demo.
- `src/backtest.js`: mô phỏng kết quả lịch sử và chia giai đoạn kiểm chứng.
- `src/validation.js`: thống kê nhóm, khoảng Wilson và điều kiện gửi.
- `src/calibration-job.js`: tác vụ tự kiểm chứng trong tiến trình riêng.
- `scripts/calibrate.js`: lấy lịch sử, tạo báo cáo và nhật ký kết quả.
- `ui/`: dashboard chỉ đọc.

Repository có sẵn workflow `.github/workflows/ci.yml` để chạy kiểm thử và build Docker image khi push hoặc tạo pull request. Workflow không chạy bot liên tục hoặc tự gửi Telegram.

Bộ kiểm thử chạy trong GitHub Actions; Docker image được build trong cùng workflow. Kiểm tra HTTP của tiến trình demo xác nhận sáu bảng giá và trạng thái tỷ lệ chưa biết. Chưa kiểm tra hiển thị trình duyệt tự động trong môi trường xây dựng này.

Đây là cách triển khai mới từ bản mô tả bạn cung cấp. Bản 0.3.0 có công cụ backtest với chi phí giả định và chia giai đoạn theo thời gian. Việc lấy được giá live không chứng minh tỷ lệ thắng 80%; chỉ thống kê từ báo cáo đúng nguồn, đủ mẫu và đạt điều kiện mới được hiển thị là đạt bộ lọc. Chưa có paper trading theo lệnh khớp thật hoặc bảo đảm lợi nhuận.

## Tài liệu API đã đối chiếu

- Binance USDⓈ-M market streams, gồm đường dẫn `/market/stream` và kline: https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market
- Binance REST klines: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data
- Bybit WebSocket kline: https://bybit-exchange.github.io/docs/v5/websocket/public/kline
- Bybit REST kline: https://bybit-exchange.github.io/docs/v5/market/kline
- OKX REST/WS, candle history, volume và rate limits: https://www.okx.com/docs-v5/en/
- Telegram Bot API: https://core.telegram.org/bots/api

