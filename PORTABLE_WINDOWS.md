# Windows: giải nén rồi bấm chạy

Tải [bản Windows đầy đủ đã gọn file](https://codeload.github.com/tuananhhday/Event-Tracking/zip/refs/heads/win-20261106). Gói có ứng dụng, Node và thư viện cần để chạy. Repo cũng lưu [EventQA-Windows-x64.zip](portable/EventQA-Windows-x64.zip).

1. Giải nén **toàn bộ** ZIP vào thư mục ngắn có quyền ghi, ví dụ `C:\EventQA`. Tạo thư mục mới khi thay bản tải cũ bị giải nén dở.
2. Bấm **CHAY_EVENT_QA.cmd**. Giao diện bản thường tự mở trong trình duyệt. Muốn dùng bản AI, bấm **CHAY_EVENT_QA_AI.cmd**; lần đầu mở tab **✦ Trợ lý AI**, dán key OpenRouter rồi bấm **Bật AI**.
3. Giữ cửa sổ lệnh mở khi dùng. Bấm **STOP_EVENT_QA.cmd** để dừng.

Khi cập nhật, dừng ứng dụng cũ bằng **STOP_EVENT_QA.cmd** trước khi mở thư mục mới để trình duyệt không tiếp tục dùng tiến trình của bản cũ. Giữ thư mục phiên làm việc cũ nếu cần xem lại báo cáo.

Gói đã có Node.js 24.19.0 Windows x64 và thư viện theo lockfile. Không cần cài Node hay gõ lệnh npm. Máy cần có Chrome hoặc Edge. Bản AI cần OpenRouter key riêng, nhập ngay trong giao diện (xem `docs/AI.md`).

Bản AI được mở bằng `CHAY_EVENT_QA_AI.cmd` sẽ dùng kho chứng chỉ tin cậy của Windows và proxy `HTTPS_PROXY`/`HTTP_PROXY` nếu đã khai báo trong môi trường hoặc `.env`. Có thể khai báo file CA do IT cung cấp qua `NODE_EXTRA_CA_CERTS`. Dừng và mở lại ứng dụng sau khi đổi cấu hình mạng. Tab **Trợ lý AI → Kiểm tra kết nối AI** phân biệt lỗi chứng chỉ, DNS, kết nối và proxy 403/407; xem [hướng dẫn mạng công ty](docs/AI.md#khi-dùng-mạng-công-ty).

Gói đã gộp các thư viện JavaScript thành ít file, bỏ thư mục kiểm thử, tài liệu phát triển, file `.map` và khai báo kiểu không cần khi chạy. Thư mục `scripts` chỉ giữ bộ mở/dừng ứng dụng; công cụ build và kiểm thử vẫn nằm trong mã nguồn Git. Playwright giữ các file chạy và tài nguyên cần thiết. Giấy phép của các thư viện nằm trong `node_modules/THIRD_PARTY_LICENSES.txt` và các file license của Playwright. Cần giải nén toàn bộ thư mục trước khi chạy, không cài thêm thư viện.

Tên thư mục tải và thư mục trong ZIP được rút ngắn. Mỗi lần build đều kiểm tra tính toàn vẹn ZIP, tên file không hợp lệ trên Windows, tên trùng khi bỏ qua hoa/thường và đường dẫn dài quá 120 ký tự trong gói. Điều này dành chỗ cho đường dẫn Downloads trên máy người dùng; vẫn nên chọn thư mục giải nén ngắn.

Bản hiện tại chỉ đối chiếu đặc tả sau khi **Chọn luồng kiểm tra**. **Test lại** tạo lượt mới; **Đổi event so sánh** chọn bằng chứng trong lượt đang xem. Giao diện giữ bố cục cũ với thanh thiết lập bên trái và bảng event bên phải. Tab **TP2 ↔ API** tự giải mã `ue_px`, tìm API và ghép trường theo mã đơn/sản phẩm, gồm các lần gọi lại `myorder`.

Chữ và nút dùng kích thước cũ; tên dài được ngắt dòng. Danh sách sheet có ô tìm kiếm và vùng cuộn giới hạn để hiện đủ tên sheet. Dữ liệu cá nhân được nhận diện sẽ được băm HMAC-SHA256 trước mọi lời gọi AI; mật khẩu/token tiếp tục được che. Xem [cơ chế bảo vệ dữ liệu AI](docs/AI.md).

Đối chiếu đặc tả mở hai cột **Theo đặc tả / Thực tế**, ghi rõ GA4 hoặc Insider. Kết quả dùng **Chưa thấy lỗi**, **Có lỗi**, **Cần kiểm tra thêm**. Dòng chỉ kiểm kiểu ghi **Đúng kiểu dữ liệu… Chưa kiểm tra nội dung**; mục chưa được kiểm ghi **Chưa kiểm tra nội dung này**. Màu đỏ là lỗi cần sửa; màu vàng là khác mẫu, có giải thích ngay dưới từng mục. GA4 chỉ so GA4, Insider chỉ so Insider. Dữ liệu gốc và cách kiểm tra nâng cao nằm trong phần mở rộng. Hộp đổi event cho xem trước rồi mới áp dụng. Phần TP2 ↔ API dùng **Giống API**, **Khác API**, **Chưa kết luận**. Các nút **Kết thúc phiên**, **Kết thúc và xuất báo cáo**, **Xuất báo cáo** hiện đủ chữ trên từng dòng riêng.

**Kết thúc** chỉ lưu bằng chứng; **Kết thúc & xuất…** cho chọn riêng báo cáo đối chiếu, danh sách event tracking đã xuất hiện, TP2 hoặc chi tiết API trong HTML/Excel/JSON. Tab event có nút **Xuất danh sách event**. Hướng dẫn: [docs/TP2_AND_EXPORT.md](docs/TP2_AND_EXPORT.md).

Máy build cần esbuild 0.25.12 cài riêng ngoài repository. Bước gộp thư viện là bắt buộc; bộ đóng gói kiểm tra manifest và hash lockfile để tránh dùng nhầm thư viện cũ. Đây chỉ là bước build; người dùng gói tải không cần cài thêm gì.

Bấm tên event để xem **Event Details → Default Parameters → Custom Parameters**; dữ liệu lồng nhau có **Show Details**. JSON và payload gốc có tab riêng. GA4 được giải mã danh sách sản phẩm thay vì chỉ hiện chuỗi `pr1`. Danh sách hoạt động ghép queue/request phù hợp thành một dòng, giữ nguyên bằng chứng gốc và mọi request phát lặp.

Gói có thể kèm danh mục tham khảo khi build với đối số `CATALOGUE_DIR`, nạp sẵn dưới dạng draft; JSON và Excel nằm trong `event-catalogue/`. Mẫu App SDK cần xác nhận mapping sang Web trước khi dùng để kết luận website đúng/sai. Bản portable lưu trong Git không kèm dữ liệu workbook của người dùng; nhập JSON/XLSX riêng ở bước Đặc tả tracking khi cần.

Gói được kiểm tra checksum runtime chính thức và tính toàn vẹn ZIP. Bản cập nhật được kiểm thử mã, trình duyệt và ca mô phỏng proxy/TLS trong môi trường build; chưa xác nhận trên Windows hoặc mạng công ty thực tế của bạn. Không đóng kèm khóa API hoặc profile đăng nhập.

Tạo lại gói trên máy build đã cài dependencies theo lockfile:

```sh
npm install --prefix /tmp/eventqa-build-tools --no-audit --no-fund esbuild@0.25.12
node scripts/bundle-portable-deps.mjs /tmp/eventqa-build-tools/node_modules/esbuild/lib/main.js /tmp/eventqa-compact-deps
EVENTQA_PACKAGED_DEPS=/tmp/eventqa-compact-deps python3 scripts/build-portable.py node-v24.19.0-win-x64.zip SHASUMS256.txt portable/EventQA-Windows-x64.zip
python3 scripts/portable_archive.py portable/EventQA-Windows-x64.zip
```

Thư mục output của bước gộp phải trống; chọn thư mục mới cho mỗi lần build. Hai file runtime/checksum lấy từ `https://nodejs.org/dist/v24.19.0/`. Có thể thêm đối số thư mục danh mục ở cuối lệnh build; nếu bỏ qua thì gói không kèm dữ liệu workbook. Script đóng gói không tải mạng, không đóng gói `.env`, profile hoặc phiên làm việc.
