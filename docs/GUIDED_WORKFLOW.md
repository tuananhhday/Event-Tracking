# Kiểm tra tracking theo hướng dẫn

Luồng mặc định: **chọn file → chọn từng event cần test và website → làm từng bước → xem mong muốn/thực tế và độ phủ**. Các chế độ kỹ thuật nằm trong Nâng cao.

## Cách sử dụng

1. Giải nén ZIP Windows và mở `START_PORTABLE.cmd`.
2. Nếu cần AI, lưu API key một lần ở Thiết lập AI. Key nằm riêng trên máy; ưu tiên model miễn phí, sau đó model trả phí rẻ nhất phù hợp trong ngân sách.
3. Chọn file yêu cầu Web. Sheet **Tổng hợp Event tracking** được ưu tiên và tự nhập. Chọn riêng Golf, Flight hoặc luồng cần kiểm cùng URL Web/UAT.
4. Tích chọn từng yêu cầu/event muốn test. Ban đầu chưa có dòng nào được chọn. Lọc theo nền tảng tracking hoặc tìm tên event/thao tác; **Chọn các dòng đang thấy** chỉ chọn kết quả đang hiển thị. Bật **Hiện thêm yêu cầu chung** khi cần đăng nhập hoặc yêu cầu All, rồi chọn riêng các dòng đó. Đổi bộ lọc không tự xóa lựa chọn; xem số lựa chọn đang ẩn trước khi tiếp tục. Yêu cầu App được ghi rõ và không được chọn để kiểm website.
5. Mở chi tiết dòng nếu cần xem trigger, từng trường, mẫu và cảnh báo yêu cầu. Bấm **Hướng dẫn phần đã chọn**. Chỉ các ID đã chọn được gửi cho AI; AI sắp xếp thành thao tác, không thêm event, sửa expected hoặc tự duyệt rule. Nếu AI không kết nối, nguồn hướng dẫn từ file được ghi rõ.
6. Đọc hướng dẫn hiện tại. Điền dữ liệu bạn sẽ chọn trên website vào các ô cần thiết; có thể bổ sung giá trị cụ thể trong phần tùy chọn. Bấm **Bắt đầu bước**, thao tác ở cửa sổ website test, rồi **Tôi đã thao tác xong · Kiểm tra**. Với trigger xem trang, bắt đầu bước trước rồi mới vào/tải lại đúng trang.
7. Đọc tên event mong muốn/thực tế và bảng từng param. Event thiếu, event ngoài bước, field thiếu, sai kiểu/giá trị được ghi riêng. Event đã biết thuộc yêu cầu không chọn được giữ ngoài phạm vi; event nghiệp vụ chưa có hợp đồng được ghi để xem thêm, không tự thành lỗi đã xác nhận. Tham số bổ sung không tự thành lỗi nếu yêu cầu không cấm. Có thể bỏ qua một bước; bước bỏ qua không được tính là đã đạt hoặc lỗi thiếu.
8. Xem bảng **Độ phủ phần bạn đã chọn**. Khi cần file, **Kết thúc & xuất báo cáo** để tải Excel/HTML/JSON/danh sách lỗi có cùng phạm vi và bằng chứng.

## Đọc độ phủ

Mẫu số là số requirement được chọn, không phải tổng số event browser phát ra. **Đã thực hiện + đã bỏ qua + chưa chạy = đã chọn**; bước đang ghi vẫn thuộc phần chưa hoàn tất. Những yêu cầu cùng luồng không chọn và yêu cầu thuộc luồng khác được ghi riêng trong báo cáo, không trở thành thiếu event.

| Trạng thái yêu cầu | Ý nghĩa |
|---|---|
| Chưa chạy / đang thực hiện | Chưa có kết quả hoàn tất cho yêu cầu này |
| Đã bỏ qua | Người thao tác bỏ bước; chưa nghiệm thu |
| Thiếu event / có phần sai | Có bằng chứng đối chiếu cho thấy thiếu hoặc sai trong bước đã thực hiện |
| Đã kiểm, chưa đủ căn cứ | Ví dụ đúng kiểu/có field nhưng chưa có expected độc lập, rule chưa duyệt, nguồn chưa rõ hoặc capture chưa đủ |
| Đã xác minh | Các phép kiểm bắt buộc có căn cứ và khớp, hợp đồng đã được xác nhận, không còn điểm chưa rõ trong yêu cầu này |

Số trường khai báo trong mẫu khác số phép kiểm thực tế: một template item có thể mở rộng cho nhiều phần tử. Báo cáo giữ cả hai số để tránh hiểu nhầm đã kiểm mọi giá trị. Sample chỉ giúp xác định cấu trúc; cần dữ liệu độc lập từ lựa chọn QC hoặc yêu cầu đã duyệt để xác minh giá trị động. Đạt giới hạn xử lý phải giữ REVIEW, không báo đã kiểm đủ.

## Nguyên tắc lấy và đọc event

- Yêu cầu `dataLayer`/`InsiderQueue` so với queue đã quan sát. SDK và request là bằng chứng khác của thao tác, không tự dùng thay queue hoặc cộng thành lần bắn trùng.
- Yêu cầu wire `{event_name,event_params}` hoặc request envelope so với request. `Ucd:event:beforeSend` được bóc từng event con, nhưng vẫn là quan sát SDK trước khi gửi.
- Giữ raw envelope và index khi batch có nhiều event; không lấy params của event bên cạnh. GA4 `ep.*`/`epn.*` và item compact `pr1`, `pr2`… giữ nguồn wire cùng đường dẫn chuẩn hóa. Item trong request không tự trở thành raw `dataLayer.ecommerce.items`. Token chưa hiểu hoặc payload lỗi phải có cảnh báo.
- Raw dataLayer push là message app đã phát ở thời điểm đó. Model dựng từ các message khai báo đã quan sát chỉ giúp xem giá trị kế thừa/reset; không phải private state đầy đủ của GTM. Model không được tự điền field thiếu vào raw push để đạt bài kiểm. Hàm, command hoặc lịch sử không đủ khiến model chưa hoàn chỉnh.
- Chỉ quan sát trong khoảng bắt đầu/hoàn tất bước. Backlog/historical và response lifecycle không đáp ứng hoặc đếm thêm event. Bắt đầu trước khi tải lại trang khi kiểm trigger page view.
- Golf không được đáp ứng bằng Flight chỉ vì tên event giống nhau. Không đọc được body/tầng cần kiểm thì đánh dấu cần kiểm tra, không bịa params hoặc tự báo thiếu chắc chắn.
- Sample minh họa không phải giá trị actual. Dữ liệu động phải có căn cứ độc lập từ người thao tác. Từng phần tử mảng được kiểm theo các trường yêu cầu, không chỉ phần tử đầu.
- Mẫu cart Golf bị dán sai type trong workbook Web được đánh dấu mâu thuẫn yêu cầu. Sheet App điện thoại có marker rõ không dùng trực tiếp làm hợp đồng Web.
- HTTP thành công chưa chứng minh vendor đã nhận và lưu dữ liệu. Trigger ở bản này được xác nhận qua cửa sổ thao tác thủ công, không phải suy luận từ tên event.

## Đối chiếu thêm với công cụ Google

Trong phần chọn yêu cầu có liên kết mở **Tag Assistant**, **GTM Preview** và **GA4 DebugView**. Dùng phiên GTM có quyền để kiểm tag/trigger/variables, và DebugView để đối chiếu phía GA4 khi đã cấu hình debug phù hợp. Các công cụ này mở riêng; app không tự đăng nhập, cài extension, đọc private API hoặc xác nhận vendor receipt. Chưa có chức năng nhập HAR.

Xem [nghiên cứu GTM/GA4 và GitHub](TRACKING_TOOL_RESEARCH.md) để biết snapshot, license và giới hạn của nguồn Google, Chrome DevTools, Omnibug và GA4MP. Omnibug/GA4MP là công cụ bên thứ ba.

## Kiểm chứng và giới hạn

`node scripts/guided-smoke.mjs` chạy Chromium thật, trang thử cục bộ và transport AI giả lập. Bài thử đi từ upload/chọn yêu cầu tới tải báo cáo, chủ động tạo param sai/thiếu, event thiếu/thừa, nhiều tầng của một thao tác và bước bỏ qua. Không tạo giao dịch hoặc gửi dữ liệu tới dịch vụ ngoài.

Cloud hiện chặn OpenRouter; kiểm chứng bằng mock không được coi là xác nhận model/key thật. Gói được build trên Linux với Node Windows chính thức đã xác minh checksum; cần kiểm tra thực thi trên máy Windows đích. Native App chưa nằm trong phạm vi bản Web này.
