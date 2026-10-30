# Event đầy đủ và danh mục Insider

Mục tiêu là xem một event nghiệp vụ với toàn bộ payload đã thu, thay vì coi tín hiệu cấu hình, trạng thái SDK hoặc từng tham số là một event riêng.

## Đọc đặc tả

Ở bước **Đặc tả tracking**, nhập XLSX hoặc JSON. Tab **Đối chiếu đặc tả** cho phép bấm tên event để xem cấu trúc mẫu ngay cả khi chưa bắt được event. Có thể tải toàn bộ danh mục JSON bằng **Tải danh mục event**.

Importer nhận cột `Sample Payload (App)` và `Chi tiết event`, bên cạnh `DataLayer Sample`. Các sheet phải có cột mẫu hoặc rule; sheet test/UAT, Adjust và thuộc tính người dùng không tự nhập thành đặc tả event. Có thể nhập riêng một sheet để chọn đúng phiên bản, tránh trộn các release có cùng tên event.

Mỗi dòng giữ tên event chuẩn, nhãn hiển thị trong mẫu, luồng, trigger/mô tả, phương thức SDK, tham số, sheet và dòng nguồn. Các nhóm `default_parameters` và `custom_parameters`, mảng và kiểu dữ liệu được giữ nguyên. Các lời gọi SDK cho nhiều sản phẩm được giữ riêng trong `sample_variants`, không trộn thành một sản phẩm.

Parser chỉ đọc literal và chữ ký SDK được hỗ trợ; không chạy JavaScript, Swift, Java, macro hoặc công thức từ workbook. Trạng thái đọc mẫu:

- `complete`: đã đọc cấu trúc có trong mẫu; không có nghĩa website đã triển khai đúng.
- `partial`: đọc được một phần, có placeholder hoặc cú pháp chưa giải quyết; xem cảnh báo và mẫu gốc.
- `unparsed`: chưa có cấu trúc đọc được; không tự tạo trường hay giá trị thay thế.

Ví dụ SDK nguồn App được đánh dấu `APP_SDK`. Đây là tài liệu tham khảo cho website: cần tạo rule từ bằng chứng Chrome hoặc sửa đường dẫn rule theo Web, xác nhận mapping rồi bỏ marker `capture_platform` trên rule. Chỉ tick duyệt không tự chuyển cấu trúc App thành Web. Mẫu chưa hoàn chỉnh và App chưa mapping trả REVIEW. Đối chiếu tự do cũng không báo PASS cho rule rỗng. Khi nhiều dòng có cùng điểm phù hợp, công cụ báo cần xác định luồng thay vì tự chọn dòng đầu.

## Event thực tế trên Chrome

Trong **Event trực tiếp**, mở event để xem **Event đầy đủ · thực tế đã thu** và sao chép JSON. Đây là `payload` thực tế đã che thông tin nhạy cảm; không điền thêm tham số từ mẫu. Bảng tham số là cách đọc bổ sung; JSON không bị cắt theo giới hạn dòng/cột của bảng.

`InsiderDispatch` giữ tham số trực tiếp và `insider_object` giữ snapshot đầy đủ. Snapshot và dispatcher nội bộ được phân loại `observation`, cấu hình SDK là `system`; mặc định chỉ hiện `business`. Có thể bật **Hiện tín hiệu kỹ thuật** để xem bằng chứng còn lại. Snapshot không chứng minh một event đã được phát hoặc gửi.

Một push/request chứa nhiều event vẫn được tách theo từng event để so rule. `queue_payload`/`request_payload` giữ batch đầy đủ đã che dữ liệu cùng chỉ số phần tử. Không ghép tham số giữa các event. Dữ liệu opaque vẫn chỉ giữ hash/lý do, không tự giải mã hoặc tái tạo payload.

Browser CDP chỉ thu bằng chứng Web. HTTP 2xx chỉ chứng minh phản hồi vận chuyển, chưa xác nhận Insider ingest hay ghi nhận event trên dashboard.

## Nguồn Insider chính thức đã đối chiếu

- [Product Detail với custom parameters](https://github.com/useinsider/SwiftDemo/blob/56aeb67d12c7b507f044ac2b999deb5452040083/Native/Sources/Actions/Events/VisitProductDetailPageWithCustomParametersAction.swift): đối tượng product và custom parameters riêng.
- [Add to Cart với custom parameters](https://github.com/useinsider/SwiftDemo/blob/56aeb67d12c7b507f044ac2b999deb5452040083/Native/Sources/Actions/Product/ItemAddedToCartWithCustomParametersAction.swift).
- [Listing Page](https://github.com/useinsider/SwiftDemo/blob/56aeb67d12c7b507f044ac2b999deb5452040083/Native/Sources/Actions/Events/VisitListingPageWithCustomParametersAction.swift): taxonomy và custom parameters riêng.
- [Custom event builder](https://github.com/useinsider/SwiftDemo/blob/56aeb67d12c7b507f044ac2b999deb5452040083/Native/Sources/ViewControllers/CustomEventViewController.swift#L196): `tagEvent` → `addParameterWith…` → `build`.

Các nguồn trên là Mobile SDK; không khẳng định payload mạng Web giống chúng. Host tài liệu Academy/Developer của Insider chưa truy cập được do chính sách mạng của môi trường; không dùng nguồn đó để khẳng định giao thức Web mới nhất.

## Kiểm tra

`npm run check`, `npm test` và `npm run smoke:local`. Toàn bộ test ứng dụng nằm trong `tests/`. Prototype `cloud/` thiếu module/asset và không thuộc workflow hiện tại đã được loại bỏ. Smoke local kiểm ba case đúng và hai case cố ý sai; FAIL trong hai case này là kết quả mong đợi.
