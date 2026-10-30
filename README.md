# Event Tracking QA

**Xem dữ liệu thực tế dạng JSON:** tab Event mặc định hiển thị **Hoạt động · JSON**, mỗi dòng là một lần phát. Bấm **Xem JSON** để xem/sao chép/tải `event`, `default_parameters`, `custom_parameters`; tab **Payload gốc** giữ nguyên cấu trúc đã thu. Không lấy dữ liệu Excel để điền tham số thiếu và không khẳng định đó là dữ liệu đã vào server Insider. Có lịch sử phân trang để không mất event cũ ngoài 100 dòng gần nhất.

**Website lag / không thao tác được khi gắn bộ thu:** kết thúc phiên, bật **Chỉ bắt request · không gắn hook vào website** ở CDP rồi mở phiên mới. Chế độ này không đọc JS queue; kết quả cho tầng chưa quan sát được giữ REVIEW. Bộ chụp queue không gọi getter/toJSON của payload website, giới hạn công việc đồng bộ và đánh dấu rõ bản thu không đầy đủ. Chạy `node scripts/checkout-smoke.mjs` để kiểm tra click đặt hàng và JSON trên trang thử cục bộ; lệnh này không tạo đơn ở website thật.

**Trang chọn 3 chế độ:** chạy `START_EVENT_QA.cmd` hoặc `npm start`. Bản portable: giải nén ZIP và mở `START_PORTABLE.cmd`. Trang chính mở ba lựa chọn CDP không AI / CDP có AI / Proxy. Trong mỗi chế độ, dùng nút chọn file Excel và danh sách sheet; hỗ trợ cả cột **Chi tiết event** (ví dụ sheet **R1511**). Bấm **Xem chi tiết đặc tả** để xem Event Name, mô tả, payload mẫu nguyên văn và từng trường so với event thực tế. Mẫu AppOTA và payload website có thể khác cấu trúc; app hiển thị rõ và không tự chuyển đổi bằng chứng. Xem [hướng dẫn portable](PORTABLE_WINDOWS.md).

Bản triển khai đầu tiên từ [deep-research-report.md](deep-research-report.md). Có **ba chế độ chạy riêng**, dùng chung rule engine, lưu bằng chứng và báo cáo. QC thao tác thủ công trên trình duyệt test; ứng dụng thu thập tự động, không cần F12, Selenium, Playwright hoặc extension.

## Chạy nhanh trên Windows

Máy hiện có Node.js 24, Chrome và Edge. Dependency của dự án đã được cài trong `node_modules`.

Mở [START_EVENT_QA.cmd](START_EVENT_QA.cmd) để chọn phương án (hoặc mở cả ba, mỗi phương án một cửa sổ), hoặc mở trực tiếp `start.cmd` của từng phương án. Giao diện tự mở trong trình duyệt mặc định.

| Phương án | File chạy | Giao diện | Dùng khi |
|---|---|---|---|
| 1. CDP không AI | [solutions/01-cdp-no-ai/start.cmd](solutions/01-cdp-no-ai/start.cmd) | http://127.0.0.1:4173 | Mặc định cho web thật: thấy cả dataLayer/InsiderQueue và request, tự gợi ý endpoint tracking. |
| 2. CDP + OpenRouter | [solutions/02-cdp-ai/start.cmd](solutions/02-cdp-ai/start.cmd) | http://127.0.0.1:4174 | Như 01, thêm AI tạo rule nháp từ đặc tả và giải thích FAIL. |
| 3. Proxy không AI | [solutions/03-proxy-no-ai/start.cmd](solutions/03-proxy-no-ai/start.cmd) | http://127.0.0.1:4175 | Không được bật cổng debug trình duyệt; chỉ cần kiểm request tracking. |

Mã giao diện: [src/web/cdp.html](src/web/cdp.html), [src/web/cdp-ai.html](src/web/cdp-ai.html), [src/web/proxy.html](src/web/proxy.html); CSS và JS dùng chung trong [src/web/shared/](src/web/shared/).

Hoặc chạy tại thư mục dự án:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run cdp -- --open
```

Sau khi clone Git, cấu hình riêng cho AI bằng cách copy `.env.example` thành `.env` rồi điền key của bạn. `.env`, profile, CA, runtime Python và bằng chứng trong `runs/` không nằm trong repository; các lệnh thiết lập Proxy được ghi trong [docs/AI_PROXY.md](docs/AI_PROXY.md).

Dùng `npm.cmd` trong PowerShell để không vướng execution policy của `npm.ps1`. Yêu cầu Node.js **24 trở lên**. Mỗi phương án chỉ chạy một bản: mở lần hai khi bản đầu còn chạy sẽ báo trùng cổng; dùng `STOP_EVENT_QA.cmd` để tắt bản cũ.

## Test trên website thật

Không cần file đặc tả để bắt đầu.

1. **Website & trình duyệt test.** Nhập URL thật, chọn vendor cần bắt (GA4, GA4 server-side, Insider, Meta Pixel, TikTok, Google Ads, Clarity), bấm **Mở trình duyệt test**. Cửa sổ test dùng profile riêng và giữ đăng nhập; website cần đăng nhập thì đăng nhập trong cửa sổ này. URL và vendor được nhớ cho lần sau.
2. **Thu thập tự do.** Tab **Event trực tiếp** gộp event theo tên/tầng/nguồn, đếm số lần, trang và request lỗi. Bấm **⚑ Đặt mốc** trước một thao tác để chỉ xem event phát ra sau đó; **Dòng thời gian** cho xem payload từng event.
3. **Không thấy request?** Tab **Endpoint** liệt kê request trông giống tracking nhưng chưa nằm trong allowlist (chỉ host + path, không lưu payload). Bấm **Theo dõi** để ghi từ request tiếp theo mà không cần mở lại phiên (phương án 01/02).
4. **Tạo rule từ event thật.** Bấm **Tạo rule** trên một event: app liệt kê từng trường với giá trị thực tế và đề xuất cách kiểm (bằng / có mặt / kiểu / regex / lấy từ context). Tham số giao thức GA4 và giá trị thay đổi mỗi lần được bỏ tick; trường đã che chỉ kiểm có mặt. Đổi sang **lấy từ context** cho giá trị phụ thuộc thao tác (từ khoá, mã sản phẩm). Lưu được ngay khi phiên đang chạy.
5. **Kiểm từng thao tác.** Chọn case, điền context, **▶ Bắt đầu bước**, thao tác trên website, **■ Hoàn tất bước** để nhận PASS/FAIL từng tầng.
6. **Kết thúc & xuất** XLSX/HTML/JSON/bug. Chưa có rule vẫn xuất được toàn bộ event.

Rule đã lưu nằm ở `imports/reviewed-cases.json` và được tự nạp khi mở app lần sau. **Mỗi lần chạy lại một case cần bắt đầu bước mới**; `within_ms` tính từ lúc bắt đầu bước.

Rule tạo từ một lần quan sát chỉ phản ánh hành vi hiện tại của website, không thay thế đặc tả nghiệp vụ. HTTP 200 không xác nhận vendor ingestion.

## Đối chiếu với file đặc tả (Martech_WebOTA_….xlsx)

Ở bước 2, nhập đường dẫn file đặc tả rồi bấm **Nhập file**. Nhập được cả khi phiên đang chạy, miễn là chưa ghi bước nào. App đọc sheet **Tổng hợp Event tracking** (STT, Nền tảng, Luồng, Event Name, Event Description, DataLayer Sample, Note) và:

- **tự gắn mọi event bắt được** vào dòng đặc tả cùng nền tảng và tên event, không cần bấm Bắt đầu bước. Khi nhiều luồng cùng tên event (`search_submit`, `listing_page_view`…), luồng được chọn theo giá trị trong payload (`service`, `breadcrumb`, `taxonomy`…) và URL trang (`/flight/`, `/hotel/`…);
- **kiểm từng trường theo DataLayer Sample**, kể cả trường trong `ecommerce.items[0]` và `value[0].event_parameters.custom` của Insider;
- hiện kết quả ở tab **Đối chiếu đặc tả**: Khớp / Lệch / Chưa thấy / Ngoài đặc tả, kèm trường lệch, ghi chú của đặc tả và link tới event;
- xuất sheet **Spec Coverage** trong `report.xlsx`; mỗi dòng lệch thành một bug trong `bugs.md`.

Sample trong đặc tả được đọc kể cả khi có lời mô tả hoặc comment đứng trước, nhiều object trong một ô, `Insider.eventManager.dispatch(...)`, giá trị mô tả chưa đặt trong ngoặc kép hoặc sample bị cắt giữa chừng. Sample không đọc được (hiện 3/168) và sample dán nhầm event khác được ghi vào cảnh báo khi nhập. File có Excel Table (như Martech_AppOTA_Insider) cũng đọc được.

**Tên event Insider** theo đúng đặc tả: InsiderQueue `custom_event` lấy `value[].event_name` (`login_success`, `search_flight`…; một lần push có thể chứa nhiều event); `home` → `homepage_view`, `category` → `listing_page_view`, `product` → `product_detail_page_view`, `cart` → `cart_page_view`, `purchase` → `confirmation_page_view`. Lệnh cấu hình SDK (`init`, `user`, `currency`) mang tên `insider_*`; `{ecommerce: null}` của GTM mang tên `ecommerce_reset`. Request Insider chỉ lấy endpoint gửi event (`unification…/api/event/`, `hit.api…/hit`), bỏ qua file SDK, CSS, ảnh.

Không cần bật gì trên website: app tự đọc `window.dataLayer` và `window.InsiderQueue` (thay cho việc mở F12 gõ `dataLayer` / `InsiderQueue`). Một số website chặn trình duyệt tự động chạy ẩn (headless); cửa sổ test bình thường không bị ảnh hưởng.

**App OTA (iOS/Android, Insider Mobile SDK) chưa được hỗ trợ**: trình duyệt không thấy event của ứng dụng điện thoại.

## Kiểm tra cách bắn event

Tab **Kiểm tra cách bắn** và mục **Cách bắn** trong chi tiết từng event áp dụng các quy tắc rút từ *Insider user guide* và các sheet GA4 trong file Martech. Không cần file đặc tả:

| Quy tắc | Mức | Ý nghĩa |
|---|---|---|
| Insider: dữ liệu trang có `init` theo sau | Lỗi | `home`, `category`, `product`, `cart`, `purchase`, `other` chỉ được Insider gửi thành page view sau `{type: 'init'}`. Push `init` nhiều lần trên một trang là cảnh báo. |
| Đã gửi lên server | Cảnh báo | Event JS phải có request tương ứng trong 30 giây: GA4 `/g/collect` cùng tên event; Insider `unification…/api/event` (`add_to_cart` → `item_added_to_cart`, `remove_from_cart` → `item_removed_from_cart`); page data + `init` → `pageView` trên `hit.api` (body base64 được giải mã). |
| Cấu trúc `custom_event` | Lỗi | `value` là mảng các `{event_name, event_parameters}`. |
| Cặp ngày Insider | Lỗi | `checkin`/`checkin_str`, `departure_date`/`departure_date_str`…: ISO8601 + yyyy-MM-dd, cùng ngày; áp dụng cả tham số `c_` trong request Insider. GA4 không áp dụng vì đặc tả GA4 dùng ngày yyyy-MM-dd không có `_str`. |
| `destination` + `destination_id` | Cảnh báo | Có tên địa điểm thì phải có ID. |
| Không bắn trùng | Lỗi | Cùng event, cùng payload, cùng tab trong 1 giây. |
| GA4 ecommerce | Cảnh báo / Lỗi | Có `{ecommerce: null}` ngay trước; `ecommerce.items` không rỗng, mỗi item có `item_id`, `item_name`. |
| `coupon_interacted.action` | Lỗi | Thuộc `view_list / enter_code / apply_success / apply_failed / remove`. |

Ngoài `dataLayer` và `InsiderQueue`, app còn ghi nhận event Insider bắn qua `Insider.eventManager.dispatch(name, data)` (ví dụ `other_page_view`) và qua đối tượng `window.insider_object` (`page.type` Listing/Product/…, `transaction` → `confirmation_page_view`). Hàm gốc của Insider vẫn chạy bình thường. Báo cáo Excel có sheet **Firing Checks** liệt kê mọi kết quả.

## Chạy thử với trang demo

Bấm **Chưa có website? Chạy thử với trang demo** ở bước 1: app chọn trang demo nội bộ và nạp 3 case mẫu Hotel, Merchandise, Insider. Trên demo, tick **Bỏ destination_id** để có FAIL/MISSING_FIELD ở tầng queue; tick **Bỏ request** ở Insider để có FAIL ở tầng request.

## Specification của bạn

Nhập đường dẫn XLSX và sheet trong giao diện; hoặc dùng CLI:

```powershell
node src/cli.mjs import --spec "F:\duong-dan\Martech_WebOTA_20260501.xlsx" --sheet "Tổng hợp Event tracking" --out imports\rules.json
```

Workbook thật được nhắc trong báo cáo **chưa có trong thư mục này**. Parser nhận header tiếng Việt/Anh, tìm header sau các dòng tiêu đề, giữ `file/sheet/row`, đọc cell merge bằng ExcelJS và phân tích sample như dữ liệu JSON/JSON5, không thực thi JavaScript. Sample có cấu trúc không hỗ trợ được đánh dấu cần review.

Rule nhập từ Excel luôn là bản nháp `needs_review=true`. Dùng **Xem / sửa rule**, sửa mapping và giá trị expected, tick xác nhận đã duyệt rồi lưu. Rule được lưu tại `imports/reviewed-cases.json`; lần sau nhập lại file này. Có thể chỉnh trực tiếp theo [examples/cases.json](examples/cases.json). Sample dynamic không tự biến thành giá trị exact. `search_term=snack` được so với `context.search.term`, không với sample `keychain`.

Các phép so sánh: `eq`, `exists`, `not_exists`, `type`, `regex`, `one_of`, `range`, `ref`, `subset`, `ignore`; hỗ trợ count, duplicate, thứ tự `after`, `within_ms`, nested paths và array index. Xem [docs/RULES.md](docs/RULES.md).

## Lưu và khôi phục bằng chứng

```text
runs/<session-id>/
  session.json       # metadata, các bước, kết quả
  expected.json      # bản specification đã che dữ liệu tại lúc bắt đầu phiên
  events.jsonl       # ghi append + fsync trước khi cập nhật SQLite
  steps.jsonl        # vòng đời bước; bằng chứng cho event bị thiếu
  eventqa.db         # SQLite WAL, index có thể dựng lại từ JSONL
  report.xlsx       # Run Summary / Test Cases / Expected Events /
                    # Actual Events / Comparison / Bug Reports
  report.html
  comparison.json
  bugs.md
```

Event lịch sử khi attach được lưu nhưng không gắn vào bước đang chạy. Response/failure gắn cùng request và không bị đếm là event lần hai. Mỗi issue có evidence ID của event hoặc bước. `NOT_EXECUTED` không thành FAIL; rule chưa duyệt/thiếu context trả REVIEW. Proxy không quan sát JS queue nên trả REVIEW/LAYER_UNAVAILABLE cho tầng này.

Xuất lại từ một phiên cũ:

```powershell
node src/cli.mjs report --run "runs\S-..."
```

CLI dùng `expected.json` của phiên; có thể cung cấp `--spec` khi muốn dùng specification khác hoặc với phiên cũ. SQLite được dựng lại từ JSONL khi đọc phiên; dòng cuối bị ghi dở được tách vào `events.torn-tail`, giữ các dòng hoàn chỉnh. Không sửa/xóa evidence trong phiên đang chạy.

## OpenRouter và Proxy

- Phương án 2 đã cấu hình key được cung cấp tại `.env` và bật AI. Trên máy mới, copy `.env.example` thành `.env`, điền key rồi bật `AI_ENABLED=true`. Chế độ `auto` thử model miễn phí trước, sau đó chọn model trả phí phù hợp có chi phí ước tính thấp nhất theo giá catalog hiện tại. Đã gọi thật thành công cả model miễn phí và Mistral Nemo trả phí; xem [bằng chứng AI](runs/ai-smoke/observations.json) và [probe model](runs/ai-smoke/targeted-probes.json).
- Model timeout, quá tải, không có provider hoặc JSON không hợp lệ được chuyển sang model tiếp theo. Key sai/hết credit được chuyển sang các key dự phòng trong `OPENROUTER_API_KEYS` (phân tách bằng dấu phẩy). Hiện chỉ có một key được cung cấp; thử đổi key bằng mock đã đạt. Key thiếu credit trả phí vẫn giữ để gọi free. Không thay verdict; rule nháp luôn cần QC duyệt.
- Cấu hình hiện tại tối đa 6 model/tác vụ, trong đó thử 2 free trước; giá input ≤0,25 USD/triệu token, output ≤1 USD/triệu token, ngân sách ước tính tổng ≤0,01 USD/tác vụ. Giá provider được chặn theo giá từng candidate để tránh tăng giá khi fallback. Đây là giới hạn mỗi tác vụ, không phải hạn mức tổng tài khoản. Có thể tắt trả phí bằng `OPENROUTER_ALLOW_PAID=false`. Xem [docs/AI_PROXY.md](docs/AI_PROXY.md).
- Phương án 3 cần `mitmdump.exe`; bản 12.3.1 đã được cài riêng trong `.venv-proxy` tại dự án này và app tự nhận diện. Chỉ chạy proxy tại localhost, không tự cài CA hay đổi proxy hệ thống. HTTPS dùng được ngay: chỉ cửa sổ test do app mở tin đúng khoá CA proxy cố định trong `profiles/mitmproxy/`. Có thể chỉ định đường dẫn executable trong giao diện. Xem [docs/AI_PROXY.md](docs/AI_PROXY.md).
- Các endpoint ngoài GA4/Insider cần thêm regex ở ô **Endpoint bổ sung**. Regex đối chiếu `hostname + pathname`, không đối chiếu query. Payload không hỗ trợ chỉ giữ `UNPARSED`, hash và lý do; không suy đoán mã hóa.

## Kiểm chứng

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run demo
node src/cli.mjs demo --failure
node scripts/local-smoke.mjs
npm.cmd run smoke:proxy
npm.cmd run smoke:proxy:https
npm.cmd run smoke:ai
```

Unit tests không gửi request ra ngoài. `scripts/local-smoke.mjs` chạy Chrome thật với website demo localhost và tạo screenshot/báo cáo. Có thể chọn Edge bằng biến môi trường `EVENTQA_SMOKE_BROWSER=edge`. Smoke Trip thật là tùy chọn `EVENTQA_LIVE_CDP=1` khi chạy `tests/cdp-live.test.mjs`.

Các test cần WebSocket Chrome hoạt động ngoài giới hạn sandbox. Trong môi trường Codex hiện tại, sandbox có thể đóng WebSocket 1006; chạy smoke được cấp quyền ngoài sandbox đã kiểm chứng thành công. Đây không phải tùy chọn bỏ qua bảo mật browser.

## Dừng, cleanup và xử lý lỗi

- **Dừng:** hoàn tất bước, kết thúc phiên rồi Ctrl+C trong cửa sổ `start.cmd`. Với ba ứng dụng nền đã mở sẵn trong lần triển khai này, chạy `STOP_EVENT_QA.cmd`; script chỉ dừng app có PID/mode khớp và không có phiên đang chạy. Trình duyệt test có thể đóng thủ công. App không đóng các trình duyệt cá nhân đang mở.
- **Không attach được:** kiểm tra debug port, phiên test dùng profile riêng, executable Chrome/Edge và firewall. Xem [docs/CDP.md](docs/CDP.md). Edge policy `RemoteDebuggingAllowed=0` cần IT xử lý, không bypass policy.
- **Không có request:** kiểm tra allowlist, consent/cookie banner, ad blocker và thao tác đã gửi tracking chưa. Queue và request được báo riêng.
- **Context thiếu:** REVIEW/CONTEXT_MISSING; sửa JSON context rồi thực hiện bước mới.
- **Trùng port:** dừng app cũ hoặc dùng `--port`; mỗi phiên test cần debug/proxy port riêng. Phương án 1 và 2 mặc định dùng CDP 9222 và 9223.
- **Proxy báo thiếu executable:** cài dependency tùy chọn hoặc chỉ định `mitmdump.exe`; dùng CDP trong lúc chưa cấu hình Proxy.
- **Reset đăng nhập:** đóng toàn bộ cửa sổ dùng profile test đó rồi xóa đúng thư mục con tương ứng trong `profiles/`. Thao tác này làm mất phiên đăng nhập test.
- **Cleanup:** sau khi giữ report cần thiết, có thể xóa thủ công các thư mục phiên trong `runs/`, cache `.cache/`, hoặc profile test cụ thể. Không đụng profile Chrome/Edge cá nhân và không tự gỡ CA của tổ chức. Xoá `profiles/mitmproxy/` để bỏ CA proxy của app (lần sau tạo CA mới).

Đây là bản đầu tiên có thể chạy và kiểm thử, chưa phải bản đóng gói EXE. Chưa thể xác nhận workbook/flow của hệ thống nội bộ khi chưa có file và phiên thao tác thực tế.
