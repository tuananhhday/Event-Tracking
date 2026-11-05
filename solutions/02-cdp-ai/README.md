# 02 — Bản AI

Chạy `start.cmd`; giao diện tự mở tại http://127.0.0.1:4174 (mã: [src/web/cdp-ai.html](../../src/web/cdp-ai.html)). Bắt event giống hệt bản thường, thêm trợ lý AI:

- **✦ AI kiểm tra cả phiên** ở tab **✦ Trợ lý AI**: AI đọc yêu cầu của bạn, file đặc tả (ví dụ sheet R1511) và các event đã gửi lên Google/Insider, rồi chỉ ra event đúng, sai, thiếu và vấn đề (gửi lặp, ngoài đặc tả…).
- **✦ AI giải thích event này** trong chi tiết mỗi event: event là gì, có khớp file đặc tả không, cần sửa gì.
- Bước kiểm ra **Cần sửa** thì AI tự viết nguyên nhân dưới kết quả.
- Tab **✦ Trợ lý AI**: điền tên event, mô tả, dán payload mẫu từ Excel → AI đề xuất rule để bạn duyệt.

AI không đổi kết luận khớp/lệch (do công cụ tự kiểm) và rule nháp luôn cần duyệt. Bật AI: ở tab **✦ Trợ lý AI**, dán key OpenRouter rồi bấm **Bật AI** (hoặc tự sửa `.env`). Có thể mở nhanh bằng `CHAY_EVENT_QA_AI.cmd` ở thư mục gốc. Model miễn phí được thử trước, trần chi phí khoảng 0,01 USD/lần hỏi. Xem [hướng dẫn bản AI](../../docs/AI.md).
