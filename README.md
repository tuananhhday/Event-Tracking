# Event Tracking QA

Ứng dụng có **hai bản**: **bản thường** và **bản AI**. Cả hai bắt event giống hệt nhau, dùng chung rule engine, lưu bằng chứng và báo cáo; bản AI có thêm trợ lý giải thích bằng tiếng Việt. QC thao tác thủ công trên trình duyệt test; ứng dụng thu thập tự động, không cần F12, Selenium, Playwright hoặc extension.

## Chạy nhanh trên Windows

Với **gói Windows đầy đủ**, giải nén toàn bộ rồi bấm [CHAY_EVENT_QA.cmd](CHAY_EVENT_QA.cmd) (bản thường) hoặc [CHAY_EVENT_QA_AI.cmd](CHAY_EVENT_QA_AI.cmd) (bản AI). Ứng dụng tự mở giao diện trong trình duyệt; không cần cài Node hay chạy lệnh npm. Gói này có sẵn `runtime/node.exe` và `node_modules`. Website test cần Chrome hoặc Edge trên máy. Giữ cửa sổ lệnh đang chạy; dùng [STOP_EVENT_QA.cmd](STOP_EVENT_QA.cmd) để dừng.

Muốn chọn bản, mở [scripts/choose-mode.cmd](scripts/choose-mode.cmd) (hoặc mở cả hai, mỗi bản một cửa sổ), hoặc mở trực tiếp `start.cmd` của từng bản. Giao diện tự mở trong trình duyệt mặc định.

| Bản | File chạy | Giao diện | Dùng khi |
|---|---|---|---|
| 1. Bản thường | [CHAY_EVENT_QA.cmd](CHAY_EVENT_QA.cmd) | http://127.0.0.1:4173 | Mặc định: đọc `dataLayer`/`InsiderQueue` và request GA4/Insider, đối chiếu file đặc tả. |
| 2. Bản AI | [CHAY_EVENT_QA_AI.cmd](CHAY_EVENT_QA_AI.cmd) | http://127.0.0.1:4174 | Như bản thường, thêm **✦ AI kiểm tra cả phiên** (đọc yêu cầu của bạn, file đặc tả và các event đã gửi lên server rồi chỉ ra đúng / sai / thiếu / đang có vấn đề), **✦ AI giải thích** từng event/lỗi bằng tiếng Việt và tạo rule từ mô tả. Xem [hướng dẫn bản AI](docs/AI.md). |

Mã giao diện: [src/web/cdp.html](src/web/cdp.html), [src/web/cdp-ai.html](src/web/cdp-ai.html); CSS và JS dùng chung trong [src/web/shared/](src/web/shared/).

**Chi tiết event:** giao diện workspace của bản portable cũ được giữ lại. Bấm event để xem tên, Event Details (Platform / Date / Time UTC), Default Parameters và Custom Parameters; dữ liệu lồng nhau có Show Details. JSON tham số và payload gốc nằm ở tab riêng. GA4 `pr1`, `pr2` được giải mã thành sản phẩm và tham số tùy chỉnh; mã vận chuyển GA4 không chen vào bảng nghiệp vụ. Queue/request phù hợp được ghép một-một thành một dòng bằng chứng; các request thực sự lặp vẫn giữ riêng. Importer tiếp tục hỗ trợ mẫu JSON, Swift/Java SDK và text Insider. Xem [chi tiết cấu trúc event](docs/EVENT_STRUCTURES.md).

Nếu lấy **mã nguồn từ Git** thay vì gói Windows đầy đủ, cài Node.js 24+ rồi chạy tại thư mục dự án:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run cdp -- --open
```

Sau khi clone Git, cấu hình riêng cho AI bằng cách copy `.env.example` thành `.env` rồi điền key của bạn. `.env`, profile và bằng chứng trong `runs/` không nằm trong repository.

Dùng `npm.cmd` trong PowerShell để không vướng execution policy của `npm.ps1`. Yêu cầu Node.js **24 trở lên**. Mỗi bản chỉ chạy một tiến trình: mở lần hai khi bản đầu còn chạy sẽ báo trùng cổng; dùng `STOP_EVENT_QA.cmd` để tắt bản cũ.

## Test trên website thật

Không cần file đặc tả để bắt đầu.

1. **Website & trình duyệt test.** Nhập URL thật, chọn vendor cần bắt (GA4, GA4 server-side, Insider, Meta Pixel, TikTok, Google Ads, Clarity), bấm **Mở trình duyệt test**. Cửa sổ test dùng profile riêng và giữ đăng nhập; website cần đăng nhập thì đăng nhập trong cửa sổ này. URL và vendor được nhớ cho lần sau.
2. **Thu thập tự do.** Tab **Event trực tiếp** có bốn cách xem: **Đã gửi lên server** (mặc định: mỗi dòng là một event Google/Insider đã nhận, kèm mã GA4 `G-…`; event gửi lặp có nhãn **⚠ Lặp lại sau X s**), **dataLayer · InsiderQueue (F12)** (từng phần tử theo đúng thứ tự như gõ `dataLayer` / `InsiderQueue` trong F12 Console, kèm đã gửi lên server hay chưa), **Gộp theo event** (số lần, trang, request lỗi) và **Dòng thời gian** (payload từng event). Bấm **⚑ Đặt mốc** trước một thao tác để chỉ xem event phát ra sau đó.
3. **Không thấy request?** Tab **Endpoint** liệt kê request trông giống tracking nhưng chưa nằm trong allowlist (chỉ host + path, không lưu payload). Bấm **Theo dõi** để ghi từ request tiếp theo mà không cần mở lại phiên.
4. **Tạo rule từ event thật.** Bấm **Tạo rule** trên một event: app liệt kê từng trường với giá trị thực tế và đề xuất cách kiểm (bằng / có mặt / kiểu / regex / lấy từ context). Tham số giao thức GA4 và giá trị thay đổi mỗi lần được bỏ tick; trường đã che chỉ kiểm có mặt. Đổi sang **lấy từ context** cho giá trị phụ thuộc thao tác (từ khoá, mã sản phẩm). Lưu được ngay khi phiên đang chạy.
5. **Kiểm từng thao tác.** Chọn case, điền context, **▶ Bắt đầu bước**, thao tác trên website, **■ Hoàn tất bước** để nhận PASS/FAIL từng tầng.
6. **Kết thúc & xuất** XLSX/HTML/JSON/bug. Chưa có rule vẫn xuất được toàn bộ event.

Rule đã lưu nằm ở `imports/reviewed-cases.json` và được tự nạp khi mở app lần sau. **Mỗi lần chạy lại một case cần bắt đầu bước mới**; `within_ms` tính từ lúc bắt đầu bước.

Rule tạo từ một lần quan sát chỉ phản ánh hành vi hiện tại của website, không thay thế đặc tả nghiệp vụ. HTTP 200 không xác nhận vendor ingestion.

## Đối chiếu với file đặc tả (Martech_WebOTA_….xlsx)

Ở bước 2, nhập đường dẫn file đặc tả rồi bấm **Nhập file**. Nhập được cả khi phiên đang chạy, miễn là chưa ghi bước nào. App đọc sheet **Tổng hợp Event tracking** (STT, Nền tảng, Luồng, Event Name, Event Description, DataLayer Sample, Note) và:

- **tự gắn mọi event bắt được** vào dòng đặc tả cùng nền tảng và tên event, không cần bấm Bắt đầu bước. Khi nhiều luồng cùng tên event (`search_submit`, `listing_page_view`…), luồng được chọn theo giá trị trong payload (`service`, `breadcrumb`, `taxonomy`…) và URL trang (`/flight/`, `/hotel/`…);
- **kiểm từng trường trên dữ liệu đã gửi lên server**: event GA4 được kiểm trên hit Google nhận được (kể cả `ecommerce.items[0]`), event Insider kiểm trên dữ liệu push vào InsiderQueue (`value[0].event_parameters.custom`…) khi Insider đã gửi nó đi. Trường website có push nhưng Google không nhận được báo riêng là **Google không nhận** (lỗi cấu hình tag GA4 trong GTM, không phải lỗi Dev website);
- hiện kết quả ở tab **Đối chiếu đặc tả**: Khớp / Lệch / **Có push, không gửi lên server** / Chưa thấy / Ngoài đặc tả, kèm trường lệch, ghi chú của đặc tả và link tới event;
- xuất sheet **Spec Coverage** trong `report.xlsx`; mỗi dòng lệch hoặc có push nhưng không gửi thành một bug trong `bugs.md`.

Mọi sheet có cột Event Name + cột mẫu đều nhập được (chọn sheet ở bước 2), không chỉ sheet tổng hợp. Cách các file Martech được soạn đều đọc được:

- **Tên event**: `03. view_item_list`, `product_detail_page_view (Hotel)` (phần trong ngoặc thành luồng), `purchase / confirmation_page_view` (hai tên), tên hiển thị Insider `Listing Page View`.
- **Cột mẫu**: `DataLayer Sample`, `Sample Payload`, `DataLayer`, `Sample DataLayer (mới)`, `New DataLayer Sample`; ô mẫu mới ghi "Không đổi" thì dùng cột mẫu cũ (`Old … Sample`, `… cũ`).
- **Ô mẫu**: có lời mô tả hoặc comment `//` đứng trước, nhiều object trong một ô (chọn object đúng event, kể cả theo `type` Insider), `dataLayer.push({ecommerce: null})` trước event, `insider_object = {...}`, `Insider.eventManager.dispatch(...)`, request Insider `{partner, events: [...]}`, mẫu bị cắt giữa chừng.
- **Lỗi gõ tay trong ô mẫu**: thiếu dấu phẩy giữa hai trường, `;` thay cho `,`, ghi chú `-- …` hoặc `(…)` sau giá trị, dòng `...` giữ chỗ, dư dấu nháy (`"abc"",`), thiếu `{ }` bao ngoài, ô dán từ CSV (`""event""`), ngày chưa có nháy.
- **Sheet hướng dẫn** (Insider user guide): chỉ lấy bảng event; phần giải thích và bảng tra cứu tham số phía sau bị bỏ qua. Sheet không có cột mẫu (bảng tham số, bảng audit) không được coi là đặc tả.

Mẫu hỏng cấu trúc (thiếu `[`/`{`, nối chuỗi bằng `+`) và mẫu dán nhầm event khác được ghi vào cảnh báo khi nhập; app không đoán cấu trúc. File có Excel Table và ô merge (như Martech_AppOTA_Insider) cũng đọc được.

Đã kiểm bằng cách bắn lại chính mẫu của từng dòng qua collector: 587/642 dòng của Martech_WebOTA_20260501 (sheet tổng hợp 166/168) gắn đúng dòng của nó. Các dòng còn lại là lỗi trong file: mẫu trống/hỏng, mẫu của event khác (ví dụ `search_combo` dán request `flight_changed`), `type` gõ sai (`item_revmoved_from_cart`, `listing` thay cho `category`).

**Tên event Insider** theo đúng đặc tả: InsiderQueue `custom_event` lấy `value[].event_name` (`login_success`, `search_flight`…; một lần push có thể chứa nhiều event); `home` → `homepage_view`, `category` → `listing_page_view`, `product` → `product_detail_page_view`, `cart` → `cart_page_view`, `purchase` → `confirmation_page_view`; `add_to_cart`, `remove_from_cart` và `item_added_to_cart`, `item_removed_from_cart` (Golf, Vui chơi, Train dùng type này) giữ nguyên tên. `type` không thuộc danh sách này hiện là `insider_<type>` để thấy ngay push gõ sai. Hit page view Insider gửi lên server (`hit.api…/hit`, `pageView`) đặt tên theo `page_type`: `main` → `homepage_view`, `category` → `listing_page_view`, `productDetail` → `product_detail_page_view`, `cart` → `cart_page_view`, `other` → `other_page_view`. Danh sách hiển thị event Insider bằng tên Insider ghi nhận (**Homepage View**, **Listing Page View**, **Product Page View**, **Item Added to Cart**…) với Default Parameters / Custom Parameters, giống cách viết của sheet R1511. `insider_object` có `page.type` (Listing, Product…) hoặc `transaction` là page view tương ứng. Lệnh cấu hình SDK (`init`, `user`, `currency`) mang tên `insider_*`; `{ecommerce: null}` của GTM mang tên `ecommerce_reset`. Request Insider chỉ lấy endpoint gửi event (`unification…/api/event/`, `hit.api…/hit`), bỏ qua file SDK, CSS, ảnh.

Không cần bật gì trên website: app tự đọc `window.dataLayer` và `window.InsiderQueue` (thay cho việc mở F12 gõ `dataLayer` / `InsiderQueue`). Một số website chặn trình duyệt tự động chạy ẩn (headless); cửa sổ test bình thường không bị ảnh hưởng.

### Cách app lấy event từ dataLayer và InsiderQueue

App gắn một đoạn script vào trang test (qua Chrome DevTools Protocol, trước khi website chạy) để ghi lại mọi lần website gọi `dataLayer.push(...)` và `InsiderQueue.push(...)`, đúng lúc gọi, giữ nguyên payload:

- **Insider SDK và GTM thay hàm `push` sau khi tải.** Trên vinpearlota.com, Insider SDK gán `InsiderQueue.push` bằng hàm riêng gọi thẳng `Array.prototype.push`; bản trước chỉ gắn lại hook sau mỗi 500 ms nên mất các push trong khoảng đó (ví dụ `init`). Nay `push` là getter/setter: khi vendor gán hàm mới, app giữ hàm đó và luôn ghi trước khi gọi, không có khoảng hở. Đã kiểm trên trang thật: trang chủ và chuyển trang SPA bắt đủ 5/5 item `dataLayer`, 7/7 item `InsiderQueue`.
- **`Insider.eventManager.dispatch(name, data)`** chỉ lấy event tracking (ví dụ `other_page_view`); tín hiệu nội bộ của SDK có dấu `:` trong tên (`web-sdk:log`, `hit:userEvent:sent`, `predictive:loaded`…) bị bỏ qua.
- **Request Insider** chỉ lấy endpoint gửi event: `hit.api.useinsider.com/hit` (page view) và `unification.useinsider.com/api/event/` (custom event, giỏ hàng). Request lấy segment, dữ liệu user, log của SDK không phải event và không được ghi.
- **Chỉ tính event đã thực sự gửi lên server.** Push vào dataLayer/InsiderQueue mới chỉ là website đưa dữ liệu cho GTM/Insider SDK; event chỉ được tính là đã bắn khi có request mang nó lên Google/Insider. Mỗi push được ghép với đúng request đã gửi nó: GA4 `/g/collect` cùng tên event (GA4 gom event, thường gửi sau 1–5 giây), Insider `pageView` sau `init` cho dữ liệu trang, `item_added_to_cart`… cho giỏ hàng, tên event cho custom event. Push không có request trong 10 giây là **Không gửi lên server**: ẩn khỏi danh sách mặc định (có cảnh báo số lượng và ô tick để xem), tính là lỗi khi đối chiếu đặc tả và trong báo cáo. Event GA4 hiển thị tham số **Google nhận được** (`page_location`, `page_title`, tham số `ep.*`, items); tab **Website push** trong chi tiết event cho xem dữ liệu dataLayer để so.
- **Thấy giống F12.** Mỗi phần tử được chụp ngay sau khi website push xong, nên có cả trường GTM tự thêm (`gtm.uniqueEventId`) như khi gõ `dataLayer` trong F12 Console, và giữ vị trí trong mảng (`dataLayer[12]`). Cách xem **dataLayer · InsiderQueue (F12)** liệt kê mỗi phần tử đúng một lần, theo thứ tự. Muốn thấy đủ như F12 thì **không tick** “Không đọc dataLayer / InsiderQueue” ở bước 1: khi tick, app chỉ thấy request gửi lên server, không thấy push nào (chỉ dùng khi website bị lag).
- **Gửi lặp** là cùng hệ thống (Google hoặc Insider), cùng mã GA4, cùng event, cùng trang (URL chỉ khác tham số) trong vòng 10 giây: dòng sau có nhãn **⚠ Lặp lại sau X s** và tab **Kiểm tra cách bắn** có cảnh báo. Page view của Google và của Insider trên cùng trang là hai hệ thống khác nhau, không phải lặp; website gửi cùng event tới hai mã GA4 (`G-…`) cũng không phải lặp. Ví dụ thật trên luồng Golf: GA4 nhận `page_view` hai lần trong cùng một request khi URL đổi từ `?date=…` sang `?date=…&teetimes=…`; Insider nhận Product Page View hai lần cách nhau 4,1 giây.
- **Không lấy những thứ không phải event của website**: bản sao Google Signals gửi tới `stats.g.doubleclick.net/g/collect` (không có tên event), hit `user` của Insider (đồng bộ thuộc tính người dùng), tín hiệu nội bộ của Insider SDK qua `dispatch` (`userLocationSet`, `web-sdk:log`…). Event GA4 tự động như `form_start`, `user_engagement` vẫn được giữ vì Google thật sự nhận chúng.
- **Đã kiểm trên vinpearlota.com (01/11/2026)** bằng cách so với mọi request thật rời trình duyệt: công cụ khớp đủ hit Google/Insider. Phát hiện thật: `page_view` lên Google chỉ có URL + tiêu đề trang, `page_type` website push nhưng GTM không gửi; `search_result_list` có trong dataLayer nhưng **không được gửi lên Google**.

Chi tiết kỹ thuật: [docs/CDP.md](docs/CDP.md).

**Sheet dạng Insider (Martech_AppOTA_Insider, sheet R1511…)**: mỗi dòng mô tả event như Insider ghi nhận, ví dụ `{event: "Product Page View", default_parameters: {...}, custom_parameters: {...}}`. App đổi hit Insider của website sang đúng dạng đó (`pageView` + `productDetail` → **Product Page View** với `product_id`, `taxonomy`, `unit_price`…; `item_added_to_cart` → **Item Added to Cart**, `pid` → `product_id`, `c_tee_time` → `custom_parameters.tee_time`…) rồi kiểm từng trường; các trường chỉ app có (`app_version`, `device_manufacturer`, `device_model`, `os_version`, `platform`) được bỏ qua. Luồng Golf trên vinpearlota.com (01/11/2026): Product Page View, Item Added to Cart, Cart Page View **Khớp**; Listing Page View **Lệch** (`taxonomy` gửi `Golf`, đặc tả `golf`; thiếu `breadcrumb`). Event chỉ app iOS/Android gửi (trình duyệt không thấy) ở trạng thái **Chưa thấy**; push dataLayer hoặc hit GA4 trùng tên là REVIEW (khác nền tảng), không bị tính là lỗi website.

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
| Không gửi lặp lên server | Cảnh báo | Cùng hệ thống, cùng mã GA4, cùng event, cùng trang (URL chỉ khác tham số) trong 10 giây. |
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

Parser nhận header tiếng Việt/Anh ở bất kỳ dòng nào, giữ `file/sheet/row`, đọc cell merge bằng ExcelJS và phân tích sample như dữ liệu JSON/JSON5, không thực thi JavaScript. Sample có cấu trúc không hỗ trợ được đánh dấu cần review.

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

Event lịch sử khi attach được lưu nhưng không gắn vào bước đang chạy. Response/failure gắn cùng request và không bị đếm là event lần hai. Mỗi issue có evidence ID của event hoặc bước. `NOT_EXECUTED` không thành FAIL; rule chưa duyệt/thiếu context trả REVIEW. Phiên mở với **Không đọc dataLayer / InsiderQueue** không quan sát JS queue nên trả REVIEW/LAYER_UNAVAILABLE cho tầng này.

Xuất lại từ một phiên cũ:

```powershell
node src/cli.mjs report --run "runs\S-..."
```

CLI dùng `expected.json` của phiên; có thể cung cấp `--spec` khi muốn dùng specification khác hoặc với phiên cũ. SQLite được dựng lại từ JSONL khi đọc phiên; dòng cuối bị ghi dở được tách vào `events.torn-tail`, giữ các dòng hoàn chỉnh. Không sửa/xóa evidence trong phiên đang chạy.

## Bản AI (OpenRouter)

- Bật AI: chạy `CHAY_EVENT_QA_AI.cmd`, mở tab **✦ Trợ lý AI**, dán key OpenRouter, bấm **Bật AI** (key lưu vào `.env`, không cần khởi động lại). Hướng dẫn đầy đủ bằng lời thường: [docs/AI.md](docs/AI.md).
- **✦ AI kiểm tra cả phiên** (tab **✦ Trợ lý AI**): ghi yêu cầu kiểm tra (không bắt buộc), bấm **✦ AI kiểm tra phiên này**. AI đọc yêu cầu, các dòng đặc tả của luồng đang test, kết quả công cụ tự kiểm và các event đã gửi lên Google/Insider, rồi trả về **Đúng / Sai / Thiếu / Đang có vấn đề / Nên làm tiếp**. Ba danh sách Đúng / Sai / Thiếu luôn theo kết quả công cụ; AI chỉ viết lời giải thích.
- **✦ AI giải thích event này** (trong chi tiết mỗi event): event là gì, có khớp đặc tả không, vấn đề cụ thể, việc Dev/QC cần làm. Bước ra FAIL được AI tự giải thích. Tab **✦ Trợ lý AI** tạo rule nháp từ tên event + mô tả + payload mẫu dán từ Excel, hiển thị bằng tiếng Việt.
- AI không đổi kết luận: khớp/lệch do rule engine quyết định, AI chỉ diễn giải. Rule nháp luôn cần QC duyệt. Dữ liệu nhạy cảm được che trước khi gửi.
- Chế độ `auto` thử model miễn phí trước, sau đó model trả phí rẻ nhất trong giới hạn: tối đa 6 model/tác vụ (2 free trước), giá input ≤0,25 USD/triệu token, output ≤1 USD/triệu token, ngân sách ≤0,01 USD/tác vụ. `OPENROUTER_ALLOW_PAID=false` để chỉ dùng free. Key sai/hết credit chuyển sang key dự phòng trong `OPENROUTER_API_KEYS`.
- Các endpoint ngoài GA4/Insider cần thêm regex ở ô **Endpoint bổ sung**. Regex đối chiếu `hostname + pathname`, không đối chiếu query. Payload không hỗ trợ chỉ giữ `UNPARSED`, hash và lý do; không suy đoán mã hóa.

## Kiểm chứng

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run demo
node src/cli.mjs demo --failure
node scripts/local-smoke.mjs
npm.cmd run smoke:checkout
npm.cmd run smoke:ai
```

Unit tests không gửi request ra ngoài. `scripts/local-smoke.mjs` chạy Chrome thật với website demo localhost và tạo screenshot/báo cáo. Có thể chọn Edge bằng biến môi trường `EVENTQA_SMOKE_BROWSER=edge`. `smoke:checkout` bấm nút đặt hàng thật trên trang localhost và xác nhận collector không gọi getter/`toJSON` của website và không làm treo thao tác. Smoke Trip thật là tùy chọn `EVENTQA_LIVE_CDP=1` khi chạy `tests/cdp-live.test.mjs`.

Các test cần WebSocket Chrome hoạt động ngoài giới hạn sandbox. Trong môi trường Codex hiện tại, sandbox có thể đóng WebSocket 1006; chạy smoke được cấp quyền ngoài sandbox đã kiểm chứng thành công. Đây không phải tùy chọn bỏ qua bảo mật browser.

## Dừng, cleanup và xử lý lỗi

- **Dừng:** hoàn tất bước, kết thúc phiên rồi Ctrl+C trong cửa sổ `start.cmd`. Với các ứng dụng đang chạy nền, chạy `STOP_EVENT_QA.cmd`; script chỉ dừng app có PID/mode khớp và không có phiên đang chạy. Trình duyệt test có thể đóng thủ công. App không đóng các trình duyệt cá nhân đang mở.
- **Không attach được:** kiểm tra debug port, phiên test dùng profile riêng, executable Chrome/Edge và firewall. Xem [docs/CDP.md](docs/CDP.md). Edge policy `RemoteDebuggingAllowed=0` cần IT xử lý, không bypass policy.
- **Không có request:** kiểm tra allowlist, consent/cookie banner, ad blocker và thao tác đã gửi tracking chưa. Queue và request được báo riêng.
- **Context thiếu:** REVIEW/CONTEXT_MISSING; sửa JSON context rồi thực hiện bước mới.
- **Trùng port:** dừng app cũ hoặc dùng `--port`; mỗi phiên test cần debug port riêng. Bản thường và bản AI mặc định dùng CDP 9222 và 9223.
- **Reset đăng nhập:** đóng toàn bộ cửa sổ dùng profile test đó rồi xóa đúng thư mục con tương ứng trong `profiles/`. Thao tác này làm mất phiên đăng nhập test.
- **Cleanup:** sau khi giữ report cần thiết, có thể xóa thủ công các thư mục phiên trong `runs/`, cache `.cache/`, hoặc profile test cụ thể. Không đụng profile Chrome/Edge cá nhân.

Đây là bản đầu tiên có thể chạy và kiểm thử, chưa phải bản đóng gói EXE. Chưa thể xác nhận workbook/flow của hệ thống nội bộ khi chưa có file và phiên thao tác thực tế.
