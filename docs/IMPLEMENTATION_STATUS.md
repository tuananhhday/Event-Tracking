# Trạng thái triển khai — 29/10/2026

## Đã có bản chạy riêng cho ba phương án

| Phần | Đã triển khai | Kiểm chứng |
|---|---|---|
| 01 CDP không AI | Chrome/Edge launcher, raw CDP, dataLayer, InsiderQueue, network và frame/target support | Chrome thật trên Trip.com; cả Chrome/Edge trên 5 tình huống demo |
| 02 CDP + OpenRouter | Free-first/cheapest-paid, model/key fallback, giá/ngân sách/request cap, model discovery, schema validation, draft review, giải thích FAIL và reasoning control | Gọi thật thành công model free dots và trả phí Nemo; mock kiểm chứng key/model lỗi, quota, JSON/schema sai, ngân sách và giữ nguyên verdict |
| 03 Proxy không AI | mitmdump addon + adapter dùng decoder/store chung, JSONL request/response/failure, custom endpoint allowlist | mitmproxy 12.3.1 thật qua cả HTTP và HTTPS local, xác thực TLS bằng CA chỉ cho test |
| Shared core | 10 field operators, count/duplicate/order/timing, context ref, layer capability, network transport errors | Unit/integration tests |
| Specification | JSON/XLSX, sheet/header detection, provenance, safe JSON5 parse, review gate | Workbook tổng hợp tự tạo trong test; chưa có workbook nội bộ thật |
| Evidence | JSONL append+fsync, step log, SQLite WAL, recovery, expected.json snapshot, privacy | Crash/recovery và dữ liệu nhạy cảm được kiểm chứng |
| Output | XLSX 6 sheet, HTML, JSON đầy đủ và bug Markdown | Tải XLSX trong browser smoke |
| Giao diện | Ba màn riêng (`src/web/cdp.html`, `cdp-ai.html`, `proxy.html`) + CSS/JS dùng chung; luồng 4 bước, thanh trạng thái có thao tác tiếp theo, bộ chọn case có verdict, context tạo từ rule `ref`, lọc/tìm bằng chứng, nhảy từ evidence ID, tab AI, cấu hình proxy/CA; dark mode, mobile; CSP cho trang | Chrome headless bấm trực tiếp trên UI: 5 kịch bản demo đúng PASS/FAIL, xuất 4 file; không lỗi JS; không tràn ngang ở 1440px và 390px |

## Viết lại cho website thật — 29/10/2026

Ba màn ưu tiên test trên website thật; demo chỉ còn là tuỳ chọn phụ.

- **Khởi động không có demo.** App nạp `imports/reviewed-cases.json` nếu có, nếu không thì bắt đầu rỗng (thu thập tự do).
- **Bước 1 là website.** URL thật, URL gần đây, chọn vendor (GA4, GA4 `/g/s/collect`, GA4 server-side `/g/collect` mọi domain, Insider, Meta Pixel, TikTok, Google Ads, Clarity) và endpoint riêng; nhớ cấu hình giữa các lần.
- **Event trực tiếp.** Tổng hợp theo event/tầng/nguồn trên toàn bộ bằng chứng (`eventSummary`), đặt mốc, dòng thời gian, đọc event bất kỳ qua `GET /api/event`.
- **Gợi ý endpoint (CDP).** Request giống tracking ngoài allowlist được liệt kê (host + path + số lần, không payload); `POST /api/endpoints` cập nhật allowlist khi đang chạy.
- **Tạo rule từ event thật**, lưu/xoá case khi phiên đang chạy (trừ lúc đang ghi bước); `expected.json` của phiên được cập nhật.
- **Decoder:** Meta Pixel (`ev`) và TikTok có nguồn riêng; GA4 `/g/s/collect` được nhận diện.
- **Proxy HTTPS:** CA cố định + cờ SPKI chỉ cho cửa sổ test; xem [AI_PROXY.md](AI_PROXY.md).

Kiểm chứng trên Trip.com (headless Chrome 156):

| Luồng | Kết quả |
|---|---|
| 01 qua giao diện, không có đặc tả | Gộp 6 loại event; gợi ý 8 endpoint (Trip UBT, Google Ads, Meta, Naver, Twitter/X…); theo dõi `ubt-sin.tripcdn.com/bee/collect` khi đang chạy; tạo rule `page_view` từ event thật (13 trường, trường đã che → có mặt); ghi bước bằng tải lại trang → **PASS 14/14 kiểm tra**; xuất 4 file; không lỗi JS; không tràn ngang ở 1440px và 390px |
| 03 qua server (`/api/start`) | Trip.com HTTPS tải bình thường qua mitmdump khi tin CA bằng SPKI; không tin thì bị "Privacy error". Bước tải lại trang: 17 request → **PASS**; xuất 4 file |

Payload riêng của Trip UBT vẫn là `UNPARSED` (định dạng mã hoá của vendor), nên rule cho endpoint này chỉ kiểm được số lượng.

## Kết quả kiểm thử

- `npm.cmd test`: **130 PASS, 0 FAIL, 1 SKIP** (gồm `tests/web-ui.test.mjs`, `tests/web-real.test.mjs`, `tests/decoder-vendors.test.mjs`). Bài live Trip mặc định skip để unit suite không phụ thuộc Internet; đã chạy riêng và đạt.
- `npm.cmd run check`: 40 file JavaScript kiểm tra cú pháp thành công.
- **Sửa lỗi Chrome 156:** Chrome 156.0.8078.48 phát `Network.loadingFailed {canceled:true, ERR_ABORTED}` ngay sau khi request đã nhận HTTP 204 (đúng kiểu phản hồi của GA4 `/g/collect`). Collector cũ ghi đây là `REQUEST_FAILED` nên mọi request 204 bị FAIL giả; smoke Chrome/Edge thất bại trên trình duyệt hiện tại. Nay bỏ qua lỗi `canceled` khi response đã về; lỗi trước response hoặc lỗi không phải canceled vẫn là FAIL. Smoke Chrome và Edge chạy lại ngày 29/10/2026 đều đạt 5/5.
- `tests/proxy_addon_test.py`: **7 PASS**.
- Không cần F12, Selenium, Playwright hay browser extension cho luồng vận hành.

### Trip.com thực tế

[Quan sát](../runs/live-trip-cdp/observations.json) · [Bằng chứng đã che dữ liệu](../runs/live-trip-cdp/events.jsonl)

Mở `https://www.trip.com/`, website chuyển đến `https://vn.trip.com/?locale=vi-vn`. Trang tải hoàn chỉnh, có native `dataLayer`, không thấy `InsiderQueue`.

- 5 JS queue records: `gtm.js` (website phát hai record), `gtm.dom`, `page_view`, `gtm.load`.
- 12 tracking POST requests từ host telemetry quan sát được `ubt-sin.tripcdn.com`; 12 response HTTP 200; không đếm OPTIONS preflight như event.
- Payload riêng của Trip được giữ `UNPARSED` + SHA-256 hash; không giữ blob `d` và đã che `vid`/`sid`.
- Phạm vi thử là điều hướng trang chủ, không đăng nhập hoặc đặt dịch vụ. Chưa có đặc tả Trip nên **NOT_EVALUATED** về nghiệp vụ; ingestion **NOT_VERIFIED**.

### PoC có expected rõ ràng trên Chrome và Edge

[Chrome](../runs/local-smoke/observations.json) · [Edge](../runs/local-smoke-edge/observations.json)

| Kịch bản | JS_QUEUE | TRACKING_REQUEST |
|---|---|---|
| Hotel tìm Phú Quốc, 2 người lớn, 1 đêm | PASS | PASS |
| Merchandise tìm `snack` bằng context | PASS | PASS |
| Insider xem SKU-001, payload nested | PASS | PASS |
| Hotel cố ý bỏ destination_id | FAIL / MISSING_FIELD | PASS |
| Insider cố ý không gửi request | PASS | FAIL / MISSING_EVENT |

Mỗi browser lưu 17 evidence records, xuất và tải XLSX thành công, request API thiếu token bị từ chối. [Ảnh Chrome](../runs/local-smoke/dashboard.png) · [Ảnh Edge](../runs/local-smoke-edge/dashboard.png).

Đây là dữ liệu demo của dự án, không phải specification hay kết quả nghiệp vụ của Trip.com.

### Proxy thật qua HTTP và HTTPS

[HTTP](../runs/proxy-smoke/observations.json) · [HTTPS](../runs/proxy-https-smoke/observations.json)

Mỗi bài gửi đúng một request tổng hợp đến upstream local qua mitmdump: một request/response evidence, HTTP 204, body và URL upstream giữ nguyên. Token/email không xuất hiện trong event xuất ra hoặc JSONL. HTTPS bật xác thực chứng chỉ bằng CA cho riêng socket Node và tiến trình mitmdump, không đổi trust store Windows hay system proxy. Chrome qua proxy với website HTTPS thật đã được kiểm chứng bằng cờ SPKI (xem phần viết lại cho website thật); Edge chưa thử qua proxy.

### OpenRouter thật: free và trả phí rẻ

[Luồng auto thành công](../runs/ai-smoke/observations.json) · [Probe model](../runs/ai-smoke/targeted-probes.json) · [Các lỗi quan sát ban đầu](../runs/ai-smoke/initial-attempts.json)

- Key xác thực thành công; không lưu giá trị key trong evidence hoặc log. `.env` đã loại khỏi Git; hiện chỉ có một key được cung cấp.
- `dots-studio/dots-3-note-preview:free`: luồng auto đã tạo lời giải thích và bản nháp case Merchandise hợp lệ, `usage.cost=0`. `search_term` được tạo thành `ref=context.search.term`; case và rule vẫn cần QC duyệt.
- `mistralai/mistral-nemo`: lời giải thích JSON hợp lệ; chi phí OpenRouter trả cho probe thành công là **0,00000504 USD**. Giá catalog lúc thử: prompt 0,029 USD/triệu token, completion 0,03 USD/triệu token.
- Đã gặp thực tế HTTP 429 ở model free, HTTP 404 khi không có provider phù hợp, và content trống ở model reasoning. Gateway có fallback, điều khiển reasoning và giữ trace an toàn. Thành công của một lần gọi không đảm bảo model free luôn có quota.
- Đổi key 401/402, ngân sách gộp, request cap và JSON/schema fallback được kiểm chứng bằng mock; chưa có key thật thứ hai để gọi thử chuyển key thực tế. Không tạo key hoặc tài khoản dự phòng.
- Tổng ngân sách bảo thủ dành cho các lượt kiểm tra thực tế trong phiên dưới **0,01 USD**. `usage.cost` nêu ở trên là phí của riêng probe Nemo thành công, không phải tổng hóa đơn tài khoản.

## Việc tiếp theo khi dùng dữ liệu thật

1. Nhập workbook thực tế và duyệt các rule/mapping context. Chưa có `Martech_WebOTA_20260501.xlsx` trong workspace.
2. Đăng nhập website nội bộ trong profile test và chạy từng flow Hotel/Merchandise/Insider.
3. AI đã cấu hình key hiện tại và chế độ auto; có thể bổ sung key dự phòng hoặc điều chỉnh ngân sách. Core không phụ thuộc AI.
4. Proxy với website HTTPS dùng CA cố định + cờ SPKI của cửa sổ test; nếu chính sách môi trường cấm cờ này, dùng CDP.
5. Xác nhận vendor ingestion bằng công cụ vendor khi cần; hiện chưa có adapter DebugView/vendor API.
6. Đóng gói Windows EXE/installer và thêm ma trận regression rộng hơn sau khi flow thực tế được chốt. Hiện chạy qua Node và các file `start.cmd`.

Không tự gửi bug lên Jira hoặc đưa source lên repository/hosting bên ngoài.
