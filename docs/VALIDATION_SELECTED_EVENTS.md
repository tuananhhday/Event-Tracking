# Kiểm chứng bản chọn từng event

Ngày: 31/10/2026 (Việt Nam). Phạm vi bản này là Web trên Chrome/Edge; QC tự thao tác.

## Đã chạy

- `node --test --test-isolation=none test/*.test.mjs tests/*.test.mjs`: 224 PASS, 1 SKIP (bài website thật tùy chọn), không có bài FAIL.
- `npm run check`: kiểm tra cú pháp 69 file JavaScript.
- `node scripts/guided-smoke.mjs`: Chromium thật, trang và AI transport giả lập cục bộ. Nhập 7 yêu cầu, ban đầu không chọn; chọn riêng 5 yêu cầu gồm yêu cầu chung, giữ lựa chọn qua bộ lọc. AI chỉ nhận các ID được chọn và quy tắc params. Kết quả phân biệt 3 yêu cầu đã chạy, 1 bỏ qua, 1 chưa chạy; không tự kết luận đủ. Tải Excel có sheet Phạm vi kiểm, không có lỗi JavaScript hoặc tràn ngang ở 390px.
- `node scripts/checkout-smoke.mjs`: 6 click đặt hàng thử cục bộ đều hoàn tất ở chế độ queue và chỉ request; không chạy getter/toJSON của website, JSON tải về khớp request.
- `node scripts/flows-smoke.mjs`: tách 2 request Golf và 1 Flight, giữ lần phát lặp thực sự; tách SDK/queue và bóc event trong beforeSend.
- Đọc workbook WebOTA người dùng cung cấp: 168 yêu cầu, gồm 14 Golf và 18 Vé máy bay. Chọn thử 2 yêu cầu từng luồng chỉ tạo kế hoạch cho đúng 2 ID. Workbook riêng không được đưa vào Git/ZIP.

Các bài kiểm thu dữ liệu bao gồm batch, GA4 compact items, nguồn từng field, payload không giải mã đủ, raw push thiếu field dù model còn giá trị cũ, queue thay mới, phân biệt queue/SDK/request, event trước bước và event ngoài lựa chọn. Các bài báo cáo kiểm trạng thái chưa chạy/bỏ qua, số đếm độ phủ, che dữ liệu riêng tư và chống công thức Excel/chèn HTML.

## Giới hạn nghiệm thu

Các kiểm thử cục bộ không chứng minh website UAT thật gửi đúng dữ liệu hoặc vendor đã lưu event. Tag Assistant/GTM Preview và GA4 DebugView được mở riêng để đội có quyền đối chiếu; app chưa tích hợp quyền truy cập hoặc extension của các dịch vụ này.

Transport AI giả lập kiểm hợp đồng đầu vào/đầu ra và phạm vi ID; chưa xác minh kết quả model thật trong phiên cloud bị chặn OpenRouter. Native App chưa được hỗ trợ. Runtime Windows trong ZIP được xác minh checksum nguồn chính thức; gói được dựng và kiểm code trên Linux, chưa chạy trực tiếp trên Windows.
