# Bản AI — dùng thế nào

Bản AI bắt event giống hệt **bản thường** (đọc `dataLayer`, `InsiderQueue` và request GA4/Insider). Khác biệt duy nhất: có thêm trợ lý AI kiểm tra cả phiên và giải thích bằng tiếng Việt. Mở bằng [CHAY_EVENT_QA_AI.cmd](../CHAY_EVENT_QA_AI.cmd) (hoặc [solutions/02-cdp-ai/start.cmd](../solutions/02-cdp-ai/start.cmd)), giao diện tại http://127.0.0.1:4174.

## AI giúp được gì

| Việc | Cách dùng | AI trả lời |
|---|---|---|
| **Kiểm tra cả phiên** | Nhập file đặc tả (ví dụ sheet R1511), thao tác trên website, rồi mở tab **✦ Trợ lý AI** → ghi yêu cầu kiểm tra (không bắt buộc) → **✦ AI kiểm tra phiên này** | Event nào **đúng**, **sai** (sai trường nào), **thiếu**, đang có **vấn đề** gì (gửi lặp, ngoài đặc tả, có push nhưng không gửi lên server) và ai cần làm gì tiếp |
| **Giải thích một event** | Tab **Event trực tiếp** → **Xem chi tiết** một event → **✦ AI giải thích event này** | Event là gì, người dùng làm gì thì bắn, có khớp file đặc tả không, vấn đề cụ thể và việc Dev/QC cần làm |
| **Giải thích lỗi tự động** | Không cần bấm: khi một bước ra **Cần sửa** | Nguyên nhân và việc cần làm, hiện ngay dưới kết quả bước |
| **Tạo rule từ mô tả** | Tab **✦ Trợ lý AI** → điền tên event, gửi cho GA4/Insider, mô tả, dán payload mẫu từ Excel → **✦ Tạo rule bằng AI** | Danh sách trường cần kiểm và cách kiểm (bằng tiếng Việt); bạn xem lại rồi lưu |

**AI không quyết định đúng/sai.** Kết luận khớp/lệch đặc tả luôn do công cụ tự kiểm theo file Excel; AI chỉ diễn giải kết luận đó và không được nói ngược lại. Rule AI tạo luôn là bản nháp, cần bạn duyệt trước khi dùng. Email, số điện thoại, token… được che trước khi gửi cho AI.

## Kiểm tra cả phiên: AI đọc những gì

1. **Yêu cầu của bạn**, ví dụ “Kiểm tra luồng Golf trên web theo sheet R1511: tìm kiếm sân → xem chi tiết → chọn tee time → thanh toán”.
2. **Các dòng đặc tả của luồng đang test**: dòng đã có event và các dòng chưa thấy của cùng luồng (tên event, khi nào bắn, các trường cần có, ô Excel).
3. **Kết quả công cụ tự kiểm** từng dòng: Khớp / Lệch (trường nào, mong đợi gì, thực tế gì) / Có push nhưng không gửi lên server / Chưa thấy.
4. **Các event đã gửi lên Google / Insider**: giờ, hệ thống, tên event, trang, mã GA4, có phải gửi lặp không.
5. Push không gửi lên server, event ngoài đặc tả và lỗi cách bắn.

Danh sách **Đúng / Sai / Thiếu** luôn khớp kết quả ở tab **Đối chiếu đặc tả**: app dựng lại ba danh sách này từ kết quả công cụ và chỉ giữ câu AI viết khi câu đó nói đúng event đó. AI viết phần tóm tắt, **Đang có vấn đề** và **Nên làm tiếp**. Chưa nhập file đặc tả thì AI chỉ nhận xét các event đã gửi.

## Bật AI

1. Bấm **CHAY_EVENT_QA_AI.cmd** ở thư mục ứng dụng. Giao diện bản AI tự mở.
2. Mở tab **✦ Trợ lý AI**, dán key OpenRouter (tạo tại openrouter.ai → Keys) vào ô rồi bấm **Bật AI**. App tự kiểm tra kết nối; góc trên hiện **AI sẵn sàng**.
3. Key được lưu vào file `.env` trên máy (không nằm trong Git hay gói portable). Lần sau mở bản AI là dùng được ngay. Dán nhầm key thì mở **Đổi key OpenRouter** trong cùng thẻ.

Vẫn có thể cấu hình bằng tay: copy `.env.example` thành `.env`, đặt `AI_ENABLED=true` và `OPENROUTER_API_KEY=...`, rồi mở lại bản AI.

AI thử model **miễn phí** trước; chỉ khi các model miễn phí lỗi mới dùng model trả phí rẻ nhất, tối đa khoảng 0,01 USD cho một lần hỏi. Muốn chỉ dùng miễn phí: đặt `OPENROUTER_ALLOW_PAID=false`. Khi AI tắt hoặc lỗi, mọi phần còn lại vẫn chạy bình thường.

## Chi tiết kỹ thuật (OpenRouter)

Mặc định AI tắt. Bật bằng biến môi trường hoặc file `.env` tại thư mục dự án:

```dotenv
AI_ENABLED=true
OPENROUTER_API_KEY=your_key
OPENROUTER_API_KEYS=optional_backup_key_1,optional_backup_key_2
OPENROUTER_MODEL_SPEC=auto
OPENROUTER_MODEL_EXPLAIN=auto
OPENROUTER_ROUTING=free-first
OPENROUTER_ALLOW_PAID=true
OPENROUTER_MAX_PROMPT_USD_PER_MILLION=0.25
OPENROUTER_MAX_COMPLETION_USD_PER_MILLION=1
OPENROUTER_MAX_MODEL_ATTEMPTS=6
OPENROUTER_MAX_FREE_ATTEMPTS=2
OPENROUTER_MAX_OUTPUT_TOKENS=1800
OPENROUTER_REQUEST_BUDGET_USD=0.01
AI_MAX_RETRIES=1
AI_TIMEOUT_SEC=20
```

`auto` lấy catalog hiện hành, loại model hết hạn, batch, không hỗ trợ text/JSON hoặc thiếu giá prompt/completion hợp lệ. Giá âm/không xác định, giá điều kiện `pricing.overrides` và phí reasoning riêng không thể chặn chắc chắn đều bị loại. Trường phí `request` được API cho phép bỏ trống; khi thiếu, app dùng 0 và ép provider nhận phí request tối đa 0. Không có tên model cụ thể bị đóng cứng.

App ưu tiên model miễn phí, sau đó xếp model trả phí theo chi phí ước tính cho đúng input và output tối đa của thao tác. Mặc định thử tối đa 2 model free để còn chỗ chuyển sang model trả phí trong tổng 6 model. HTTP 429/5xx, timeout, JSON sai và output không đạt schema sẽ chuyển sang ứng viên tiếp theo với cooldown có giới hạn. Model có `structured_outputs` nhận `json_schema`; model chỉ có `response_format` nhận `json_object` kèm schema trong system prompt. Mọi output đều được kiểm tra bằng Ajv và kiểm tra ngữ nghĩa trước khi chấp nhận.

Để tránh model dùng hết output cho reasoning rồi trả content trống, gateway tắt reasoning nếu model cho phép; nếu reasoning bắt buộc, dùng mức thấp nhất `minimal/low` được công bố hoặc token cap tối đa 128 khi có hỗ trợ. Model bắt buộc reasoning nhưng không công bố cách giới hạn phù hợp sẽ bị loại. Ước tính ngân sách cộng phần dự phòng reasoning này. Diagnostics chỉ giữ finish_reason, kiểu/độ dài content, số token và chi phí; không lưu text reasoning. Xem [tài liệu reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

Giá catalog là USD/token; `provider.max_price` dùng USD/triệu token. Gateway chuyển đúng đơn vị, đặt `sort=price`, `require_parameters=true`, `data_collection=deny` và ép trần giá theo chính giá catalog của ứng viên. Vì vậy request free có cả ba trần prompt/completion/request bằng 0. Model có giá vượt cấu hình sẽ không được thử. Ngân sách USD là cho toàn bộ một thao tác, cộng cả những lần fallback có thể đã phát sinh phí; số token input được chặn bằng số byte UTF-8 cộng schema và phần dự phòng, output bị chặn bằng `max_tokens`. `estimated_cost_usd` và `reserved_cost_usd` là ước tính bảo thủ; `actual_cost_usd` chỉ có khi OpenRouter trả `usage.cost` dạng số.

Khóa chính và các khóa dự phòng được loại trùng, tối đa 8 khóa. HTTP 401 loại khóa sai, HTTP 402 chuyển khóa dự phòng cho cùng model và đánh khóa thiếu credit chỉ với model trả phí; khóa vẫn có thể dùng model free ở thao tác sau. Khóa cùng tài khoản có thể dùng chung số dư. HTTP 403 dừng thao tác, tránh đổi model để vượt giới hạn tài khoản/workspace. Lỗi HTTP 200 có `body.error` cũng được xử lý theo mã lỗi; không đưa body lỗi provider ra log. Số HTTP completion thực tế có trần riêng `OPENROUTER_MAX_COMPLETION_REQUESTS` (mặc định tổng số model cộng số khóa dự phòng), nên key rotation không tạo vòng lặp.

Có thể thay `auto` bằng một ID model để chọn cố định; kiểm tra giá, schema, ngân sách và key dự phòng vẫn áp dụng. Catalog được cache tối đa một giờ; kết quả hợp lệ được cache trong tiến trình theo hash model, input đã che dữ liệu và schema. Chỉ gọi AI khi cần tạo nháp, giải thích một event, giải thích lỗi hoặc kiểm tra cả phiên. Nếu toàn bộ ứng viên/khóa không dùng được, tính năng AI trả unavailable và báo cáo deterministic vẫn xuất được. `diagnostics()` và `listRoutingCandidates()` chỉ hiển thị model, giá, nhãn `key_1`… và mã trạng thái; không chứa API key.

Input gửi đi được che token, thông tin đăng nhập và PII trước khi gọi API. Không ghi API key hoặc body lỗi provider vào log. Request đặt `provider.data_collection=deny`; hãy chọn model/provider phù hợp chính sách dữ liệu của môi trường kiểm thử. Việc truyền dữ liệu ra OpenRouter chỉ diễn ra sau khi đã bật AI và gọi chức năng AI.

Tài liệu kỹ thuật: [OpenRouter API](https://openrouter.ai/docs/api_reference/overview), [Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [provider selection và trần giá](https://openrouter.ai/docs/guides/routing/provider-selection), [model fallback](https://openrouter.ai/docs/guides/routing/model-fallbacks).
