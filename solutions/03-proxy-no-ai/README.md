# 03 — Proxy không AI

Chạy `start.cmd`; giao diện riêng tự mở tại http://127.0.0.1:4175 (mã: [src/web/proxy.html](../../src/web/proxy.html)). Website HTTPS dùng được: CA cố định trong `profiles/mitmproxy/`, và chỉ cửa sổ test do app mở tin đúng khoá CA đó (cờ SPKI). Proxy không tự gợi ý endpoint; dùng phương án 01 để tìm endpoint rồi thêm vào đây. Cần `mitmdump.exe`, có thể nhập đường dẫn trong giao diện.

Chỉ quan sát `TRACKING_REQUEST`; JS queue không thể xác nhận nên được đánh REVIEW/LAYER_UNAVAILABLE. Dùng decoder, bằng chứng và báo cáo chung. Không replay request, không đổi proxy hệ thống, không cài CA vào Windows hay trình duyệt cá nhân.

Xem [hướng dẫn Proxy](../../docs/AI_PROXY.md).
