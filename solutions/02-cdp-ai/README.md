# 02 — CDP + OpenRouter

Chạy `start.cmd`; giao diện riêng tự mở tại http://127.0.0.1:4174 (mã: [src/web/cdp-ai.html](../../src/web/cdp-ai.html)). Tab **Trợ lý AI** hiển thị key, ngân sách, model & giá; bản nháp rule AI được đưa vào trình sửa rule để QC duyệt. Dùng CDP và rule engine chung của phương án 1.

Key đã được cấu hình trong `.env` của máy hiện tại. Chế độ auto thử free trước, rồi model trả phí phù hợp rẻ nhất; lỗi model thì fallback, key sai/hết credit thì thử key dự phòng trong `OPENROUTER_API_KEYS`. Tối đa 6 model, ngân sách ước tính 0,01 USD/tác vụ. Trên máy mới, copy `.env.example` thành `.env` và điền key.

Đã gọi API thật: model free dots trả lời và tạo rule nháp thành công; Mistral Nemo trả phí trả JSON hợp lệ. AI chỉ tạo bản nháp rule hoặc ghi chú cho FAIL; không thay verdict. Lỗi/quota không cản xuất báo cáo. Xem [cấu hình và giới hạn](../../docs/AI_PROXY.md).
