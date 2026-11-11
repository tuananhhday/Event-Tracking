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

Trên cloud, trình duyệt test (Chrome hoặc Edge) không bật cửa sổ trên máy bạn mà chạy trong **màn hình ảo** của codespace. Sau khi bấm **Mở trình duyệt test** trong EventQA, bấm mục **Điều khiển** ở thanh bên trái (hoặc mở `link/vnc`). Một tab mới hiện trang web đang test, thao tác ở đó như thao tác trên máy: đăng nhập SSO, tìm phòng, đặt phòng… Event bắt được vẫn hiện ở tab EventQA. Kéo hai tab ra hai nửa màn hình để vừa thao tác vừa xem event.

Codespace có cả **Google Chrome** và **Microsoft Edge** (bản Linux, cùng nhân với bản Windows; website chỉ thấy hệ điều hành là Linux). Nếu Edge cài không được thì EventQA ẩn lựa chọn Edge và vẫn chạy với Chrome.

Màn hình điều khiển chạy 1920×1080 màu 24-bit và tự khớp đúng kích thước tab của bạn (không co giãn nên chữ nét). Muốn nét hơn nữa thì mở tab đó to ra (F11 toàn màn hình). Codespace có sẵn font giống Windows (Segoe UI → Open Sans, Calibri → Carlito…) để trang như đăng nhập Microsoft không bị vỡ chữ. Dòng “unsupported command-line flag: --no-sandbox” trên trình duyệt chỉ là cảnh báo, bấm X để ẩn.

## Đăng nhập được lưu ở đâu

Trên **máy ảo của GitHub Codespaces** (chạy trên Microsoft Azure, region tự chọn theo vị trí của bạn; xem hoặc đổi ở GitHub → Settings → Codespaces → Region), trong thư mục:

```
/workspaces/Event-Tracking/profiles/cdp-ai-chrome   ← Chrome
/workspaces/Event-Tracking/profiles/cdp-ai-edge     ← Edge
```

Chrome và Edge tách nhau, mỗi trình duyệt đăng nhập một lần. Cookie đăng nhập còn nguyên khi tắt phiên EventQA, khi codespace dừng rồi mở lại, và khi *Rebuild Container*. Chỉ mất khi website tự hết hạn phiên đăng nhập hoặc khi **codespace bị xóa**: tự xóa hoặc GitHub tự xóa codespace không dùng sau thời gian giữ lại (mặc định 30 ngày, chỉnh ở Settings → Codespaces → Default retention period). `profiles/` không bao giờ được đẩy lên GitHub.

Muốn xóa đăng nhập ngay: đăng xuất trên website, hoặc chạy `bash .devcontainer/eventqa.sh stop && rm -rf profiles/cdp-ai-* && bash .devcontainer/eventqa.sh start`.

Vì phiên đăng nhập nằm trên máy chủ, **ai có link và mã truy cập đều dùng được tài khoản đang đăng nhập** trong Chrome/Edge đó. Không bấm “Lưu mật khẩu” của trình duyệt; chỉ để cookie đăng nhập.

## Lệnh

| Lệnh | Việc |
|---|---|
| `bash .devcontainer/eventqa.sh info` | In lại link và mã truy cập |
| `bash .devcontainer/eventqa.sh start` | Bật lại EventQA và gateway (tự chạy mỗi khi codespace khởi động) |
| `bash .devcontainer/eventqa.sh stop` | Tắt |
| `bash .devcontainer/eventqa.sh logs` | Xem log khi có lỗi |
| `bash .devcontainer/setup.sh` | Cài lại Chrome, Edge, thư viện (sau `git pull` có thay đổi cài đặt) |

EventQA hoặc gateway mà bị dừng thì tự bật lại sau 3 giây. Bằng chứng nằm trong `runs/` của codespace, còn nguyên khi codespace dừng rồi mở lại. Codespace bị xóa thì mất `runs/`.

## Giới hạn

- **Miễn phí 120 core-giờ mỗi tháng**, khoảng **60 giờ** trên máy 2 nhân / 8 GB. Thời gian codespace chạy, kể cả lúc người khác dùng link, đều trừ vào quota của chủ codespace. Nhớ **Stop codespace** khi không dùng.
- **Không chạy 24/7**: không ai thao tác trong codespace hết thời gian chờ (tối đa 240 phút) thì codespace tự dừng và link ngừng hoạt động. Mở lại codespace thì link giữ nguyên, nhưng nên kiểm tra cổng 8080 vẫn là Public.
- GitHub có thể hiện trang cảnh báo trước khi vào link Public. Bấm *Continue*.
- **Website có thể chặn IP datacenter**: vinpearlota trả 403 trong codespace là do phía website chặn. Không lách được; test trên máy thật hoặc nhờ chủ website cho phép.
- **UAT/staging nội bộ** cần VPN công ty sẽ không truy cập được (xem mục *Mạng, IP và vị trí* bên dưới).

## Mạng, IP và vị trí

- **Giờ**: codespace chạy giờ Việt Nam (`Asia/Ho_Chi_Minh`), nên ngày giờ website tự tính và giờ trong báo cáo giống khi test trên máy.
- **IP**: trình duyệt test đi ra Internet bằng IP datacenter của GitHub (Microsoft Azure), không phải IP Việt Nam hay IP công ty. GitHub không có region Việt Nam; gần nhất là **Southeast Asia** (Singapore), chọn ở GitHub → Settings → Codespaces → Region. Website xem vị trí theo IP sẽ thấy Singapore.
- **Mạng công ty** (UAT, trang nội bộ, hệ thống chỉ cho IP công ty): codespace không tự vào được. Ba cách, theo thứ tự nên dùng:
  1. Chạy EventQA trên máy Windows nối mạng công ty (gói portable): đơn giản và đúng quy định nhất.
  2. VPN công ty bên trong codespace (OpenVPN/WireGuard…): cần IT cấp cấu hình và **cho phép** máy cloud vào mạng nội bộ. Khi đó IP ra ngoài là IP công ty.
  3. `gh net` của GitHub (bản preview): codespace đi nhờ mạng của máy bạn đang nối mạng công ty; máy bạn phải bật trong lúc dùng. Cũng cần IT đồng ý.

  Không dùng VPN/proxy miễn phí để giả IP Việt Nam cho hệ thống công ty.
- Ai có link **và** mã truy cập thì điều khiển được EventQA và Chrome (kể cả phiên đã đăng nhập SSO). Chỉ gửi mã cho người cần dùng. Đổi mã bằng cách đổi secret (hoặc xóa `~/.eventqa/access-key`) rồi chạy `eventqa.sh start`.
