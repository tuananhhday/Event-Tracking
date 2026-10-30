# Windows: giải nén rồi bấm chạy

Tải [EventQA-Windows-x64.zip](portable/EventQA-Windows-x64.zip), chọn **Download raw file** trên GitHub.

1. Giải nén **toàn bộ** ZIP vào một thư mục có quyền ghi.
2. Bấm **CHAY_EVENT_QA.cmd** hoặc **START_PORTABLE.cmd**. Giao diện CDP tự mở trong trình duyệt.
3. Giữ cửa sổ lệnh mở khi dùng. Bấm **STOP_EVENT_QA.cmd** để dừng.

Gói đã có Node.js 24.19.0 Windows x64 và thư viện theo lockfile. Không cần cài Node hay gõ lệnh npm. Máy cần có Chrome hoặc Edge. AI cần key riêng; Proxy cần mitmproxy riêng.

Giao diện workspace của bản portable trước được khôi phục. Bấm tên event để xem **Event Details → Default Parameters → Custom Parameters**; dữ liệu lồng nhau có **Show Details**. JSON và payload gốc có tab riêng. GA4 được giải mã danh sách sản phẩm thay vì chỉ hiện chuỗi `pr1`. Danh sách hoạt động ghép queue/request phù hợp thành một dòng, giữ nguyên bằng chứng gốc và mọi request phát lặp.

Gói có thể kèm danh mục tham khảo khi build với đối số `CATALOGUE_DIR`, nạp sẵn dưới dạng draft; JSON và Excel nằm trong `event-catalogue/`. Mẫu App SDK cần xác nhận mapping sang Web trước khi dùng để kết luận website đúng/sai. Bản portable lưu trong Git không kèm dữ liệu workbook của người dùng; nhập JSON/XLSX riêng ở bước Đặc tả tracking khi cần.

Đã kiểm checksum runtime chính thức, tính toàn vẹn ZIP và ứng dụng với Chromium trên Linux. Chưa chạy launcher trực tiếp trên Windows. Không đóng kèm khóa API, profile đăng nhập hoặc CA proxy.

Tạo lại gói trên máy build đã cài dependencies theo lockfile:

```sh
python3 scripts/build-portable.py node-v24.19.0-win-x64.zip SHASUMS256.txt portable/EventQA-Windows-x64.zip runs/event-catalogue
```

Hai file runtime/checksum lấy từ `https://nodejs.org/dist/v24.19.0/`. Đối số danh mục cuối là tùy chọn; không có đối số này thì gói không kèm dữ liệu workbook. Script không tải mạng, không đóng gói `.env`, profile hoặc phiên làm việc.
