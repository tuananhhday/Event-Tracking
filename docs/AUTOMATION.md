# Luồng tự động

Bản AI có tab **Luồng tự động** để thực hiện các thao tác trên website, thu thập event/API bằng collector hiện có và xuất báo cáo sau lượt chạy. Bạn tạo kịch bản từ file hướng dẫn hoặc nạp JSON có sẵn, xem lại rồi lưu để chạy nhiều lần.

AI chỉ tham gia khi bấm **AI tạo kịch bản**. Chạy kịch bản đã lưu, chạy theo lịch, quan sát trang và nạp JSON không gọi AI. Báo cáo của lượt chạy tự động dùng nhận xét của công cụ. Nếu cần nhận xét AI, mở phần **Kết thúc & báo cáo**, chọn **Kèm nhận xét AI khi xuất** và xuất lại.

## Thử nhanh bằng trang demo

1. Chạy `CHAY_EVENT_QA_AI.cmd`, vào tab **Luồng tự động**.
2. Bấm **Chọn file hướng dẫn**, chọn [automation-demo.json](../examples/automation-demo.json), rồi bấm **Nạp JSON**.
3. Xem lại website bắt đầu. File mẫu dùng `http://127.0.0.1:4174/demo`; đổi cổng nếu bạn mở app trên cổng khác.
4. Bấm **Lưu luồng**, sau đó **Chạy luồng này**.
5. Theo dõi tiến độ. Khi kết thúc, bấm **Mở phần báo cáo** để tải Excel, HTML, JSON hoặc API của phiên.

File [automation-demo.md](../examples/automation-demo.md) là hướng dẫn bằng lời cho cùng luồng. Có thể dùng file đó để thử **Quan sát trang → AI tạo kịch bản** sau khi bật AI trong tab **Trợ lý AI**.

## Tạo luồng từ hướng dẫn của bạn

Điền tên luồng, website bắt đầu và trình duyệt. Chọn file `.txt`, `.md` hoặc `.json`, tối đa 1 MB; cũng có thể dán nội dung vào ô hướng dẫn. Với Word hoặc Excel, đưa phần hướng dẫn cần dùng sang TXT/Markdown trước khi nhập vào tab này. File đặc tả event Excel vẫn được nhập ở phần đặc tả hiện có.

Một hướng dẫn rõ nên có:

- Trang bắt đầu và trạng thái đăng nhập cần có.
- Từng bước thao tác, tên ô nhập/nút bấm và dữ liệu cần điền.
- Dấu hiệu xác nhận đã hoàn tất từng bước, ví dụ danh sách sản phẩm xuất hiện hoặc URL thay đổi.
- Event mong đợi, nền tảng GA4/Insider và các trường cần kiểm.
- Giá trị thay đổi theo ngày hoặc theo lần chạy.

Bấm **Quan sát trang** để ứng dụng mở website và nhận diện các thành phần hiện có. Sau đó bấm **AI tạo kịch bản**. Xem lại danh sách bước được tạo, chỉnh nếu cần trong **Xem / chỉnh kịch bản JSON**, rồi lưu. Kịch bản mới luôn để lịch tự chạy tắt, kể cả file nhập hoặc câu trả lời AI có yêu cầu bật lịch.

Khi website có nhiều trang nối tiếp, nên chạy thử và kiểm tra các bước sau trang đầu. Giao diện động, phần chọn ngày, popup hoặc thay đổi cách đăng nhập có thể cần chỉnh kịch bản. Có thể đăng nhập trước trong cửa sổ test dùng profile riêng của EventQA. Nếu luồng gặp OTP/CAPTCHA, dừng và hoàn tất yêu cầu đăng nhập trước khi chạy lại.

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

Khi toàn bộ giá trị là một biến, dữ liệu giữ kiểu gốc. Ví dụ context `"adults":"{{adults}}"` nhận số 2 nếu biến adults là số 2. Giá trị điền vào ô nhập được runner chuyển thành chữ theo yêu cầu trình duyệt.

## Cấu trúc kịch bản

Kịch bản gồm `name`, `url`, `browser`, `variables`, `steps` và `schedule`; `schema_version` hiện là `1.0`. Mỗi bước có tên, danh sách `actions`, context tùy chọn và `expected_events` hoặc `case_id` nếu gắn với rule đã nhập.

Các thao tác hỗ trợ:

| type | Ý nghĩa | Trường chính |
|---|---|---|
| `goto` | Mở trang | `url` |
| `click` | Bấm thành phần | `locator` |
| `fill` | Điền ô nhập | `locator`, `value` |
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

`expected_events` kiểm việc xuất hiện của event trong bước. Để so từng trường, số lần, thứ tự và context theo rule hiện có, nhập đặc tả vào EventQA và đặt `case_id` của bước tương ứng. Với demo, có thể nhập [cases.json](../examples/cases.json) rồi thêm `"case_id":"TC-HOTEL-SEARCH-001"` vào bước `submit-search`. Xem [RULES.md](RULES.md) cho các phép kiểm.

## Dữ liệu được lưu

Mặc định cấu hình và lịch sử nằm trong `runs/.automation/workflows.json` và `runs/.automation/history.json`. Bằng chứng, log API và báo cáo của từng lượt vẫn nằm trong thư mục phiên `runs/<session-id>/`. Giữ thư mục cấu hình nếu muốn dùng lại các luồng sau khi mở lại ứng dụng.

Tính năng hiện tạo và xuất các file bằng chứng/báo cáo của EventQA. Thao tác tải một file bất kỳ từ một hệ thống báo cáo khác chưa có trong danh sách action hỗ trợ.
