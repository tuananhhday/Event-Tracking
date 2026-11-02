# 01 — Bản thường

Chạy `start.cmd`; giao diện tự mở tại http://127.0.0.1:4173 (mã: [src/web/cdp.html](../../src/web/cdp.html)). Nhập URL website thật, đăng nhập trong cửa sổ test, xem event trực tiếp, nhận gợi ý endpoint tracking và tạo rule ngay từ event thật. Có thể gắn vào tab đang mở bằng nút **Quét tab**.

Thu thập `dataLayer`, `InsiderQueue`, `Insider.eventManager.dispatch`, `insider_object` và request/response/lỗi network của GA4/Insider từ Chrome/Edge qua Chrome DevTools Protocol. Rule engine quyết định kết quả; lưu JSONL + SQLite và xuất XLSX/HTML/JSON/bug.

Đã kiểm trên vinpearlota.com (trang chủ, trang listing, chuyển trang SPA) và website demo localhost. Xem [hướng dẫn chung](../../README.md), [CDP](../../docs/CDP.md).
