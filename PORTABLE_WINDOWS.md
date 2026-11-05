# Windows: giải nén rồi bấm chạy

Tải [bản Windows đầy đủ](https://codeload.github.com/tuananhhday/Event-Tracking/zip/refs/heads/download/windows-full-simple-comparison-20261105). Giải nén một lần để có ứng dụng, Node và thư viện. Repo cũng lưu [EventQA-Windows-x64.zip](portable/EventQA-Windows-x64.zip).

1. Giải nén **toàn bộ** ZIP vào một thư mục có quyền ghi.
2. Bấm **CHAY_EVENT_QA.cmd**. Giao diện bản thường tự mở trong trình duyệt. Muốn dùng bản AI, bấm **CHAY_EVENT_QA_AI.cmd**; lần đầu mở tab **✦ Trợ lý AI**, dán key OpenRouter rồi bấm **Bật AI**.
3. Giữ cửa sổ lệnh mở khi dùng. Bấm **STOP_EVENT_QA.cmd** để dừng.

Khi cập nhật, dừng ứng dụng cũ bằng **STOP_EVENT_QA.cmd** trước khi mở thư mục mới để trình duyệt không tiếp tục dùng tiến trình của bản cũ. Giữ thư mục phiên làm việc cũ nếu cần xem lại báo cáo.

Gói đã có Node.js 24.19.0 Windows x64 và thư viện theo lockfile. Không cần cài Node hay gõ lệnh npm. Máy cần có Chrome hoặc Edge. Bản AI cần OpenRouter key riêng, nhập ngay trong giao diện (xem `docs/AI.md`).

Bản AI được mở bằng `CHAY_EVENT_QA_AI.cmd` sẽ dùng kho chứng chỉ tin cậy của Windows và proxy `HTTPS_PROXY`/`HTTP_PROXY` nếu đã khai báo trong môi trường hoặc `.env`. Có thể khai báo file CA do IT cung cấp qua `NODE_EXTRA_CA_CERTS`. Dừng và mở lại ứng dụng sau khi đổi cấu hình mạng. Tab **Trợ lý AI → Kiểm tra kết nối AI** phân biệt lỗi chứng chỉ, DNS, kết nối và proxy 403/407; xem [hướng dẫn mạng công ty](docs/AI.md#khi-dùng-mạng-công-ty).

Gói tải chứa đầy đủ thư viện JavaScript theo lockfile cùng license trong từng thư viện. Cần giải nén toàn bộ thư mục trước khi chạy.

Bản hiện tại chỉ đối chiếu đặc tả sau khi **Chọn luồng kiểm tra**. **Test lại** tạo lượt mới; **Đổi event so sánh** chọn bằng chứng trong lượt đang xem. Giao diện giữ bố cục cũ với thanh thiết lập bên trái và bảng event bên phải. Tab **TP2 ↔ API** tự giải mã `ue_px`, tìm API và ghép trường theo mã đơn/sản phẩm, gồm các lần gọi lại `myorder`.

Chữ và nút dùng kích thước cũ; tên dài được ngắt dòng. Danh sách sheet có ô tìm kiếm và vùng cuộn giới hạn để hiện đủ tên sheet. Dữ liệu cá nhân được nhận diện sẽ được băm HMAC-SHA256 trước mọi lời gọi AI; mật khẩu/token tiếp tục được che. Xem [cơ chế bảo vệ dữ liệu AI](docs/AI.md).

Đối chiếu đặc tả mở hai cột **Theo đặc tả / Thực tế**, ghi rõ GA4 hoặc Insider. Kết quả dùng **Chưa thấy lỗi**, **Có lỗi**, **Cần kiểm tra thêm**. Dòng chỉ kiểm kiểu ghi **Đúng kiểu dữ liệu… Chưa kiểm tra nội dung**; mục chưa được kiểm ghi **Chưa kiểm tra nội dung này**. Màu đỏ là lỗi cần sửa; màu vàng là khác mẫu, có giải thích ngay dưới từng mục. GA4 chỉ so GA4, Insider chỉ so Insider. Dữ liệu gốc và cách kiểm tra nâng cao nằm trong phần mở rộng. Hộp đổi event cho xem trước rồi mới áp dụng. Phần TP2 ↔ API dùng **Giống API**, **Khác API**, **Chưa kết luận**. Các nút **Kết thúc phiên**, **Kết thúc và xuất báo cáo**, **Xuất báo cáo** hiện đủ chữ trên từng dòng riêng.

**Kết thúc** chỉ lưu bằng chứng; **Kết thúc & xuất…** cho chọn riêng báo cáo đối chiếu, danh sách event tracking đã xuất hiện, TP2 hoặc chi tiết API trong HTML/Excel/JSON. Tab event có nút **Xuất danh sách event**. Hướng dẫn: [docs/TP2_AND_EXPORT.md](docs/TP2_AND_EXPORT.md).

Để tạo bản ít file, cài esbuild 0.25.12 riêng cho máy build, chạy `scripts/bundle-portable-deps.mjs` với đường dẫn module esbuild và thư mục output; đặt `EVENTQA_PACKAGED_DEPS` trỏ đến output đó khi chạy `scripts/build-portable.py`. Đây chỉ là bước build; người dùng gói tải không cần cài thêm gì.

Bấm tên event để xem **Event Details → Default Parameters → Custom Parameters**; dữ liệu lồng nhau có **Show Details**. JSON và payload gốc có tab riêng. GA4 được giải mã danh sách sản phẩm thay vì chỉ hiện chuỗi `pr1`. Danh sách hoạt động ghép queue/request phù hợp thành một dòng, giữ nguyên bằng chứng gốc và mọi request phát lặp.

Gói có thể kèm danh mục tham khảo khi build với đối số `CATALOGUE_DIR`, nạp sẵn dưới dạng draft; JSON và Excel nằm trong `event-catalogue/`. Mẫu App SDK cần xác nhận mapping sang Web trước khi dùng để kết luận website đúng/sai. Bản portable lưu trong Git không kèm dữ liệu workbook của người dùng; nhập JSON/XLSX riêng ở bước Đặc tả tracking khi cần.

Gói được kiểm tra checksum runtime chính thức và tính toàn vẹn ZIP. Bản cập nhật được kiểm thử mã, trình duyệt và ca mô phỏng proxy/TLS trong môi trường build; chưa xác nhận trên Windows hoặc mạng công ty thực tế của bạn. Không đóng kèm khóa API hoặc profile đăng nhập.

Tạo lại gói trên máy build đã cài dependencies theo lockfile:

```sh
python3 scripts/build-portable.py node-v24.19.0-win-x64.zip SHASUMS256.txt portable/EventQA-Windows-x64.zip runs/event-catalogue
```

Hai file runtime/checksum lấy từ `https://nodejs.org/dist/v24.19.0/`. Đối số danh mục cuối là tùy chọn; không có đối số này thì gói không kèm dữ liệu workbook. Script không tải mạng, không đóng gói `.env`, profile hoặc phiên làm việc.
