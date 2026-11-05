# Quy tắc và báo cáo

`importSpec(path)` nhận `.json` hoặc `.xlsx`. JSON phải có `cases: []`; trường `rules` của mỗi case tuân `docs/CONTRACT.md`. Workbook được đọc bằng ExcelJS và các payload literal được parse bằng JSON5, không chạy JavaScript trong ô.

Importer ưu tiên sheet `Tổng hợp Event tracking`, tự tìm hàng tiêu đề trong 50 dòng đầu. Có thể truyền `{sheet: 'Tên sheet'}`. Mỗi case giữ `file`, `sheet`, `row`. Các ô merged được đọc qua giá trị master của ExcelJS.

Sample chỉ giúp tạo bản nháp. `event`, `service`, `search_source` có thể thành so sánh cố định; `search_term`, destination, ngày và số khách dùng `context.search.*`. Trường chưa rõ dùng type và yêu cầu review. Toàn bộ quy tắc suy từ sample được gắn `needs_review`; cần xác nhận BA/QC trước khi chấp nhận kết quả. Cột `Rules`/`Expected Rules` có thể chứa JSON rule đã xác nhận để bỏ bước suy diễn này.

Rule engine hỗ trợ `eq`, `exists`, `not_exists`, `type`, `regex`, `one_of`, `range`, `ref`, `subset`, `ignore`, `optional`, count, thời gian từ Start Step và `after`. Chỉ event thuộc đúng case/step/layer/source trong thời gian step được tính. Response/failed lifecycle không bị tính thêm như một request. Backlog cũ không được gán vào step mới.

`NOT_EXECUTED` có nghĩa chưa chạy; thiếu context/định dạng rule không hợp lệ cần `REVIEW`. Case/rule chưa duyệt và step chưa hoàn tất luôn là `REVIEW`, vẫn giữ các check chênh lệch nhưng chưa tạo bug xác nhận. Mỗi lỗi có event evidence ID, hoặc step evidence ID nếu event vắng mặt. `JS_QUEUE` và `TRACKING_REQUEST` luôn được đối chiếu riêng; thành công HTTP không phải bằng chứng vendor đã ingest.

Nếu step khai báo `observed_layers`, các layer collector không quan sát được trả `REVIEW / LAYER_UNAVAILABLE`; phiên chỉ bắt request (không gắn hook) không thể kết luận thiếu event trong JS queue. Layer được quan sát vẫn chạy kiểm tra đầy đủ.

Exporter tạo sáu sheet `Run Summary`, `Test Cases`, `Expected Events`, `Actual Events`, `Comparison`, `Bug Reports`, cùng HTML, comparison JSON và mẫu bug Markdown. Exporter tự che dữ liệu nhạy cảm lần nữa trước khi ghi, giữ các QA session ID và cấu trúc rule/path/op. HTML escape toàn bộ dữ liệu và XLSX chống chuỗi bắt đầu bằng công thức. Không gửi bug lên Jira tự động.
