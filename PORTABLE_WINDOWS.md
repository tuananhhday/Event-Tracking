# Bản portable Windows 64-bit

Tải [EventQA-Windows-x64.zip](portable/EventQA-Windows-x64.zip), chọn **Download raw file** nếu GitHub hiển thị trang xem file.

Mở trực tiếp luồng đơn giản: **Nhập yêu cầu → Chọn website → Thao tác từng bước → Xem kết quả**. Không phải chọn chế độ kỹ thuật hoặc sửa JSON.

Nếu cửa sổ test bị kẹt, kết thúc phiên, bật **Chỉ bắt request · không gắn hook vào website** rồi mở phiên mới. Đã kiểm tra click đặt hàng trên trang thử cục bộ; chưa nghiệm thu thao tác đặt dịch vụ trên website thật.

Mỗi bước có hướng dẫn thao tác, event mong muốn và các ô dữ liệu cần đối chiếu. Giá trị bổ sung có thể điền trong phần tùy chọn. Kết quả hiển thị event và params mong muốn/thực tế, chỉ rõ thiếu/sai/ngoài yêu cầu; JSON và bằng chứng nằm trong mục chi tiết.

1. Giải nén **toàn bộ** ZIP vào thư mục có quyền ghi, ví dụ Documents\EventQA.
2. Mở `START_PORTABLE.cmd`; giữ cửa sổ lệnh mở khi dùng.
3. Mở **Thiết lập AI**, dán API key và lưu trên máy này; dùng ngay và giữ cho lần mở sau.
4. Chọn file yêu cầu WebOTA; app tự đọc sheet **Tổng hợp Event tracking**. Có thể chọn sheet khác nếu cần. Workbook riêng của bạn không đóng kèm ZIP công khai.
5. Nhập URL Web/UAT, chọn Golf/Flight/luồng cần kiểm rồi bấm **AI hướng dẫn kiểm tra**. Website mở trong cửa sổ test.
6. Đọc hướng dẫn, điền dữ liệu bạn sẽ chọn, bấm **Bắt đầu bước** rồi thao tác trên website. Quay lại bấm **Tôi đã thao tác xong · Kiểm tra**. Lặp lại cho bước tiếp theo. Nhánh tùy chọn có thể bỏ qua và không thành lỗi thiếu event.
7. Xem tên event và bảng mong muốn/thực tế. Bấm **Kết thúc & xuất báo cáo** nếu cần Excel/HTML/JSON/danh sách lỗi. Chạy `STOP_PORTABLE.cmd` để dừng ứng dụng.

Gói chứa Node.js **24.19.0 Windows x64** và thư viện theo lockfile. Không cần cài Node, chạy npm, tải package hay quyền quản trị để dùng CDP và đọc Excel. AI cần mạng tới OpenRouter và API key lưu riêng trong `.env` trên máy bạn; ZIP/Git không chứa key. Mặc định lần lượt thử model free phù hợp, sau đó model trả phí rẻ nhất theo chi phí ước tính, tối đa 0,01 USD/tác vụ. Có thể bỏ tick trả phí trong tab AI. Proxy cần Python/mitmproxy riêng, chưa kèm trong gói. Dữ liệu phiên và báo cáo nằm trong `runs/` trên máy sử dụng.

Yêu cầu queue được so với queue thật; request/SDK là bằng chứng riêng. Một thao tác xuất hiện ở nhiều tầng không tự trở thành event trùng. Event trước lúc bắt đầu bước không được dùng để đạt bước đó. Giá trị động cần dữ liệu độc lập bạn đã chọn; có mặt/đúng kiểu chưa chứng minh đúng giá trị. Mẫu mâu thuẫn, tầng chưa quan sát được và hợp đồng chưa đủ rõ giữ trạng thái cần kiểm tra. AI không tự duyệt yêu cầu hoặc tạo actual. Nếu AI chưa kết nối, app ghi rõ hướng dẫn được lấy từ file.

Máy phải cho phép chạy `node.exe`, file CMD và Chrome/Edge với cổng debug. Nếu công ty chặn thực thi hoặc có chính sách chặn debug trình duyệt, cần IT phê duyệt. Không tắt bảo vệ hoặc tìm cách vượt chính sách. Website vẫn cần truy cập được qua mạng công ty.

Gói được tạo trên Linux: đã kiểm tra checksum Node từ nguồn chính thức, cấu trúc ZIP, chạy code được giải nén và smoke CDP trên Linux. **Chưa chạy thử trực tiếp trên Windows**. Kiểm tra tại máy công ty: launcher hiện phiên bản Node, giao diện mở, chạy demo và xuất báo cáo XLSX được.

SHA-256 của ZIP: `476ae0f49cf41a23d64bf49ce7c58c3f2f948358e03a71ea0ac8101342e53b68`.

Kiểm chứng bằng Chromium thật với trang và dữ liệu cục bộ: nhập file → tạo hướng dẫn → thao tác → phát hiện param sai/thiếu, event thiếu/thừa → bỏ qua nhánh tùy chọn → tải báo cáo expected/actual. Transport AI trong bài thử là giả lập; cloud hiện chặn kết nối OpenRouter nên không coi đây là bằng chứng gọi model thật hoặc nghiệm thu website của công ty.

## Tạo lại gói

Trên máy build có Node 24+, Python 3 và Git:

```sh
npm ci --ignore-scripts --no-audit --no-fund
curl -fLO https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
curl -fLO https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip
python3 scripts/build-portable.py node-v24.19.0-win-x64.zip SHASUMS256.txt portable/EventQA-Windows-x64.zip
```

Script xác minh SHA-256 của runtime, chỉ lấy source được chọn và dependencies, không lấy `.env`, profile, phiên hay dữ liệu nhập. Giữ nguyên license Node và license của các thư viện trong gói. Thư viện native cần build Windows riêng; script từ chối đóng gói nếu phát hiện file `.node`.
