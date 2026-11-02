# Windows: giải nén rồi bấm chạy

Tải [EventQA-Windows-x64.zip](portable/EventQA-Windows-x64.zip), chọn **Download raw file** trên GitHub.

1. Giải nén **toàn bộ** ZIP vào một thư mục có quyền ghi.
2. Bấm **CHAY_EVENT_QA.cmd**. Giao diện bản thường tự mở trong trình duyệt. Muốn dùng bản AI, bấm **CHAY_EVENT_QA_AI.cmd**; lần đầu mở tab **✦ Trợ lý AI**, dán key OpenRouter rồi bấm **Bật AI**.
3. Giữ cửa sổ lệnh mở khi dùng. Bấm **STOP_EVENT_QA.cmd** để dừng.

Gói đã có Node.js 24.19.0 Windows x64 và thư viện theo lockfile. Không cần cài Node hay gõ lệnh npm. Máy cần có Chrome hoặc Edge. Bản AI cần OpenRouter key riêng, nhập ngay trong giao diện (xem `docs/AI.md`).

Thư viện JavaScript trong bản tải được gộp thành vài bundle, giảm hàng nghìn file nhỏ khi giải nén trên Windows. License các thư viện được giữ trong `node_modules/THIRD_PARTY_LICENSES.txt`.

Để tạo bản ít file, cài esbuild 0.25.12 riêng cho máy build, chạy `scripts/bundle-portable-deps.mjs` với đường dẫn module esbuild và thư mục output; đặt `EVENTQA_PACKAGED_DEPS` trỏ đến output đó khi chạy `scripts/build-portable.py`. Đây chỉ là bước build; người dùng gói tải không cần cài thêm gì.

Giao diện workspace của bản portable trước được khôi phục. Bấm tên event để xem **Event Details → Default Parameters → Custom Parameters**; dữ liệu lồng nhau có **Show Details**. JSON và payload gốc có tab riêng. GA4 được giải mã danh sách sản phẩm thay vì chỉ hiện chuỗi `pr1`. Danh sách hoạt động ghép queue/request phù hợp thành một dòng, giữ nguyên bằng chứng gốc và mọi request phát lặp.

Gói có thể kèm danh mục tham khảo khi build với đối số `CATALOGUE_DIR`, nạp sẵn dưới dạng draft; JSON và Excel nằm trong `event-catalogue/`. Mẫu App SDK cần xác nhận mapping sang Web trước khi dùng để kết luận website đúng/sai. Bản portable lưu trong Git không kèm dữ liệu workbook của người dùng; nhập JSON/XLSX riêng ở bước Đặc tả tracking khi cần.

Đã kiểm checksum runtime chính thức, tính toàn vẹn ZIP, và chạy thử gói trên Windows 11: cả bản thường và bản AI khởi động bằng `runtime/node.exe`, nhập được file Martech_WebOTA và Martech_AppOTA_Insider. Không đóng kèm khóa API hoặc profile đăng nhập.

Tạo lại gói trên máy build đã cài dependencies theo lockfile:

```sh
python3 scripts/build-portable.py node-v24.19.0-win-x64.zip SHASUMS256.txt portable/EventQA-Windows-x64.zip runs/event-catalogue
```

Hai file runtime/checksum lấy từ `https://nodejs.org/dist/v24.19.0/`. Đối số danh mục cuối là tùy chọn; không có đối số này thì gói không kèm dữ liệu workbook. Script không tải mạng, không đóng gói `.env`, profile hoặc phiên làm việc.
