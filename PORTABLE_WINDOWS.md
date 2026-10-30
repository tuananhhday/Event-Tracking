# Bản portable Windows 64-bit

Tải [EventQA-Windows-x64.zip](portable/EventQA-Windows-x64.zip), chọn **Download raw file** nếu GitHub hiển thị trang xem file.

1. Giải nén **toàn bộ** ZIP vào thư mục có quyền ghi, ví dụ Documents\EventQA.
2. Mở `START_PORTABLE.cmd`; giữ cửa sổ lệnh mở khi dùng.
3. Giao diện tự mở. Chọn Chrome hoặc Edge đã có trên máy để chạy trình duyệt test.
4. Kết thúc phiên và xuất báo cáo, sau đó chạy `STOP_PORTABLE.cmd` để dừng.

Gói chứa Node.js **24.19.0 Windows x64** và thư viện theo lockfile. Không cần cài Node, chạy npm, tải package hay quyền quản trị. Chế độ được đóng gói là **CDP không AI**; không kèm Python/mitmproxy hoặc API key. Dữ liệu phiên và báo cáo nằm trong `runs/` trên máy sử dụng.

Máy phải cho phép chạy `node.exe`, file CMD và Chrome/Edge với cổng debug. Nếu công ty chặn thực thi hoặc có chính sách chặn debug trình duyệt, cần IT phê duyệt. Không tắt bảo vệ hoặc tìm cách vượt chính sách. Website vẫn cần truy cập được qua mạng công ty.

Gói được tạo trên Linux: đã kiểm tra checksum Node từ nguồn chính thức, cấu trúc ZIP, chạy code được giải nén và smoke CDP trên Linux. **Chưa chạy thử trực tiếp trên Windows**. Kiểm tra tại máy công ty: launcher hiện phiên bản Node, giao diện mở, chạy demo và xuất báo cáo XLSX được.

SHA-256 của ZIP: `ef0d317e7776a3d157f6ca1ab8b1cb45ccf98e6baa6f341e3da3bf6353ca8558`.

## Tạo lại gói

Trên máy build có Node 24+, Python 3 và Git:

```sh
npm ci --ignore-scripts --no-audit --no-fund
curl -fLO https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
curl -fLO https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip
python3 scripts/build-portable.py node-v24.19.0-win-x64.zip SHASUMS256.txt portable/EventQA-Windows-x64.zip
```

Script xác minh SHA-256 của runtime, chỉ lấy source được chọn và dependencies, không lấy `.env`, profile, phiên hay dữ liệu nhập. Giữ nguyên license Node và license của các thư viện trong gói. Thư viện native cần build Windows riêng; script từ chối đóng gói nếu phát hiện file `.node`.
