# Áp dụng file WebOTA vào EventQA

File tham khảo được cung cấp ngày 30/10/2026: `Martech_WebOTA_20260501.xlsx`. Workbook được đọc như dữ liệu, không thực thi code trong ô và không đóng kèm bản ZIP công khai.

## Kết quả đọc

Workbook có 30 sheet. Sheet `Tổng hợp Event tracking` có **168 dòng event: 102 GA4, 66 Insider**. Số dòng theo luồng: All 6, Khách sạn 21, Vui chơi trải nghiệm 19, Vé máy bay 18, Combo 21, Golf 14, Event 19, Train 18, Voucher 12, Merchandise 20.

Importer đọc được 165 sample. Ba sample cần kiểm tra thủ công tại sheet tổng hợp: `event_checkout` dòng 104, `confirmation_page_view` dòng 105, `purchase_fail` dòng 123. Dòng 63 của `search_combo` có sample ghi `flight_changed`; giữ cảnh báo để QC duyệt mapping. Không tự chọn revision theo tên sheet, gộp tất cả sheet hoặc coi kết quả test cũ là expected mới.

## Cách app sử dụng

Giao diện mặc định hiện là [luồng kiểm tra từng bước](GUIDED_WORKFLOW.md). Upload tự nhập sheet ưu tiên; AI có thể nhóm event cùng trigger thành một bước, và kết quả hiển thị mong muốn/thực tế ngay trên màn hình. Các thao tác ở tab AI/đối chiếu cũ dưới đây vẫn có trong Nâng cao.

1. Chọn file trên máy, sheet tổng hợp được chọn tự động; bấm Nhập file. App giữ vendor, luồng, Event Name, mô tả trigger, sample, notes và sheet/dòng.
2. Chọn riêng luồng và nguồn cần kiểm: dataLayer/InsiderQueue, SDK hoặc request. Tên giống nhau giữa Golf/Flight không đủ để match chéo.
3. Trong tab AI, chọn event từ danh sách rồi dùng yêu cầu đã nhập để tạo nháp. Đây là dùng requirements làm ngữ cảnh cho tác vụ, không phải huấn luyện model mới hoặc tự gửi toàn bộ workbook ra ngoài.
4. Các giá trị phụ thuộc thao tác cần mapping `context.*`. QC duyệt quy tắc trước khi dùng nghiệm thu; chỉ kiểm kiểu hoặc có mặt không xác nhận giá trị đúng. Nhánh auto coverage cũng giữ REVIEW cho rule nháp và field động chưa có context.
5. Event actual giữ nguyên bằng chứng gốc, nguồn quan sát và đường dẫn params; không lấy sample điền actual. Bộ giải mã Insider có thể trình bày `c_*` trong nhóm custom nhưng vẫn giữ raw và provenance.

File AppOTA/Insider là tài liệu tham khảo riêng. Không ép Web phải có app_version, device_model hoặc platform=AppOTA chỉ vì mẫu App có các trường đó. Những hợp đồng trigger/params chưa rõ cần được duyệt, không tự báo PASS.

## UAT và thiết bị

UAT là môi trường. Web trên PC, Web trên trình duyệt điện thoại và native App Android/iOS là các đối tượng kiểm khác nhau; cả ba đều có thể trỏ UAT. Gói Windows hiện tại kiểm Web desktop theo đúng URL nhập, không giả lập việc thu event của native App.

Trong file Web, sheet tổng hợp có cột C Luồng, D Event Name, E Event Description, F DataLayer Sample, G Note và H `check prod`. Một số sample có URL UAT; điều này không biến sample thành testcase UAT riêng. Dùng hợp đồng Web đã duyệt trên môi trường cần kiểm, với dữ liệu và cấu hình GA4/Insider đúng môi trường đó.

Trong file App, `R3107!O10`, `O14`, `O23` nhắc test UAT nhưng thuộc cột **iOS Actual**. Đây là dữ liệu/lịch sử test App, không lấy làm expected của Web. Trigger và yêu cầu App nằm ở các cột D–G của sheet đó.

Đã kiểm tra upload và nhập đủ 168 event trong Chromium, lấy đúng yêu cầu Golf/Insider sang input AI, lưu key cục bộ và nạp lại sau khi khởi động. Logic model fallback được kiểm tra bằng giả lập; cloud hiện bị proxy từ chối kết nối OpenRouter, nên lượt này chưa xác minh API key hoặc gọi model thật.
