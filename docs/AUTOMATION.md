# Luồng tự động

Bản AI có tab **Luồng tự động** để thực hiện các thao tác trên website, thu thập event/API bằng collector hiện có và xuất báo cáo sau lượt chạy. Bạn đưa kịch bản vào (file hoặc gõ), AI chạy thử một lần trên trình duyệt thật và ghi lại kịch bản; các lần sau Playwright chạy lại kịch bản đã lưu, thủ công hoặc theo lịch.

Luồng làm việc:

1. **Kịch bản** — file `.txt`/`.md` hoặc gõ trực tiếp, mỗi bước là một tiêu đề `BƯỚC 01 - …` hoặc một dòng `1. …`; dữ liệu dùng lại viết dạng `ten_bien = giá trị`.
2. **AI chạy thử & tạo kịch bản** — app mở Chrome/Edge test, bật thu thập event, rồi với từng bước: chụp danh sách phần tử đang hiển thị (đánh số), AI chọn phần tử theo số, Playwright thực hiện, app ghi lại một locator **đã kiểm chứng chỉ khớp đúng phần tử đó** (ưu tiên test id, role + tên, label; nút trùng tên như nhiều “Đặt ngay” được khoanh theo card chứa tên gói). Tiến độ và lý do của AI hiện trực tiếp, có thể dừng bất cứ lúc nào.
3. **Xem lại & lưu** — các bước, giá trị (đã đổi về `{{bien}}`), event GA4/Insider thấy được ở từng bước khi chạy thử. Bật lịch nếu muốn chạy hằng ngày.
4. **Chạy lại** — Playwright chạy kịch bản đã lưu, gom event gửi lên GA4/Insider/TP2 theo từng bước, xuất báo cáo. Không gọi AI, trừ khi một bước đã ghi không còn khớp trang và luồng bật **AI tự sửa**.

Báo cáo của lượt chạy tự động dùng nhận xét của công cụ. Nếu cần nhận xét AI, mở phần **Kết thúc & báo cáo**, chọn **Kèm nhận xét AI khi xuất** và xuất lại.

## Thử nhanh bằng trang demo

1. Chạy `CHAY_EVENT_QA_AI.cmd`, vào tab **Luồng tự động**.
2. Bấm **Chọn file kịch bản**, chọn [automation-demo.json](../examples/automation-demo.json), rồi bấm **Nạp JSON**.
3. Xem lại website bắt đầu. File mẫu dùng `http://127.0.0.1:4174/demo`; đổi cổng nếu bạn mở app trên cổng khác.
4. Bấm **Lưu luồng**, sau đó **Chạy luồng này**.
5. Theo dõi tiến độ. Khi kết thúc, bấm **Mở phần báo cáo** để tải Excel, HTML, JSON hoặc API của phiên.

File [automation-demo.md](../examples/automation-demo.md) là hướng dẫn bằng lời cho cùng luồng. Có thể dùng file đó để thử **AI chạy thử & tạo kịch bản** sau khi bật AI trong tab **Trợ lý AI**. File [automation-hotel-cash.txt](../examples/automation-hotel-cash.txt) là một kịch bản đặt phòng đầy đủ 11 bước.

## Tạo luồng từ kịch bản của bạn

Chọn file `.txt`, `.md` hoặc `.json`, tối đa 1 MB, hoặc dán nội dung vào ô kịch bản. Nếu kịch bản có dòng `website_url = …` và `browser = edge|chrome`, app tự điền website và trình duyệt. Với Word hoặc Excel, đưa phần kịch bản sang TXT/Markdown trước. File đặc tả event Excel vẫn được nhập ở phần đặc tả hiện có.

Bấm **AI chạy thử & tạo kịch bản**. Phần văn bản ngoài các bước (mục tiêu, quy tắc, cách thu thập) được gửi cho AI ở mọi bước như ghi chú chung. Email, số điện thoại trong dữ liệu được che khi gửi AI; AI chỉ nói tên biến (`guest_email`), app tự gõ giá trị thật trên máy.

**Nút đặt/thanh toán cuối cùng.** Mặc định AI dừng ngay trước nút tạo đơn/thanh toán thật, ghi lại thao tác đó (đã kiểm chứng locator) và đánh dấu bước còn lại là “AI làm khi chạy”. Lần chạy luồng đã lưu sẽ bấm nút đó đúng một lần. Muốn AI bấm luôn khi chạy thử, tick **Cho phép AI bấm nút đặt/thanh toán cuối cùng**; app hỏi xác nhận trước.

Khi AI chạy thử dừng giữa chừng (hết phòng, cần đăng nhập, không thấy phần tử), các bước đã làm được vẫn được ghi; bước lỗi và các bước sau được đánh dấu “AI làm khi chạy”. Có thể sửa kịch bản rồi chạy thử lại, hoặc lưu và để AI tự sửa hoàn thành các bước đó ở lần chạy.

Chi phí: mỗi lượt AI xem một trang khoảng 5–15 nghìn token. Kịch bản 11 bước thường cần 25–45 lượt, tức khoảng vài cent với các model mặc định. Số lần gọi và chi phí ước tính hiện ở cuối khung tiến độ.

Một hướng dẫn rõ nên có:

- Trang bắt đầu và trạng thái đăng nhập cần có.
- Từng bước thao tác, tên ô nhập/nút bấm và dữ liệu cần điền.
- Dấu hiệu xác nhận đã hoàn tất từng bước, ví dụ danh sách sản phẩm xuất hiện hoặc URL thay đổi.
- Event mong đợi, nền tảng GA4/Insider và các trường cần kiểm.
- Giá trị thay đổi theo ngày hoặc theo lần chạy.

Xem lại danh sách bước, chỉnh nếu cần trong **Xem / chỉnh kịch bản JSON**, rồi lưu. Kịch bản mới luôn để lịch tự chạy tắt.

### Website cần đăng nhập

Cửa sổ test dùng hồ sơ trình duyệt riêng của EventQA (`profiles/cdp-ai-edge` hoặc `profiles/cdp-ai-chrome`), nên đăng nhập một lần là các lần chạy sau, kể cả theo lịch, dùng lại được cho tới khi phiên đăng nhập của website hết hạn. Có ba cách:

- **Mở trình duyệt để đăng nhập**: mở cửa sổ test trên website và để nguyên. Đăng nhập xong thì bấm **AI chạy thử & tạo kịch bản**; app dùng lại đúng cửa sổ đó.
- **Chờ tôi đăng nhập trên website trước khi AI bắt đầu**: AI mở website rồi dừng chờ. Đăng nhập xong bấm **Tiếp tục — tôi đã xong**; AI mở lại trang bắt đầu và chạy kịch bản.
- **Tự động**: nếu website chuyển sang trang đăng nhập/SSO, hoặc AI báo không làm được (đăng nhập, CAPTCHA, OTP…), AI dừng chờ bạn (tối đa 30 phút) thay vì kết thúc. Đăng nhập trong cửa sổ test: khi tab đi qua trang đăng nhập rồi quay về website ổn định vài giây, AI **tự chạy tiếp**, không cần quay lại app. Với CAPTCHA/OTP hoặc khi đã đăng nhập sẵn, bấm **Tiếp tục — tôi đã xong**; muốn dừng thì bấm **Dừng & giữ các bước đã ghi**. Lúc chờ, tiêu đề tab app đổi thành “⏸ Chờ bạn”.

Trong lúc chờ, Playwright nhả cửa sổ test nên popup đăng nhập (Google, SSO) hoạt động bình thường; collector vẫn thu event. Thao tác đăng nhập của bạn không được ghi vào kịch bản. Sau khi AI chạy thử xong, cửa sổ test được giữ mở để bạn xem trang cuối và giữ đăng nhập.

Link `target="_blank"` được mở trong cùng tab test để collector không bỏ sót event.

## AI tự sửa khi website thay đổi

Mỗi luồng có ô **AI tự sửa khi website thay đổi** (bật mặc định, trường `ai_heal`). Khi một thao tác đã ghi không còn khớp (đổi tên nút, thêm popup, lịch sang tháng mới), runner chụp ảnh lỗi rồi để AI hoàn thành mục tiêu của bước từ trạng thái hiện tại, tối đa 8 lượt. Kết quả hiện nhãn **AI tự sửa** kèm giải thích; nên cho AI chạy thử lại để cập nhật kịch bản nếu nhãn này lặp lại hằng ngày.

AI tự sửa chỉ được bấm nút đặt/thanh toán khi bước đã ghi có nút đó và runner chưa bấm nó trong lượt này, nên không bao giờ gửi đơn hai lần. Tắt ô này nếu muốn luồng dừng ngay ở bước lỗi mà không gọi AI.

Thao tác đánh dấu **nếu có** (`optional: true`, thường là đóng popup) được bỏ qua sau 5 giây nếu không xuất hiện. Thiếu event mong đợi không làm dừng luồng: bước được đánh dấu **Thiếu: …** và các bước sau vẫn chạy để lấy đủ bằng chứng.

## AI chạy thử kiểm tra những gì

- Mỗi khi AI báo xong một bước, một lượt AI riêng đối chiếu trang với phần **Mong muốn** của bước. Chưa đạt thì AI làm tiếp (có thể quay lại trang trước); bị từ chối 2 lần thì bước dừng kèm lý do.
- Bước có nói tới ngày của kịch bản (checkin/checkout) mà địa chỉ trang vẫn mang ngày khác thì chưa được tính là xong: app bấm nút Tìm kiếm/Áp dụng của khung điều kiện.
- Cuối bước, app ghi kiểm tra `wait_url` (đúng trang, đúng ngày) để lần chạy sau phát hiện ngay khi đi sai.
- Thao tác lặp lại 2 lần mà bước chưa tiến triển bị từ chối; thao tác lỗi lặp 3 lần thì bước dừng.
- Cửa sổ trình duyệt test không cần ở phía trước: app giữ tab hoạt động như đang được chọn.

## Khi luồng báo lỗi

Lỗi giờ nói rõ locator nào và lý do: “Không tìm thấy button “Đặt ngay” trong khối có “[VGRBIZ] …” sau 14.3s”, “bị popup hoặc lớp phủ khác che”, “khớp 3 phần tử”, “đang bị vô hiệu hóa”. Ảnh màn hình lúc lỗi nằm trong `runs/<session-id>/automation-screenshots/`, call log gốc của Playwright nằm trong `workflow-results.json` (trường `error_detail`).

Nếu AI chạy thử báo lỗi về AI, xem thông điệp: hết thời gian chờ, hết credit, sai key hoặc không có model phù hợp giới hạn giá. Model dùng cho tự động hóa đặt bằng `OPENROUTER_MODEL_AUTOMATION` trong `.env` (danh sách cách nhau dấu phẩy, thêm `auto` ở cuối để thử các model khác). Mặc định thử `deepseek/deepseek-v4-flash`, `qwen/qwen3.5-flash-02-23`, `openai/gpt-4o-mini`… trước, vì các model rẻ nhất/miễn phí thường không theo được yêu cầu JSON dài.

## Chạy một hoặc nhiều luồng

Bấm **Chạy** trên một luồng hoặc tick các luồng rồi bấm **Chạy các luồng đã chọn**. Các luồng cùng lượt được thực hiện lần lượt và cần dùng cùng một trình duyệt. Kết thúc phiên thu thập thủ công đang mở trước khi bắt đầu lượt tự động.

Phần **Giá trị dùng cho lượt chạy này** nhận một đối tượng JSON bổ sung/thay thế các biến đã lưu. Ví dụ:

```json
{"destination":"Nha Trang","adults":2,"nights":3}
```

Trong tiến độ, xem bước đang thực hiện và lỗi cụ thể. Bấm **Dừng lượt chạy** để ngừng thao tác; bằng chứng đã thu thập được giữ lại. Lịch sử lưu thời điểm bắt đầu, kết thúc và kết quả từng lượt. Phần **Event trực tiếp**, **Đối chiếu đặc tả**, **API** và báo cáo vẫn dùng dữ liệu từ phiên thực thi.

## Lịch tự chạy

Chọn **Bật lịch tự chạy**, đặt giờ rồi **Lưu luồng**. Mặc định là 07:00, tất cả các ngày, múi giờ `Asia/Ho_Chi_Minh`. Trong JSON nâng cao, `schedule.days` dùng số 0 đến 6 tương ứng Chủ nhật đến Thứ bảy.

Ứng dụng và máy cần hoạt động để lịch thực thi; Windows Task Scheduler hoặc dịch vụ chạy nền không được cài đặt bởi tính năng này. Muốn dừng lịch của một luồng, mở luồng đó, bỏ chọn lịch rồi lưu.

## Biến và ngày động

Biến được lưu trong `variables` của kịch bản. Dùng `{{destination}}` hoặc `{{variables.destination}}` để lấy một giá trị; biến lồng nhau dùng dấu chấm, ví dụ `{{search.destination}}`.

| Giá trị trong kịch bản | Kết quả lúc chạy |
|---|---|
| `{{destination}}` | Giá trị biến destination |
| `{{date}}` | Ngày hiện tại tại Việt Nam, dạng YYYY-MM-DD |
| `{{date:+7}}` | Ngày sau 7 ngày |
| `{{date:-1}}` | Ngày hôm qua |
| `{{date:+14\|DD/MM/YYYY}}` | Ngày sau 14 ngày, dạng 22/11/2026 |
| `{{checkin\|D}}` | Số ngày (22) của biến ngày checkin, dùng cho ô ngày trên lịch |

Định dạng ngày dùng `YYYY`, `MM`, `DD`, `M`, `D`, các ký tự khác giữ nguyên (ví dụ `Tháng M năm YYYY`). Khi AI chạy thử bấm vào ô ngày hoặc gợi ý trùng giá trị một biến, app tự lưu thành `{{bien}}`/`{{bien|D}}` để lần chạy sau dùng ngày của chính hôm đó.

Khi toàn bộ giá trị là một biến, dữ liệu giữ kiểu gốc. Ví dụ context `"adults":"{{adults}}"` nhận số 2 nếu biến adults là số 2. Giá trị điền vào ô nhập được runner chuyển thành chữ theo yêu cầu trình duyệt.

## Cấu trúc kịch bản

Kịch bản gồm `name`, `url`, `browser`, `variables`, `steps` và `schedule`; `schema_version` hiện là `1.0`. Mỗi bước có tên, danh sách `actions`, context tùy chọn và `expected_events` hoặc `case_id` nếu gắn với rule đã nhập.

Các thao tác hỗ trợ:

| type | Ý nghĩa | Trường chính |
|---|---|---|
| `goto` | Mở trang | `url` |
| `click` | Bấm thành phần | `locator` |
| `fill` | Điền ô nhập | `locator`, `value` |
| `type` | Gõ từng phím (ô tìm kiếm có gợi ý) | `locator`, `value` |
| `hover` | Rê chuột lên thành phần | `locator` |
| `scroll` | Cuộn trang để tải thêm nội dung | `direction` (`down`/`up`), `amount` |
| `wait_ms` | Chờ cố định | `ms` (tối đa 30000) |
| `back` | Quay lại trang trước | — |
| `wait_url` | Kiểm tra địa chỉ trang có chứa đoạn chữ (đường dẫn, `checkIn={{checkin|YYYY-MM-DD}}`) | `contains` |
| `select` | Chọn trong danh sách select | `locator`, `value` |
| `check` | Đánh dấu/bỏ chọn checkbox | `locator`, `checked` |
| `press` | Nhấn phím | `locator`, `key` |
| `wait_for` | Chờ xuất hiện/ẩn | `locator`, `state` |
| `assert_text` | Kiểm tra nội dung | `locator`, `text` |
| `assert_url` | Kiểm tra URL | `url` |

`locator` nhận `by` là `role`, `label`, `placeholder`, `text`, `testId` hoặc `css`, cùng `value`. Khi `by` là `role`, điền thêm `role`, ví dụ:

```json
{"type":"click","locator":{"by":"role","role":"button","value":"Tìm khách sạn","exact":true}}
```

`locator.by: "visible_text"` bấm phần tử đang hiển thị có chữ đó, ưu tiên popup/danh sách gợi ý vừa mở (cách chọn gợi ý sau khi gõ: `{"type":"click","locator":{"by":"visible_text","value":"{{destination}}"}}`).

`locator.within.text` khoanh vùng vào card/dòng nhỏ nhất chứa đoạn chữ đó, `nth` chọn theo vị trí (0 là đầu tiên; kém bền hơn `within`):

```json
{"type":"click","locator":{"by":"role","role":"button","value":"Đặt ngay","exact":true,"within":{"text":"{{rate_plan_name}}"}},"irreversible":false}
```

Mọi thao tác nhận thêm `optional` (bỏ qua nếu không có), `irreversible` (tạo đơn/thanh toán thật; AI tự sửa không lặp lại), `note` và `timeout_ms` (mặc định 15 giây, `goto` 30 giây). Bước nhận thêm `instructions` (mục tiêu bằng lời cho AI tự sửa), `pending` (AI thực hiện phần chưa ghi khi chạy), `note` và `observed_events` (event thấy khi chạy thử, chỉ để tham khảo).

`expected_events` kiểm việc xuất hiện của event trong bước. Để so từng trường, số lần, thứ tự và context theo rule hiện có, nhập đặc tả vào EventQA và đặt `case_id` của bước tương ứng. Với demo, có thể nhập [cases.json](../examples/cases.json) rồi thêm `"case_id":"TC-HOTEL-SEARCH-001"` vào bước `submit-search`. Xem [RULES.md](RULES.md) cho các phép kiểm.

## Dữ liệu được lưu

Mặc định cấu hình và lịch sử nằm trong `runs/.automation/workflows.json` và `runs/.automation/history.json`. Bằng chứng, log API và báo cáo của từng lượt vẫn nằm trong thư mục phiên `runs/<session-id>/`. Giữ thư mục cấu hình nếu muốn dùng lại các luồng sau khi mở lại ứng dụng.

Tính năng hiện tạo và xuất các file bằng chứng/báo cáo của EventQA. Thao tác tải một file bất kỳ từ một hệ thống báo cáo khác chưa có trong danh sách action hỗ trợ.
