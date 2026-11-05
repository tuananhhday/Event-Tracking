# Luồng tự động

Bản AI có tab **Luồng tự động** theo ba bước: **nhập file hoặc viết mô tả → AI đọc trang và đề xuất các bước → lưu, bấm Chạy để Playwright thực hiện**. Event/API được thu thập trong lúc chạy, không phải chỉ tạo danh sách hướng dẫn.

AI chỉ tham gia khi bấm **AI đọc và lập các bước**. Nút này tự mở và đọc các ô/nút trên website trước khi lập kế hoạch; chưa thực hiện các thao tác nghiệp vụ. Cần bật AI và cấu hình key trong tab **Trợ lý AI**. Chạy luồng đã lưu dùng Playwright, không gọi AI. Báo cáo của lượt chạy tự động dùng nhận xét của công cụ; có thể yêu cầu nhận xét AI khi xuất lại báo cáo.

## Thử nhanh bằng trang demo

1. Chạy `CHAY_EVENT_QA_AI.cmd`, vào tab **Luồng tự động**.
2. Bấm **Tải file mô tả luồng**, chọn [automation-demo.json](../examples/automation-demo.json). Các bước tự nạp lên để xem lại, không cần bấm Nạp JSON và không gọi AI.
3. Xem lại website bắt đầu. File mẫu dùng `http://127.0.0.1:4174/demo`; đổi cổng nếu bạn mở app trên cổng khác.
4. Bấm **Lưu luồng**, sau đó **Chạy luồng này**.
5. Theo dõi tiến độ. Khi kết thúc, bấm **Mở phần báo cáo** để tải Excel, HTML, JSON hoặc API của phiên.

Muốn thử nhập bằng lời, bấm **Dùng ví dụ trên demo**, sau đó **AI đọc và lập các bước**. File [automation-demo.md](../examples/automation-demo.md) cũng dùng được. Xem lại rồi lưu trước khi bấm Chạy.

## Tạo luồng từ hướng dẫn của bạn

Điền website bắt đầu và chọn Chrome/Edge. Tên luồng/nhóm là tuỳ chọn, AI có thể đặt từ mô tả. Nhập tay hoặc chọn Word `.docx`, Excel `.xlsx`, TXT hay Markdown, tối đa 3 MB và 30.000 ký tự hướng dẫn. Word giữ nội dung từng đoạn; Excel giữ tên sheet và các cột/dòng. Không thực thi macro hoặc công thức. File đặc tả event vẫn nhập ở phần đặc tả hiện có.

Một file có thể chứa nhiều luồng, ví dụ mỗi luồng có tiêu đề **Luồng 1**, **Luồng 2**, các bước, dữ liệu và kết quả/event mong đợi. AI tách tối đa 10 luồng mỗi lần. Dùng danh sách **Luồng trong file** để xem lại từng luồng rồi bấm **Lưu N luồng**, sau đó **Chạy N luồng vừa lưu**. Nếu nội dung quá dài, chia thành từng nhóm; ứng dụng không cắt bớt nội dung file một cách im lặng. JSON có sẵn có thể chứa một kịch bản, mảng kịch bản hoặc `{"workflows":[...]}`.

Một hướng dẫn rõ nên có:

- Trang bắt đầu và trạng thái đăng nhập cần có.
- Từng bước thao tác, tên ô nhập/nút bấm và dữ liệu cần điền.
- Dấu hiệu xác nhận đã hoàn tất từng bước, ví dụ danh sách sản phẩm xuất hiện hoặc URL thay đổi.
- Event mong đợi, nền tảng GA4/Insider và các trường cần kiểm.
- Giá trị thay đổi theo ngày hoặc theo lần chạy.

Bấm **AI đọc và lập các bước**. Trong phần **Xem lại các bước AI đề xuất**, có thể mở **Sửa bước này** để sửa tên bước, tên ô/nút và giá trị cần điền; không phải viết JSON. Các tuỳ chọn JSON, biến, lịch chạy và xuất báo cáo nằm trong phần mở rộng. Kế hoạch mới luôn để lịch tự chạy tắt.

Sửa hướng dẫn, URL hoặc trình duyệt sẽ yêu cầu lập kế hoạch lại, không cho lưu/chạy nhầm kế hoạch cũ. Sửa trực tiếp các bước thì chỉ cần lưu lại. Nội dung hướng dẫn được giữ cùng luồng để có thể sửa và lập lại ở lần sau. Một file nhiều luồng được kiểm tra và lưu cùng một lần; lỗi ở một luồng không làm lưu dở các luồng khác.

Khi website có nhiều trang nối tiếp, nên chạy thử và kiểm tra các bước sau trang đầu. Giao diện động, phần chọn ngày, popup hoặc thay đổi cách đăng nhập có thể cần chỉnh kịch bản. Có thể đăng nhập trước trong cửa sổ test dùng profile riêng của EventQA. Nếu luồng gặp OTP/CAPTCHA, dừng và hoàn tất yêu cầu đăng nhập trước khi chạy lại.

## Chạy một hoặc nhiều luồng

Bấm **Chạy** trên một luồng hoặc tick các luồng rồi bấm **Chạy các luồng đã chọn**. Các luồng cùng lượt được thực hiện lần lượt và cần dùng cùng một trình duyệt. Kết thúc phiên thu thập thủ công đang mở trước khi bắt đầu lượt tự động.

Phần **Giá trị dùng cho lượt chạy này** nhận một đối tượng JSON bổ sung/thay thế các biến đã lưu. Ví dụ:

```json
{"destination":"Nha Trang","adults":2,"nights":3}
```

Trong tiến độ, xem tên thao tác hiện tại. Nếu lỗi, thông báo chỉ rõ ô/nút chưa tìm thấy, nhiều thành phần trùng tên, trang không mở được hoặc cửa sổ test đã đóng. Phần tử ẩn trùng tên không còn bị chọn để thao tác. Thời gian cho một bước được tính theo số thao tác (mặc định tối đa 120 giây), thay vì dùng chung 30 giây cho cả mở trang, nhập liệu và chờ event. Thời gian chờ event mặc định tối đa 30 giây trong ngân sách bước.

**Đã thao tác xong, đang chờ event** nghĩa là Playwright đã làm xong thao tác nhưng chưa thấy event mong đợi; khác với lỗi không thực hiện được bước. Bấm **Dừng lượt chạy** để ngừng thao tác; bằng chứng được giữ lại. Lịch sử lưu kết quả từng lượt; các tab Event/API và báo cáo vẫn dùng dữ liệu thực thi.

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

## Kiểm tra bản cập nhật

`npm run smoke:automation-guide` kiểm tra nhập tay, đọc trang thật, kế hoạch nhiều luồng, chặn kế hoạch cũ, sửa bước trên giao diện, lưu, chạy hai luồng bằng Playwright và thu event, cùng nhập Word. AI planner trong kiểm tra này là mô phỏng; trình duyệt, Playwright, website demo và collector chạy thật. `npm run smoke:automation` kiểm tra các thao tác và phần tử ẩn trùng tên; `npm run smoke:automation-app` kiểm tra nạp JSON có sẵn và báo cáo. Các ca này không chứng minh mọi luồng trên website bên ngoài chạy được; tên ô/nút, đăng nhập và trạng thái trang thực tế vẫn cần phù hợp với hướng dẫn.
