# Bản portable Windows 64-bit

Tải [EventQA-Windows-x64.zip](portable/EventQA-Windows-x64.zip), chọn **Download raw file** nếu GitHub hiển thị trang xem file.

Mặc định mở **Hoạt động · JSON**: mỗi dòng là một lần phát event. Bấm **Xem JSON** để xem `event`, `default_parameters`, `custom_parameters`; có **Sao chép JSON**, **Tải JSON** và **Payload gốc**. Nhóm tham số được đọc từ dữ liệu thu thực tế, không điền bằng mẫu Excel và không phải bản đọc từ tài khoản Insider.

Nếu cửa sổ test bị kẹt, kết thúc phiên, bật **Chỉ bắt request · không gắn hook vào website** rồi mở phiên mới. Đã kiểm tra click đặt hàng trên trang thử cục bộ; cần URL và bước thao tác để xác nhận website cụ thể.

Giao diện mới có thanh điều hướng Event / Đặc tả / Kết quả / Xuất báo cáo; nút **Ẩn thiết lập** để dành toàn bộ vùng làm việc cho dữ liệu. Chọn Excel qua ô **Chọn file đặc tả**, chọn sheet rồi bấm **Nhập file**. Tùy chọn nhập đường dẫn thủ công nằm trong mục nâng cao. Cửa sổ chi tiết đặt mẫu và payload thực tế cạnh nhau, có thể đóng bằng nút **Đóng** hoặc phím Escape.

1. Giải nén **toàn bộ** ZIP vào thư mục có quyền ghi, ví dụ Documents\EventQA.
2. Mở `START_PORTABLE.cmd`; giữ cửa sổ lệnh mở khi dùng.
3. Trang chính có **3 lựa chọn: CDP không AI / CDP có AI / Proxy**. Chọn chế độ, rồi chọn Chrome hoặc Edge đã có trên máy.
4. Ở bước **Đặc tả tracking**, bấm chọn file Excel của bạn. Chọn sheet **R1511** trong danh sách rồi bấm **Nhập file**.
5. Tab **Đối chiếu đặc tả** → **Xem chi tiết đặc tả** hiển thị Event Name và Chi tiết event nguyên văn, cùng bảng từng trường mong đợi / thực tế. Sheet R1511 của file được cung cấp đã kiểm tra đọc đủ 8 event. File Excel không được đóng kèm gói tải; bạn chọn file trên máy mình.
6. Kết thúc phiên và xuất báo cáo, sau đó chạy `STOP_PORTABLE.cmd` để dừng.

Gói chứa Node.js **24.19.0 Windows x64** và thư viện theo lockfile. Không cần cài Node, chạy npm, tải package hay quyền quản trị để dùng CDP và đọc Excel. AI cần API key riêng; Proxy cần Python/mitmproxy riêng, chưa kèm trong gói. Dữ liệu phiên và báo cáo nằm trong `runs/` trên máy sử dụng.

Ứng dụng giữ riêng Event Name trong cột Excel (`listing_page_view`) và tên trong payload mẫu (`Listing Page View`). Không sửa payload thực tế để giống mẫu. Mẫu AppOTA có cấu trúc default/custom khác website thì sẽ hiện rõ chưa thấy/thiếu/lệch; không tự suy diễn thành kết quả PASS. Giá trị mẫu của thiết bị, ngày, giá tiền được kiểm kiểu/có mặt; cột **Quy tắc hiện tại** cho biết chính xác điều đang được kiểm. Muốn so giá trị động với thao tác thực tế cần duyệt rule/context.

Máy phải cho phép chạy `node.exe`, file CMD và Chrome/Edge với cổng debug. Nếu công ty chặn thực thi hoặc có chính sách chặn debug trình duyệt, cần IT phê duyệt. Không tắt bảo vệ hoặc tìm cách vượt chính sách. Website vẫn cần truy cập được qua mạng công ty.

Gói được tạo trên Linux: đã kiểm tra checksum Node từ nguồn chính thức, cấu trúc ZIP, chạy code được giải nén và smoke CDP trên Linux. **Chưa chạy thử trực tiếp trên Windows**. Kiểm tra tại máy công ty: launcher hiện phiên bản Node, giao diện mở, chạy demo và xuất báo cáo XLSX được.

SHA-256 của ZIP: `0cea1b6830a1dfe6581277297cd513497b6b7305f74505993c233d10cfb52201`.

## Tạo lại gói

Trên máy build có Node 24+, Python 3 và Git:

```sh
npm ci --ignore-scripts --no-audit --no-fund
curl -fLO https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
curl -fLO https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip
python3 scripts/build-portable.py node-v24.19.0-win-x64.zip SHASUMS256.txt portable/EventQA-Windows-x64.zip
```

Script xác minh SHA-256 của runtime, chỉ lấy source được chọn và dependencies, không lấy `.env`, profile, phiên hay dữ liệu nhập. Giữ nguyên license Node và license của các thư viện trong gói. Thư viện native cần build Windows riêng; script từ chối đóng gói nếu phát hiện file `.node`.
