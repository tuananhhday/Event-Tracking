# Phương án 2 — CDP + AI (OpenRouter)

Chế độ này giữ nguyên collector và verdict của phương án 1. AI chỉ tạo bản nháp rule hoặc ghi chú giải thích; không được ghi đè PASS/FAIL/REVIEW. Mọi bản nháp AI đều có `needs_review=true` ở cả case và rule. Đọc, chỉnh và duyệt rule trước khi dùng như đặc tả chính thức.

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

Có thể thay `auto` bằng một ID model để chọn cố định; kiểm tra giá, schema, ngân sách và key dự phòng vẫn áp dụng. Catalog được cache tối đa một giờ; kết quả hợp lệ được cache trong tiến trình theo hash model, input đã che dữ liệu và schema. Chỉ gọi AI khi cần tạo nháp hoặc giải thích lỗi. Nếu toàn bộ ứng viên/khóa không dùng được, tính năng AI trả unavailable và báo cáo deterministic vẫn xuất được. `diagnostics()` và `listRoutingCandidates()` chỉ hiển thị model, giá, nhãn `key_1`… và mã trạng thái; không chứa API key.

Input gửi đi được che token, thông tin đăng nhập và PII trước khi gọi API. Không ghi API key hoặc body lỗi provider vào log. Request đặt `provider.data_collection=deny`; hãy chọn model/provider phù hợp chính sách dữ liệu của môi trường kiểm thử. Việc truyền dữ liệu ra OpenRouter chỉ diễn ra sau khi đã bật AI và gọi chức năng AI.

Tài liệu kỹ thuật: [OpenRouter API](https://openrouter.ai/docs/api_reference/overview), [Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [provider selection và trần giá](https://openrouter.ai/docs/guides/routing/provider-selection), [model fallback](https://openrouter.ai/docs/guides/routing/model-fallbacks).

# Phương án 3 — Proxy không AI

`ProxyCollector` chạy một tiến trình `mitmdump` riêng, chỉ lắng nghe `127.0.0.1:8080`. Addon lọc endpoint trước, che URL/body trước khi ghi JSONL và lưu hash cho payload không đọc được. Không lưu raw `.mitm`, không tự cài CA, không đổi system proxy và không replay request. Cấu hình/CA mới do mitmproxy tạo được đặt tại `<runDir>/mitm-config`.

Cần cài [mitmproxy chính thức](https://docs.mitmproxy.org/stable/overview/installation/) hoặc chỉ định đường dẫn tuyệt đối đến `mitmdump.exe`. Node chạy binary bằng `spawn` với `shell:false` và `windowsHide:true`; nếu dùng Windows, ưu tiên `mitmdump.exe` thay vì wrapper `.cmd`.

Máy hiện tại đã có mitmproxy 12.3.1 trong `.venv-proxy`; app tự chọn binary tại đây nếu có, nên trường đường dẫn mitmdump trên giao diện có thể để trống. Thư mục `.python-runtime` chứa Python riêng của dự án, không thêm vào PATH và không đăng ký registry.

Để thiết lập trên máy mới có `uv` (PowerShell, chạy ở thư mục dự án):

```powershell
$env:UV_PYTHON_INSTALL_DIR = Join-Path (Get-Location) '.python-runtime'
uv --cache-dir .cache/uv python install 3.13 --no-bin --no-registry
uv --cache-dir .cache/uv venv --python 3.13 .venv-proxy
uv --cache-dir .cache/uv pip install --python .venv-proxy/Scripts/python.exe -r proxy/requirements.txt
```

Không dùng Python nhúng của ứng dụng khác làm runtime triển khai vì có thể thiếu SSL DLL. Các lệnh trên chỉ cài trong thư mục dự án; không cài CA hoặc đổi proxy hệ thống.

Trình duyệt thử nghiệm được mở với `--proxy-server=http://127.0.0.1:<port>`.

**HTTPS.** Ứng dụng dùng một CA cố định tại `profiles/mitmproxy/` (thư mục bị loại khỏi Git) thay vì tạo CA mới mỗi phiên. mitmproxy ký mọi chứng chỉ site bằng chính khoá của CA này (`dummy_cert` dùng public key của CA), nên khi ô **Cho trình duyệt test tin CA của proxy** được tick, cửa sổ test do app mở nhận cờ `--ignore-certificate-errors-spki-list=<SHA-256 SPKI của CA>`: chỉ chứng chỉ mang đúng khoá này được chấp nhận; mọi lỗi chứng chỉ khác vẫn bị chặn. Không cài CA vào Windows hay trình duyệt cá nhân, không đổi proxy hệ thống, không dùng `--ignore-certificate-errors`. Bỏ tick thì website HTTPS sẽ báo lỗi chứng chỉ như trình duyệt thường. Khoá CA trong `profiles/mitmproxy/` cần được giữ như dữ liệu test nhạy cảm; xoá thư mục để tạo CA mới.

Chỉ request tracking trong allowlist được ghi nhận. Mặc định gồm domain GA4 và Insider; endpoint nội bộ cần thêm regex qua `endpointPatterns` khi tạo collector. Cả CDP và Proxy đều so regex với `hostname + pathname`, không so query string. Ví dụ: `^tracking\\.example\\.com/events$` hoặc `/demo/g/collect`. Các pattern phải tương thích với cả JavaScript RegExp và Python `re`.

JSONL có các record `phase=request|response|failed`. Request được đưa qua decoder chung; response/failure tham chiếu cùng request ID, không bị đếm thành event mới. Body JSON, form và NDJSON được giải mã trước khi che; nội dung binary/không hỗ trợ không được ghi raw. `importProxyJsonl(filePath,onEvent)` chỉ đọc tệp, trả `{records,events,errors}` và đếm dòng lỗi/truncated. Không có chức năng phát lại traffic.

Proxy chỉ chứng minh tầng `TRACKING_REQUEST`; không quan sát trực tiếp `dataLayer` hoặc `InsiderQueue`. HTTP 2xx không chứng minh vendor đã ingest. Trust CA trên browser thực tế vẫn cần kiểm tra tại môi trường đích.

Đã chạy smoke thật qua mitmdump với server HTTP và HTTPS tự tạo tại localhost:

```powershell
node scripts/proxy-smoke.mjs
node scripts/proxy-smoke.mjs --https
```

Mỗi lần kiểm chứng đúng một request gốc tới server thử nghiệm, một record request và một record response, HTTP 204; URL/body upstream giữ nguyên và JSONL không chứa email/token thử. Bằng chứng nằm tại `runs/proxy-smoke/observations.json` và `runs/proxy-https-smoke/observations.json`.

Smoke HTTPS tạo chứng chỉ localhost hết hạn sau một ngày; mitmdump chỉ tin chứng chỉ upstream này trong tiến trình thử, còn Node chỉ tin CA mitmproxy cho đúng một TLS socket (`rejectUnauthorized=true`). Không thay đổi OS CA, browser CA, proxy hệ thống hoặc global TLS. Có thể chỉ định binary khác bằng `--command <mitmdump.exe>` và Python khác cho fixture bằng `--python <python.exe>`.

Tài liệu addon: [mitmproxy addon examples](https://docs.mitmproxy.org/stable/addons/examples/).
