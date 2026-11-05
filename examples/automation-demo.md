# Luồng demo: Tìm khách sạn Phú Quốc

Website bắt đầu: http://127.0.0.1:4174/demo

Trình duyệt: Google Chrome.

Đây là trang demo có sẵn trong EventQA. Mở bản AI bằng CHAY_EVENT_QA_AI.cmd trước khi thực hiện. Nếu ứng dụng dùng cổng khác 4174, thay cổng trong địa chỉ website.

## Dữ liệu đầu vào

- Điểm đến: Phú Quốc.
- Người lớn: 2.
- Số đêm: 1.

## Các bước thao tác

1. Chờ ô nhập có nhãn “Điểm đến” xuất hiện.
2. Điền Phú Quốc vào ô Điểm đến.
3. Điền 2 vào ô Người lớn và 1 vào ô Số đêm.
4. Bỏ chọn “Bỏ destination_id để tạo lỗi”.
5. Bấm nút “Tìm khách sạn”.
6. Chờ phần kết quả bên dưới hiển thị search_submit và Phú Quốc.

## Kết quả mong đợi

- Website đẩy event search_submit vào dataLayer.
- Có request GA4 gửi search_submit lên endpoint /demo/g/collect.
- Dữ liệu event có service là hotel, destination là Phú Quốc, quantity_adult là 2 và service_duration là 1.
- Có destination_id.
- Event và API được giữ trong phiên EventQA; xuất báo cáo bằng nhận xét của công cụ.

Chạy tay trước. Lịch tự chạy để tắt; chỉ bật 07:00 hằng ngày theo giờ Việt Nam sau khi luồng chạy đúng.

File automation-demo.json trong cùng thư mục đã mô tả sẵn các thao tác và event mong đợi. Nạp file JSON đó không cần gọi AI. Để kiểm từng trường theo rule của demo, nhập thêm examples/cases.json vào phần đặc tả và gắn case TC-HOTEL-SEARCH-001 cho bước tìm kiếm trong kịch bản.
