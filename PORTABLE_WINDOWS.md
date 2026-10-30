# Bản portable Windows 64-bit

Tải [EventQA-Windows-x64.zip](portable/EventQA-Windows-x64.zip), chọn **Download raw file** nếu GitHub hiển thị trang xem file.

Mặc định mở **Hoạt động · JSON**, nguồn **Request gửi đi**. Chọn riêng Golf / Flight / Hotel / luồng khác; dataLayer/InsiderQueue và SDK có lựa chọn riêng. Hai request thực sự gửi lặp vẫn được giữ. `Ucd:event:beforeSend` được bóc thành event bên trong, không hiện như một business event. Bấm **Xem JSON** để xem/sao chép/tải `event`, `default_parameters`, `custom_parameters` và **Payload gốc**. Giá trị lấy từ dữ liệu thực tế; không dùng mẫu Excel điền thiếu và không phải bản đọc từ tài khoản Insider.

Nếu cửa sổ test bị kẹt, kết thúc phiên, bật **Chỉ bắt request · không gắn hook vào website** rồi mở phiên mới. Đã kiểm tra click đặt hàng trên trang thử cục bộ; chưa nghiệm thu thao tác đặt dịch vụ trên website thật.

Giao diện mới có thanh điều hướng Event / Đặc tả / Kết quả / Xuất báo cáo; nút **Ẩn thiết lập** để dành toàn bộ vùng làm việc cho dữ liệu. Chọn Excel qua ô **Chọn file đặc tả**, chọn sheet rồi bấm **Nhập file**. Tùy chọn nhập đường dẫn thủ công nằm trong mục nâng cao. Cửa sổ chi tiết đặt mẫu và payload thực tế cạnh nhau, có thể đóng bằng nút **Đóng** hoặc phím Escape.

1. Giải nén **toàn bộ** ZIP vào thư mục có quyền ghi, ví dụ Documents\EventQA.
2. Mở `START_PORTABLE.cmd`; giữ cửa sổ lệnh mở khi dùng.
3. Trang chính có **3 lựa chọn: CDP không AI / CDP có AI / Proxy**. Chọn chế độ, rồi chọn Chrome hoặc Edge đã có trên máy.
4. Nếu chọn **CDP có AI**, mở tab **Trợ lý AI**, dán API key rồi bấm **Lưu key trên máy này**. Key dùng ngay và được giữ cho lần mở sau. Bấm **Kiểm tra kết nối** để kiểm tra từ mạng của máy bạn.
5. Ở bước **Đặc tả tracking**, chọn `Martech_WebOTA_20260501.xlsx`; sheet **Tổng hợp Event tracking** được chọn tự động, rồi bấm **Nhập file**. File này có 168 event; 3 sample cần kiểm tra. AppOTA/R1511 vẫn nhập được như tài liệu tham khảo riêng. Các workbook không được đóng kèm ZIP công khai.
6. Nhập URL, mở trình duyệt test, chọn luồng và thao tác. Tab **Đối chiếu đặc tả** → **Xem chi tiết đặc tả** hiển thị yêu cầu và params thực tế. Muốn dùng AI, chọn event trong danh sách tại tab AI → **Dùng yêu cầu của event đã chọn** → xem lại → **Tạo nháp bằng AI**.
7. Kết thúc phiên và xuất báo cáo, sau đó chạy `STOP_PORTABLE.cmd` để dừng.

Gói chứa Node.js **24.19.0 Windows x64** và thư viện theo lockfile. Không cần cài Node, chạy npm, tải package hay quyền quản trị để dùng CDP và đọc Excel. AI cần mạng tới OpenRouter và API key lưu riêng trong `.env` trên máy bạn; ZIP/Git không chứa key. Mặc định lần lượt thử model free phù hợp, sau đó model trả phí rẻ nhất theo chi phí ước tính, tối đa 0,01 USD/tác vụ. Có thể bỏ tick trả phí trong tab AI. Proxy cần Python/mitmproxy riêng, chưa kèm trong gói. Dữ liệu phiên và báo cáo nằm trong `runs/` trên máy sử dụng.

Ứng dụng giữ riêng Event Name trong cột Excel (`listing_page_view`) và tên trong payload mẫu (`Listing Page View`). Không sửa payload thực tế để giống mẫu. Rule nhập từ sample và bản nháp AI phải duyệt; auto coverage không biến việc field có mặt thành xác nhận đúng giá trị động. Cột **Quy tắc hiện tại** cho biết đang kiểm gì; muốn so giá trị động với thao tác cần context và chạy theo bước.

Máy phải cho phép chạy `node.exe`, file CMD và Chrome/Edge với cổng debug. Nếu công ty chặn thực thi hoặc có chính sách chặn debug trình duyệt, cần IT phê duyệt. Không tắt bảo vệ hoặc tìm cách vượt chính sách. Website vẫn cần truy cập được qua mạng công ty.

Gói được tạo trên Linux: đã kiểm tra checksum Node từ nguồn chính thức, cấu trúc ZIP, chạy code được giải nén và smoke CDP trên Linux. **Chưa chạy thử trực tiếp trên Windows**. Kiểm tra tại máy công ty: launcher hiện phiên bản Node, giao diện mở, chạy demo và xuất báo cáo XLSX được.

SHA-256 của ZIP: `266520478d4de1fe84d8cbf44876c0922907da2bbb4e46ddba25691a771a43e1`.

Kiểm chứng source bản này: 163 test đạt, 1 bài live tùy chọn bỏ qua. Đã chạy lại workflow bằng source giải nén từ chính ZIP: nhập 168 event WebOTA, dùng đúng yêu cầu cho AI, lưu key trên máy và nạp lại khi mở, tách Golf/Flight và đọc queue mà không phát lại event. Gọi model thật trong cloud chưa kiểm chứng do proxy chặn OpenRouter; nút Kiểm tra kết nối chạy từ mạng máy sử dụng.

## Tạo lại gói

Trên máy build có Node 24+, Python 3 và Git:

```sh
npm ci --ignore-scripts --no-audit --no-fund
curl -fLO https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
curl -fLO https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip
python3 scripts/build-portable.py node-v24.19.0-win-x64.zip SHASUMS256.txt portable/EventQA-Windows-x64.zip
```

Script xác minh SHA-256 của runtime, chỉ lấy source được chọn và dependencies, không lấy `.env`, profile, phiên hay dữ liệu nhập. Giữ nguyên license Node và license của các thư viện trong gói. Thư viện native cần build Windows riêng; script từ chối đóng gói nếu phát hiện file `.node`.
