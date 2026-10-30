# Kiểm tra tracking theo hướng dẫn

Luồng mặc định: **chọn file → chọn website và luồng → làm từng bước → xem mong muốn/thực tế**. Các chế độ kỹ thuật nằm trong Nâng cao.

## Cách sử dụng

1. Giải nén ZIP Windows và mở `START_PORTABLE.cmd`.
2. Nếu cần AI, lưu API key một lần ở Thiết lập AI. Key nằm riêng trên máy; ưu tiên model miễn phí, sau đó model trả phí rẻ nhất phù hợp trong ngân sách.
3. Chọn file yêu cầu Web. Sheet Tổng hợp Event tracking được ưu tiên và tự nhập. Chọn riêng Golf, Flight hoặc luồng cần kiểm cùng URL Web/UAT.
4. Bấm AI hướng dẫn kiểm tra. AI chỉ sắp xếp và giải thích các yêu cầu đã có; không tạo event/params hoặc tự duyệt yêu cầu. Nếu AI không kết nối, nguồn hướng dẫn từ file được ghi rõ.
5. Đọc hướng dẫn hiện tại. Điền dữ liệu bạn sẽ chọn trên website vào các ô cần thiết; có thể bổ sung giá trị cụ thể trong phần tùy chọn. Bấm Bắt đầu bước, thao tác ở cửa sổ website test, rồi Tôi đã thao tác xong · Kiểm tra.
6. Đọc tên event mong muốn/thực tế và bảng từng param. Event thiếu, event ngoài bước, field thiếu, sai kiểu/giá trị được ghi riêng; tham số bổ sung không tự thành lỗi nếu yêu cầu không cấm. Nhánh thất bại/xóa giỏ có thể bỏ qua và giữ trạng thái chưa thực hiện.
7. Kết quả có ngay trên màn hình. Khi cần file, kết thúc và xuất Excel/HTML/JSON/danh sách lỗi.

## Nguyên tắc lấy và đọc event

- Yêu cầu `dataLayer`/`InsiderQueue` so với queue đã quan sát. SDK và request là bằng chứng khác của thao tác, không tự dùng thay queue hoặc cộng thành lần bắn trùng.
- Yêu cầu wire `{event_name,event_params}` hoặc request envelope so với request. `Ucd:event:beforeSend` được bóc từng event con, nhưng vẫn là quan sát SDK trước khi gửi.
- Giữ raw envelope và index khi batch có nhiều event; không lấy params của event bên cạnh. GA4 `ep.*`/`epn.*` giữ trường wire gốc và đường dẫn chuẩn hóa.
- Chỉ quan sát trong khoảng bắt đầu/hoàn tất bước. Backlog/historical và response lifecycle không đáp ứng hoặc đếm thêm event. Bắt đầu trước khi tải lại trang khi kiểm trigger page view.
- Golf không được đáp ứng bằng Flight chỉ vì tên event giống nhau. Không đọc được body/tầng cần kiểm thì đánh dấu cần kiểm tra, không bịa params hoặc tự báo thiếu chắc chắn.
- Sample minh họa không phải giá trị actual. Dữ liệu động phải có căn cứ độc lập từ người thao tác. Từng phần tử mảng được kiểm theo các trường yêu cầu, không chỉ phần tử đầu.
- Mẫu cart Golf bị dán sai type trong workbook Web được đánh dấu mâu thuẫn yêu cầu. Sheet App điện thoại có marker rõ không dùng trực tiếp làm hợp đồng Web.
- HTTP thành công chưa chứng minh vendor đã nhận và lưu dữ liệu. Trigger ở bản này được xác nhận qua cửa sổ thao tác thủ công, không phải suy luận từ tên event.

## Kiểm chứng và giới hạn

`node scripts/guided-smoke.mjs` chạy Chromium thật, trang thử cục bộ và transport AI giả lập. Bài thử đi từ upload file tới tải báo cáo, chủ động tạo param sai/thiếu, event thiếu/thừa, nhiều tầng của một thao tác và nhánh bỏ qua. Không tạo giao dịch hoặc gửi dữ liệu tới dịch vụ ngoài.

Cloud hiện chặn OpenRouter; kiểm chứng bằng mock không được coi là xác nhận model/key thật. Gói được build trên Linux với Node Windows chính thức đã xác minh checksum; cần kiểm tra thực thi trên máy Windows đích. Native App chưa nằm trong phạm vi bản Web này.
