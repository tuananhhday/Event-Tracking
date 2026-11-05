# TP2, đối chiếu API và xuất báo cáo

Tính năng có ở cả bản thường và bản AI. Việc bắt TP2, giải mã Base64, đối chiếu và xuất file chạy bằng mã nguồn trên máy, không gọi AI. AI nhận xét báo cáo event là lựa chọn riêng.

## Đọc TP2 trong phiên thao tác

1. Mở website bằng trình duyệt test của ứng dụng. Giữ bật **Lưu API Request/Response** và mẫu host API phù hợp để có dữ liệu đối chiếu. Mẫu mặc định hỗ trợ API Vinpearl UAT/PROD; website khác cần thêm mẫu host API.
2. Thao tác như bình thường. Đường dẫn kết thúc bằng `/tp2` được thu thập tự động, kể cả khi thay đổi allowlist tracking giữa phiên. Nếu website chỉ gửi khi đặt hàng, TP2 xuất hiện sau thao tác đó. Không có TP2 trong danh sách chưa phải kết luận thiếu event.
3. Mở tab **TP2 ↔ API**, bấm **Xem / đối chiếu**. **Kết quả so sánh** hiện ngay đầu cửa sổ, gồm tên trường, giá trị TP2, giá trị API và Khớp / Lệch / Cần kiểm tra. Không cần nhập JSON hoặc tạo cấu hình trước. Dữ liệu giải mã, schema và request gốc nằm trong các phần chi tiết có thể mở thêm.

Hỗ trợ Base64, Base64URL, `ue_pr` JSON thường, query/form và request JSON chứa nhiều event trong `data`. Mỗi event của batch là một dòng riêng. Base64/JSON sai được đánh dấu **Lỗi giải mã** và giữ thông tin chẩn đoán. Request/response của cùng một event chỉ tạo một dòng ở tab TP2.

## Tự tìm API và ghép trường

Ứng dụng tìm API đã thu thập trong cùng tab, có response trước TP2 và cách tối đa 30 phút. API liên quan phải có cùng mã đơn, sản phẩm, affiliate, campaign hoặc click; event có tên thể hiện mua hàng (`order`, `purchase`, `transaction`, `conversion`) còn xét endpoint `/myorder`. Không dùng giá hoặc tổng tiền bằng nhau để chọn API. Tên event có `click` nhưng chưa tìm thấy API liên quan được ghi nhận là click affiliate, không bị báo thiếu đơn hàng.

Các trường cùng tên (kể cả camelCase và snake_case) và một số tên tương đương được ghép tự động, ví dụ `productCode` / `product_id`, `orderCode` / `order_id`, `quantity` / `qty`. Sản phẩm ghép theo mã, kể cả khi khác thứ tự hoặc khác số tầng mảng; mã đơn phải khớp khi đi qua mảng đơn hàng. Các lần gọi lại cùng API và cùng mã dùng response gần nhất trước TP2. Luồng mua hàng ưu tiên `myorder`; API cùng mã có đủ trường tương ứng được ưu tiên theo cấu trúc, không theo giá trị khớp/sai.

Không tự lấy `productCode` so với `data.id` của đơn hàng, không ghép mảng theo vị trí hoặc theo giá trị tiền. Còn nhiều trường/API ngang nhau thì hiện **Chưa xác định được API** hoặc **Cần kiểm tra**. Có thể mở **Đổi API đối chiếu (tuỳ chọn)** hoặc **Sửa cách ghép** khi cần; luồng mặc định tự chạy và tự cập nhật khi có dữ liệu.

Kết quả mặc định giữ nguyên kiểu dữ liệu: chuỗi `"100"` khác số `100`. Trường không có bên API, đã che, body bị cắt hoặc chưa đủ bằng chứng đều được hiển thị để kiểm tra. **Khớp** chỉ áp dụng cho các trường đã kiểm tra, không chứng minh toàn bộ nghiệp vụ hoặc vendor đã nhận event. Tự ghép không suy ra được công thức tiền, thuế hay ý nghĩa tên trường riêng của từng website.

## Sửa và lưu cách ghép khi cần

Mở **Sửa cách ghép (nếu cần)** để chọn trường API từ danh sách và xem giá trị ngay cạnh TP2. Không còn ô JSON. Giữ tick các trường muốn kiểm tra; trường chưa ghép cần chọn lại hoặc chủ động bỏ tick. Bấm **Lưu cách ghép và so sánh** để dùng lại cho các event cùng tên. Với gợi ý có mảng, phần tử được tìm lại bằng mã sản phẩm trong các event sau, không tái sử dụng vị trí mảng cũ.

Trong **Tuỳ chỉnh nâng cao**:

- Điền tên event và đường dẫn hoặc regex API; chọn dữ liệu từ response hoặc request JSON.
- Có thể thêm từng cặp trường TP2 ↔ API hoặc bấm **Tự ghép lại** để lấy gợi ý mới.
- Chọn kiểu so sánh: đúng kiểu và giá trị JSON, số, chữ hoặc ngày. Số có thể so `"500000"` với `500000`; ngày so theo ngày lịch Việt Nam, ví dụ `2026-11-03T18:00:00Z` khớp `2026-11-04`.
- Nếu API trả một mảng, điền đường dẫn mảng và hai trường mã định danh để chọn đúng sản phẩm/đơn hàng. Đường dẫn trường API lúc này tính từ từng phần tử của mảng.

Ví dụ TP2 có `product_id = "ROOM-1"`, `price = 500000`; API trả:

```json
{"data":{"items":[{"id":"ROOM-1","price":600000}]}}
```

Điền đường dẫn mảng `data.items`, mã TP2 `product_id`, mã API `id`, rồi thêm cặp `price` ↔ `price`, kiểu **Số**. Kết quả là **Lệch** với hai giá trị hiển thị cạnh nhau. API là object đơn thì có thể để trống đường dẫn mảng và dùng đường dẫn đầy đủ, ví dụ `data.price`.

Đường dẫn hỗ trợ dấu chấm và chỉ số mảng như `items[0].id`. Tên event `*` áp dụng khi không có cấu hình riêng cho event đó. Cấu hình lưu trên máy ở `runs/.settings/tp2-<mode>.json`, dùng lại trong các phiên sau.

Công cụ chỉ tự ghép API cùng tab, đã có response trước event và trong khoảng thời gian cấu hình (mặc định 30 phút). Có mã định danh thì ưu tiên response mới nhất chứa đúng mã. Nhiều bản ghi chưa phân biệt được sẽ hiện **Cần chọn API**. Dữ liệu đã che, body bị cắt, API chưa hoàn tất hoặc không phải JSON sẽ yêu cầu kiểm tra thêm. Công cụ không tự đoán công thức tính tổng/thuế/khuyến mại.

## Kết thúc và chọn file xuất

- **Kết thúc:** dừng thu thập và lưu bằng chứng ngay, không tạo báo cáo, không gọi AI. Bước đang làm được giữ trạng thái REVIEW; có thể xuất sau trong phiên hiện tại.
- **Kết thúc & xuất…:** kết thúc rồi xuất nội dung đã chọn. Hoàn tất bước đang ghi trước khi dùng nút này.
- **Xuất báo cáo…:** xuất dữ liệu đang có, dùng được cả khi phiên đang chạy hoặc đã kết thúc.

Trong hộp xuất, chọn **Báo cáo đối chiếu đặc tả**, **Danh sách event tracking đã xuất hiện**, **TP2 ↔ API**, **Chi tiết API của phiên**, hoặc nhiều nội dung. Chọn định dạng HTML, Excel, JSON hoặc tất cả. Mỗi nội dung có file riêng:

| Nội dung | HTML | Excel | JSON |
| --- | --- | --- | --- |
| Event | `report.html` | `report.xlsx` | `comparison.json` |
| TP2 | `tp2-report.html` | `tp2-report.xlsx` | `tp2-report.json` |
| Danh sách tracking | `tracking-report.html` | `tracking-report.xlsx` | `tracking-report.json` |

Tab **Event trực tiếp** còn có nút **Xuất danh sách event** để chọn sẵn nội dung tracking. Danh sách này độc lập với đặc tả và luồng đang kiểm tra: một dòng cho mỗi nền tảng/tên event, số lần xuất hiện, số lần gửi, trang và thời điểm đầu/cuối. Mở chi tiết để xem từng lần và payload/bằng chứng. Push và request đã ghép chỉ tính một lần; response không tạo thêm event, bản ghi cấu hình hệ thống không tính là event nghiệp vụ.
| API | `api-report.html` | `api-report.xlsx` | `api-report.json` |

Chỉ chọn API + HTML sẽ tạo một file `api-report.html`, không dựng báo cáo event hoặc Excel. File API chứa method, URL/query, thời gian, HTTP, trang/bước và request/response headers/body đã thu thập. Excel có sheet **Chi tiết đầy đủ**, chia giá trị dài thành nhiều phần để giữ nội dung. Thông tin nhạy cảm được che; giới hạn capture hiện có vẫn áp dụng: 3.000 API/phiên, 1 triệu ký tự/body và khoảng 300 MB/phiên. Phần không lưu hoặc bị cắt có nhãn rõ ràng.

Luồng tự động có lựa chọn **Xuất báo cáo khi chạy xong**. Bỏ chọn để chỉ giữ bằng chứng; với lượt chạy nhiều luồng, báo cáo cuối được xuất nếu có ít nhất một luồng bật lựa chọn này. Bấm **Kết thúc** trong lúc chạy sẽ dừng luồng và không tự xuất. **Dừng luồng** vẫn giữ cách xử lý cũ: xuất nếu lượt chạy đang bật xuất báo cáo.

## Định dạng HTML

HTML là file độc lập, mở được khi không chạy ứng dụng và không cần mạng. Có bảng phân trang, tìm kiếm, bộ lọc kết quả, màu trạng thái, nút xem dữ liệu chi tiết và in/lưu PDF. Có thể chỉnh cỡ chữ, ngắt dòng, số dòng/trang, ẩn/hiện và thứ tự cột. Lựa chọn trong hộp xuất được nhớ cho lần xuất sau; chỉnh trong file HTML đang mở chỉ thay đổi cách xem hiện tại.

## Chạy thử an toàn trên localhost

Mở website demo của ứng dụng, tìm phần TP2, chọn **Gửi giá TP2 sai** rồi bấm **Gửi TP2 thử**. Demo đọc API sản phẩm localhost và tạo `purchase_demo`; không tạo đơn hàng ngoài hệ thống. Mở event trong tab TP2 để thấy giá **Lệch** tự động, không cần tạo mapping. Trường `quantity` trong demo không có bên API được đánh dấu **Cần kiểm tra**.

Kiểm thử tự động toàn bộ thao tác trên Chrome:

```powershell
npm.cmd run smoke:inspection
```

Các ca đã kiểm chứng dùng fixture và demo localhost. Cấu hình các trường của website thật cần được đặt theo payload TP2/API thực tế trong phiên đó.
