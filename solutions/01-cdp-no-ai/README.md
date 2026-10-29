# 01 — CDP không AI

Chạy `start.cmd`; giao diện riêng tự mở tại http://127.0.0.1:4173 (mã: [src/web/cdp.html](../../src/web/cdp.html)). Nhập URL website thật, đăng nhập trong cửa sổ test, xem event trực tiếp, nhận gợi ý endpoint tracking và tạo rule ngay từ event thật. Có thể gắn vào tab đang mở bằng nút **Quét tab**.

Thu thập `dataLayer`, `InsiderQueue`, request/response/lỗi network từ Chrome/Edge qua raw CDP. Rule engine quyết định kết quả; lưu JSONL + SQLite và xuất XLSX/HTML/JSON/bug.

Đã thử Chrome thật trên Trip.com và website demo localhost. Xem [hướng dẫn chung](../../README.md), [CDP](../../docs/CDP.md), [trạng thái kiểm thử](../../docs/IMPLEMENTATION_STATUS.md).
