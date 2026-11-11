# EventQA online bằng GitHub Codespaces

Chạy EventQA (bản AI) trên máy của GitHub: miễn phí, không cần thẻ, gửi link cho người khác mở được.

```
Người dùng ──https──► https://<codespace>-8080.app.github.dev ──► gateway :8080 (mã truy cập)
                                                                   ├─► EventQA :4174
                                                                   └─► /vnc → noVNC :6080 → desktop ảo → Google Chrome
```

Chỉ cổng **8080** (gateway) được chia sẻ. EventQA, desktop ảo và cổng CDP của Chrome chỉ nghe bên trong máy.

## Lần đầu

1. *(Khuyên dùng)* GitHub → **Settings → Codespaces**:
   - **Secrets** → *New secret*, chọn repo `Event-Tracking`:
     - `EVENTQA_ACCESS_KEY`: mã truy cập cố định, ít nhất 12 ký tự. Không đặt thì mỗi codespace tự tạo mã ngẫu nhiên.
     - `OPENROUTER_API_KEY`: bật các chức năng AI.
   - **Default idle timeout**: đặt **240 phút** (mức tối đa) để codespace không tắt sớm.
2. Mở repo trên GitHub, chọn đúng nhánh → **Code → Codespaces → Create codespace**. Lần đầu mất vài phút để cài Chrome và thư viện.
3. Mở Terminal trong codespace, gõ:
   ```bash
   bash .devcontainer/eventqa.sh info
   ```
   Lệnh in ra link `https://…-8080.app.github.dev` và mã truy cập.
4. Tab **PORTS** → chuột phải cổng **8080** → **Port Visibility → Public**. Chưa làm bước này thì chỉ bạn mở được (phải đăng nhập GitHub).
5. Gửi link và mã cho người cần dùng.

## Xem và thao tác trang web đang test

Trên cloud, Chrome không bật cửa sổ trên máy bạn mà chạy trong **màn hình ảo** của codespace. Sau khi bấm **Mở trình duyệt test** trong EventQA, bấm mục **Chrome** ở thanh bên trái (hoặc mở `link/vnc`). Một tab mới hiện trang web đang test, thao tác ở đó như thao tác trên máy: đăng nhập SSO, tìm phòng, đặt phòng… Event bắt được vẫn hiện ở tab EventQA. Kéo hai tab ra hai nửa màn hình để vừa thao tác vừa xem event.

Máy codespace chỉ có Google Chrome nên lựa chọn Edge được ẩn.

## Lệnh

| Lệnh | Việc |
|---|---|
| `bash .devcontainer/eventqa.sh info` | In lại link và mã truy cập |
| `bash .devcontainer/eventqa.sh start` | Bật lại EventQA và gateway (tự chạy mỗi khi codespace khởi động) |
| `bash .devcontainer/eventqa.sh stop` | Tắt |
| `bash .devcontainer/eventqa.sh logs` | Xem log khi có lỗi |

EventQA hoặc gateway mà bị dừng thì tự bật lại sau 3 giây. Bằng chứng nằm trong `runs/` của codespace, còn nguyên khi codespace dừng rồi mở lại. Codespace bị xóa thì mất `runs/`.

## Giới hạn

- **Miễn phí 120 core-giờ mỗi tháng**, khoảng **60 giờ** trên máy 2 nhân / 8 GB. Thời gian codespace chạy, kể cả lúc người khác dùng link, đều trừ vào quota của chủ codespace. Nhớ **Stop codespace** khi không dùng.
- **Không chạy 24/7**: không ai thao tác trong codespace hết thời gian chờ (tối đa 240 phút) thì codespace tự dừng và link ngừng hoạt động. Mở lại codespace thì link giữ nguyên, nhưng nên kiểm tra cổng 8080 vẫn là Public.
- GitHub có thể hiện trang cảnh báo trước khi vào link Public. Bấm *Continue*.
- **Website có thể chặn IP datacenter**: vinpearlota trả 403 trong codespace là do phía website chặn. Không lách được; test trên máy thật hoặc nhờ chủ website cho phép.
- **UAT/staging nội bộ** cần VPN công ty sẽ không truy cập được.
- Ai có link **và** mã truy cập thì điều khiển được EventQA và Chrome (kể cả phiên đã đăng nhập SSO). Chỉ gửi mã cho người cần dùng. Đổi mã bằng cách đổi secret (hoặc xóa `~/.eventqa/access-key`) rồi chạy `eventqa.sh start`.
